/**
 * OpenSCAD evaluation through `@loumalouomega/openscad-wasm` (roadmap
 * "Build and bundle an OpenSCAD WASM port", Phase 1) — the worker-side half.
 *
 * Host-side ONLY in the sense that it runs in the kernel worker (Node, no
 * vscode), reached through the standard four-touch-point `Pipeline` pattern
 * (`mcpTools.ts` interface, `kernelWorker.ts` dispatch, `kernelActivity.ts`
 * classification, `mcpTools.test.ts` fake). It mirrors `scadService.ts`'s
 * binary path shape (`ScadConvertResult`-like return) so the host can prefer
 * WASM and fall back to the user-installed binary when the WASM path cannot
 * handle a construct.
 *
 * Why worker-side, not host-side: `.scad` `use`/`include`/`import` resolve
 * relative to the source file, and the worker (a forked Node process on the
 * same machine) can read those files itself — same as the binary path's
 * `cwd = dirname(source)` trick. The host only passes an absolute model path
 * plus already-validated options; all file I/O and MEMFS staging happens here.
 *
 * Loading follows the `mmgService.ts` recipe, not `meshioService.ts`'s: the
 * package is dual ESM/CJS (`dist/openscad.cjs` for `require`), so a plain
 * `createRequire` + `resolveRuntimePackage` keeps it external (see
 * `WASM_EXTERNALS`) and avoids bundling. The `.wasm` is read explicitly from
 * `dist/openscad-core.wasm` (copied by `esbuild.mjs`, like `gmsh-core.wasm`)
 * and passed as `wasmBinary` — the wrapper's `instantiateWasm` path — so the
 * build never relies on the package's self-locating `import.meta.url` (which
 * esbuild's CJS shim rewrites).
 *
 * Instances are single-use per render: `render()` instantiates fresh per call
 * (~50-60 ms after the first, measured against the live package), so there is
 * no shared Emscripten instance to corrupt — but a WASM abort still resets the
 * cached module/bytes (`resetScadWasm`) the way every other kernel does.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { resolveRuntimePackage } from "./runtimePackage";
import { parseScadStderr, scadWarningLines, resolveScadBackend, type ScadDiagnostic } from "./scadService";
import type { ScadValue } from "./scadParams";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScadWasmApi = any;

let _apiPromise: Promise<ScadWasmApi> | null = null;
let _wasmBinary: Uint8Array | null = null;

/**
 * Lazy CJS external, with an explicitly staged, replaceable WASM binary.
 * The `require` resolves via `node_modules` in dev and in the packaged VSIX
 * (`.vscodeignore` carve-outs); the fallback covers a staged `dist/openscad`
 * tree if one is ever added (see `runtimePackage.ts`).
 */
function getScadWasmApi(): Promise<ScadWasmApi> {
  if (!_apiPromise) {
    _apiPromise = (async () => {
      const req = createRequire(import.meta.url)(
        resolveRuntimePackage("@loumalouomega/openscad-wasm", "openscad", "dist/openscad.cjs")
      ) as ScadWasmApi;
      return req;
    })().catch((err) => {
      _apiPromise = null;
      throw err;
    });
  }
  return _apiPromise;
}

function getScadWasmBinary(extensionPath: string): Uint8Array {
  if (!_wasmBinary) {
    _wasmBinary = new Uint8Array(fs.readFileSync(path.join(extensionPath, "dist", "openscad-core.wasm")));
  }
  return _wasmBinary;
}

/** Resets the cached module + bytes — called by `wrapScadWasmFault` after an abort, and from tests. */
export function resetScadWasm(): void {
  _apiPromise = null;
  _wasmBinary = null;
}

/**
 * Emscripten aborts surface as opaque `RuntimeError`s plus bare-digit C++
 * exception pointers — the same fifth-signal vocabulary every other kernel
 * carries (see `occtService.ts`'s `isOcctWasmAbort`), kept as its own local
 * copy here per that convention. Mirrors the package's own
 * `isOpenScadWasmAbort` so the worker does not depend on the package to
 * classify its own failure.
 */
function isScadWasmAbort(message: string): boolean {
  return (
    /out of bounds|abort|RuntimeError|unreachable|null function|table index|function table|funcref table|wasmtable|signature mismatch/i.test(
      message
    ) || /^\d+$/.test(message.trim())
  );
}

/**
 * Every WASM-touching entry point wraps its `catch` with this. An aborted
 * instance is discarded (`resetScadWasm()`) to force a fresh module on the
 * next attempt; a non-abort error passes through unchanged.
 */
export function wrapScadWasmFault(err: unknown): Error {
  const raw = ((err as Error)?.message ?? String(err)).trim();
  if (!isScadWasmAbort(raw)) return err instanceof Error ? err : new Error(raw);
  if (process.env.CAD_PREVIEW_KERNEL_TRACE) console.error(`[scadwasm-abort] ${err instanceof Error ? err.stack : String(err)}`);
  resetScadWasm();
  return new Error(`OpenSCAD WASM crashed (${raw || "WASM abort"}) — the kernel has been reset; try the operation again.`);
}

/** Thrown when the WASM path declines a model so the host falls back to the binary (missing file, mesh import, too many files). Not a conversion failure. */
export class ScadWasmFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScadWasmFallbackError";
  }
}

export interface ScadWasmConvertOptions {
  backend?: string;
  defines?: Record<string, ScadValue>;
  libraryPaths?: string[];
}

export interface ScadWasmConvertResult {
  csgBytes: Uint8Array;
  warnings: string[];
  diagnostics: ScadDiagnostic[];
  droppedCount: number;
  dependencies: string[];
}

const MAX_WASM_FILES = 20;
const MAX_WASM_TOTAL_BYTES = 1024 * 1024;
const LOCALIZATION_NOISE = "Could not initialize localization";

function normalizeMemfsKey(rel: string): string {
  return rel.split(path.sep).join("/");
}

/**
 * Worker-side `.scad` → `.csg` conversion (see module doc comment). Reads the
 * source and every `use`/`include` it names, stages them into MEMFS
 * (`libraries` for `<angle-bracket>` targets via OPENSCADPATH, `extraFiles`
 * for `"quoted"` targets relative to the source dir), renders with
 * `--backend=manifold` by default, and returns the same shape the binary path
 * does so the host cache/watchers work unchanged.
 *
 * Declines (throws `ScadWasmFallbackError`) when the model needs something
 * this path does not stage: a missing include, an `import()`/`surface()` of a
 * local mesh/data file, a quoted include outside the source dir, or more than
 * the file/count caps. The host then runs the user-installed binary instead.
 */
export async function convertScadViaWasm(
  extensionPath: string,
  modelPath: string,
  opts: ScadWasmConvertOptions = {}
): Promise<ScadWasmConvertResult> {
  const absSource = path.resolve(modelPath);
  const sourceDir = path.dirname(absSource);
  let sourceText: string;
  try {
    sourceText = await fsp.readFile(absSource, "utf8");
  } catch (err) {
    throw new Error(`OpenSCAD WASM: cannot read ${path.basename(modelPath)} (${(err as Error).message})`);
  }

  const backend = resolveScadBackend(opts.backend) ?? "manifold";
  if (backend !== "cgal" && backend !== "manifold") {
    throw new ScadWasmFallbackError(`OpenSCAD WASM: unsupported backend "${opts.backend}"`);
  }
  const libraryPaths = (opts.libraryPaths ?? []).map((p) => p.trim()).filter((p) => p !== "");
  const defines = opts.defines ?? {};

  // A mesh/data import is a binary-stage construct the CSG path does not
  // evaluate here (the binary path keeps the `import()` node for `csgImport`
  // to resolve later). Decline so the binary handles it.
  if (/\bimport\s*\(\s*"/.test(sourceText) || /\bsurface\s*\(/.test(sourceText)) {
    throw new ScadWasmFallbackError("OpenSCAD WASM: import()/surface() falls back to the binary path");
  }

  const libraries: Record<string, string> = {};
  const extraFiles: Record<string, string> = {};
  const dependencies: string[] = [];
  const seen = new Set<string>([absSource]);
  let totalBytes = Buffer.byteLength(sourceText, "utf8");

  const readText = async (abs: string): Promise<string> => {
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new ScadWasmFallbackError(`OpenSCAD WASM: not a file: ${abs}`);
    if (st.size + totalBytes > MAX_WASM_TOTAL_BYTES) {
      throw new ScadWasmFallbackError("OpenSCAD WASM: includes exceed the 1 MB staging cap");
    }
    const text = await fsp.readFile(abs, "utf8");
    totalBytes += Buffer.byteLength(text, "utf8");
    return text;
  };

  const resolveAngle = async (target: string, fromDir: string): Promise<string | null> => {
    const candidates = [path.resolve(fromDir, target), ...libraryPaths.map((lp) => path.resolve(lp, target))];
    for (const c of candidates) {
      try {
        const st = await fsp.stat(c);
        if (st.isFile()) return c;
      } catch {
        // try next
      }
    }
    return null;
  };

  // Breadth-first over the include graph (source + every staged library).
  // Any file needing a mesh/data import declines the whole conversion — the
  // binary keeps the `import()` node for `csgImport` to resolve later.
  const queue: Array<{ abs: string; text: string; dir: string }> = [{ abs: absSource, text: sourceText, dir: sourceDir }];
  const angleRe = /^\s*(?:include|use)\s*<([^>]+)>/gm;
  const quotedRe = /^\s*(?:include|use)\s*"([^"]+)"/gm;
  const meshImportRe = /\bimport\s*\(\s*"/;

  while (queue.length > 0) {
    if (seen.size > MAX_WASM_FILES + 1) {
      throw new ScadWasmFallbackError(`OpenSCAD WASM: more than ${MAX_WASM_FILES} include files`);
    }
    const cur = queue.shift()!;
    if (meshImportRe.test(cur.text) || /\bsurface\s*\(/.test(cur.text)) {
      throw new ScadWasmFallbackError(`OpenSCAD WASM: import()/surface() in ${path.basename(cur.abs)} falls back to the binary path`);
    }
    angleRe.lastIndex = 0;
    quotedRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = angleRe.exec(cur.text)) !== null) {
      const target = m[1].trim();
      if (!target) continue;
      const key = normalizeMemfsKey(target);
      if (libraries[key] !== undefined) continue;
      const found = await resolveAngle(target, cur.dir);
      if (!found) {
        throw new ScadWasmFallbackError(`OpenSCAD WASM: cannot resolve <${target}> (binary path handles it)`);
      }
      if (seen.has(found)) continue;
      seen.add(found);
      const text = await readText(found);
      libraries[key] = text;
      dependencies.push(found);
      queue.push({ abs: found, text, dir: path.dirname(found) });
    }
    while ((m = quotedRe.exec(cur.text)) !== null) {
      const target = m[1].trim();
      if (!target) continue;
      const abs = path.resolve(cur.dir, target);
      const rel = normalizeMemfsKey(path.relative(sourceDir, abs));
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new ScadWasmFallbackError(`OpenSCAD WASM: quoted include outside the source dir: "${target}"`);
      }
      if (extraFiles[rel] !== undefined) continue;
      let text: string;
      try {
        text = await readText(abs);
      } catch {
        throw new ScadWasmFallbackError(`OpenSCAD WASM: cannot read "${target}" (binary path handles it)`);
      }
      seen.add(abs);
      extraFiles[rel] = text;
      dependencies.push(abs);
      queue.push({ abs, text, dir: path.dirname(abs) });
    }
  }

  let api: ScadWasmApi;
  try {
    api = await getScadWasmApi();
  } catch (err) {
    throw new ScadWasmFallbackError(`OpenSCAD WASM unavailable (${(err as Error).message}) — binary path handles it`);
  }
  let wasmBinary: Uint8Array;
  try {
    wasmBinary = getScadWasmBinary(extensionPath);
  } catch (err) {
    throw new ScadWasmFallbackError(`OpenSCAD WASM binary missing (${(err as Error).message}) — binary path handles it`);
  }

  let output: string;
  let stderr: string[];
  try {
    const result = await api.render(sourceText, {
      format: "csg",
      backend,
      defines,
      extraFiles,
      libraries,
      wasmBinary,
    });
    output = String(result.output ?? "");
    stderr = Array.isArray(result.stderr) ? result.stderr.map(String) : [];
  } catch (err) {
    const raw = ((err as Error)?.message ?? String(err)).trim();
    const errStderr = Array.isArray((err as { stderr?: unknown }).stderr)
      ? ((err as { stderr: unknown[] }).stderr.map(String).join("\n"))
      : "";
    // A missing staged file is a staging gap, not a model error — the binary
    // (with real cwd + OPENSCADPATH) handles it.
    if (/can't open|not found|no such file|missing/i.test(raw + "\n" + errStderr)) {
      throw new ScadWasmFallbackError(`OpenSCAD WASM cannot resolve an include (${raw.slice(0, 160)}) — binary path handles it`);
    }
    // Any other render failure (syntax error, stack overflow, empty geometry)
    // is a genuine conversion failure — surfacing it beats a 120 s binary
    // retry that would fail the same way. Reset the cached module on aborts.
    throw wrapScadWasmFault(err);
  }

  if (!output) {
    throw new Error("OpenSCAD WASM produced no output (empty or invalid geometry?) — treating as a failed conversion.");
  }

  const filtered = stderr.filter((line) => !line.includes(LOCALIZATION_NOISE));
  const { diagnostics, droppedCount } = parseScadStderr(filtered.join("\n"));
  const warnings = scadWarningLines(diagnostics, droppedCount);
  return {
    csgBytes: new TextEncoder().encode(output),
    warnings,
    diagnostics,
    droppedCount,
    dependencies,
  };
}
