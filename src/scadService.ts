/**
 * OpenSCAD `.scad` → `.csg` conversion via a user-installed `openscad`
 * binary (OpenSCAD support, path (b)) — the only half of the
 * OpenSCAD item that shells out. Path (a) (pure `.csg` parse + kernel-side
 * build) already shipped; this module is the thin bridge from a `.scad`
 * source file to the bytes that path consumes.
 *
 * Host-side ONLY (uses `node:child_process`/`node:fs`/`node:os`/`node:path`;
 * vscode-free and WASM-free, so it unit-tests headless), and deliberately
 * NOT in the kernel worker: `.scad` `use`/`include`/`import` resolve
 * relative to the source file's location, but the worker only ever receives
 * marshalled bytes — converting there would silently break every multi-file
 * model. Converting here, on the real path with `cwd = dirname(sourcePath)`,
 * keeps relative includes working, keeps the worker WASM-only (the
 * architecture invariant), and means everything downstream only ever sees
 * `format: "csg"` — no `BRepFormat` widening anywhere.
 *
 * Failure semantics (two crisp rules, mirroring `renderService.ts`):
 * - binary absent → `ScadUnavailableError` (callers map to
 *   `{supported: false, warnings: [reason]}`, never throw for a missing
 *   capability — the `supported:false` = need-more-info verdict convention).
 * - binary present but conversion fails → thrown plain `Error` with an
 *   actionable message (a broken file is a hard error, same as
 *   `STEP ReadFile failed`).
 *
 * Security: `execFile` with an argv array, never a shell — no command
 * injection surface. The binary runs with the user's own privileges (same as
 * invoking openscad by hand); a `.scad` file is effectively evaluated code
 * (recursion/`import` can hang), so {@link SCAD_CONVERT_TIMEOUT_MS} is the
 * backstop, not just UX — on timeout the child is killed and a clear error
 * is thrown.
 *
 * Live-binary verification (2026-09-07, OpenSCAD 2021.01): `openscad -o
 * <tmp>/model.csg <abs path>` with `cwd` = the source directory converts
 * `examples/OpenSCAD/minimal.scad` (exit 0, empty stderr) to the `bracket.csg`
 * vocabulary — openscad normalizes the hole to
 * `cylinder($fn = 10, $fa = 12, $fs = 2, h = 12, r1 = 3, r2 = 3, ...)`
 * (handled by `csgModel.ts`'s r1/r2 branch) — and the MCP pipeline reports
 * 2 solids / 30 faces / volume 5228.884 vs the 5228.88 analytic oracle.
 * That same run caught a real defect the stubs could never see: argv carried
 * the raw (possibly relative) caller path while `cwd` was already the source
 * dir, so a relative call resolved to `<dir>/<relpath>` and openscad failed
 * with "Can't open input file" — the input is now `path.resolve`d before
 * spawning (regression-tested). `--version` probes exit 0 on the real binary.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CadFormat } from "./fileRouter";
import { formatScadValue, isValidScadName, type ScadValue } from "./scadParams";

const execFileAsync = promisify(execFileCb);

/** Env override for headless use (the MCP server has no vscode settings to
 * read) — explicit param wins, then this, then {@link DEFAULT_OPENSCAD_BINARY}. */
export const OPENSCAD_BINARY_ENV = "OPENSCAD_BINARY";
/** Binary name resolved via PATH when nothing else is configured. */
export const DEFAULT_OPENSCAD_BINARY = "openscad";
/** Env override for the geometry backend (headless twin of
 * `cadPreview.openscadBackend`): `cgal` or `manifold`. Anything else is unset. */
export const OPENSCAD_BACKEND_ENV = "OPENSCAD_BACKEND";
/** OpenSCAD's own library search-path variable. openscad reads it natively, so
 * an inherited value already works; configured paths are PREPENDED to it. */
export const OPENSCAD_LIBRARY_ENV = "OPENSCADPATH";
/** Geometry engines OpenSCAD can evaluate with. `manifold` (much faster on
 * large booleans) needs a 2025+ snapshot; `cgal` is the long-standing default. */
export type ScadBackend = "cgal" | "manifold";
/**
 * Conversion backstop (2 min): `.scad` evaluation is unbounded in general
 * (CGAL on a hostile model, `import` of a huge mesh), so an unbounded wait
 * would hang the tool call the way the pre-watchdog Gmsh hang did. Fixed
 * constant rather than a setting — unlike the binary path there is no
 * per-user "right" value to configure, only a hang-vs-patience tradeoff;
 * revisit if real-world conversions legitimately exceed it.
 */
export const SCAD_CONVERT_TIMEOUT_MS = 120_000;
/** Probe budget for `openscad --version` — a version print is instant; a
 * slow spawn here means something is already wrong. */
const SCAD_PROBE_TIMEOUT_MS = 10_000;
/** Cap on surfaced openscad stderr lines — conversion chatter must not flood
 * a tool response. */
const MAX_STDERR_LINES = 5;
/** Cap on the failure-message stderr excerpt. */
const MAX_STDERR_EXCERPT = 2048;

/** Thrown (and ONLY thrown) when no usable binary exists — even at convert
 * time (TOCTOU: the probe passed but the binary vanished). Callers map this
 * to `{supported: false}`, never let it propagate as a hard error. */
export class ScadUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "ScadUnavailableError";
    this.reason = reason;
  }
}

/** Binary resolution order: explicit (the `cadPreview.openscadBinary`
 * setting, threaded by the caller) → env (headless escape hatch) → PATH
 * lookup of the default name. Empty strings count as unset at every level. */
export function resolveOpenscadBinary(explicit?: string): string {
  if (explicit && explicit.trim() !== "") return explicit;
  const env = process.env[OPENSCAD_BINARY_ENV];
  if (env && env.trim() !== "") return env;
  return DEFAULT_OPENSCAD_BINARY;
}

/**
 * Backend resolution: explicit (the `cadPreview.openscadBackend` setting) →
 * env → unset. `"auto"`, empty and unrecognised values all mean unset, which
 * passes NO flag — so a stock OpenSCAD that predates `--backend` keeps working
 * untouched until a user opts in.
 */
export function resolveScadBackend(explicit?: string): ScadBackend | undefined {
  for (const raw of [explicit, process.env[OPENSCAD_BACKEND_ENV]]) {
    const v = raw?.trim().toLowerCase();
    if (v === "cgal" || v === "manifold") return v;
    if (v === "auto") return undefined;
  }
  return undefined;
}

/**
 * Child environment with `libraryPaths` prepended to any inherited
 * `OPENSCADPATH` (the platform path delimiter), so BOSL2 and friends kept in a
 * shared folder resolve for `use <BOSL2/std.scad>`. Blank entries are dropped;
 * with no paths the environment is returned unchanged.
 */
export function scadChildEnv(libraryPaths?: readonly string[], base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const extra = (libraryPaths ?? []).map((p) => p.trim()).filter((p) => p !== "");
  if (extra.length === 0) return base;
  const inherited = base[OPENSCAD_LIBRARY_ENV];
  return { ...base, [OPENSCAD_LIBRARY_ENV]: [...extra, ...(inherited && inherited.trim() !== "" ? [inherited] : [])].join(path.delimiter) };
}

/** The argv for a conversion. Order matters only for readability: flags, `-D`s, then `-o <out> <in>`. */
export function scadArgs(outPath: string, absSource: string, opts: { backend?: ScadBackend; defines?: Record<string, ScadValue> } = {}): string[] {
  const args: string[] = [];
  if (opts.backend) args.push(`--backend=${opts.backend}`);
  for (const [name, value] of Object.entries(opts.defines ?? {})) {
    // Names are validated here too (not only in scadParams) because this is the
    // one place a caller-supplied string becomes argv.
    if (!isValidScadName(name)) throw new Error(`Invalid OpenSCAD variable name for -D: "${name}"`);
    args.push("-D", `${name}=${formatScadValue(value)}`);
  }
  args.push("-o", outPath, absSource);
  return args;
}

function isMissingBinary(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Cheap availability probe — mirrors `isRenderAvailable` (never throws;
 * `{available: false}` + install hint instead). NOT called by
 * `describe_capabilities` (instant/pure); each `.scad` tool path calls this
 * itself (or trips over `ScadUnavailableError` at convert time).
 */
export async function isOpenscadAvailable(binary?: string): Promise<{ available: boolean; reason?: string }> {
  const resolved = resolveOpenscadBinary(binary);
  try {
    await execFileAsync(resolved, ["--version"], { timeout: SCAD_PROBE_TIMEOUT_MS });
    return { available: true };
  } catch (err) {
    if (isMissingBinary(err)) {
      return {
        available: false,
        reason:
          `OpenSCAD binary "${resolved}" not found — .scad import needs a user-installed openscad ` +
          `(FreeCAD's architecture: convert, then parse). Install it, point cadPreview.openscadBinary at it, ` +
          `or set ${OPENSCAD_BINARY_ENV}.`,
      };
    }
    return { available: false, reason: `OpenSCAD probe failed (${(err as Error).message})` };
  }
}

export interface ScadConvertOptions {
  /** Explicit binary (the setting); unset → env → default. */
  binary?: string;
  /** Override for tests (stub `slow.sh`); production uses {@link SCAD_CONVERT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** `cadPreview.openscadBackend`; unset/`auto` passes no flag, falling back to {@link OPENSCAD_BACKEND_ENV}. */
  backend?: string;
  /** `cadPreview.openscadLibraryPaths`; prepended to `OPENSCADPATH` for the child only. */
  libraryPaths?: string[];
  /** Customizer overrides, each passed as `-D name=value` (validate with `validateScadOverrides` first). */
  defines?: Record<string, ScadValue>;
}

export interface ScadConvertResult {
  /** Converted `.csg` file bytes, ready to feed the shipped `.csg` pipeline as `format: "csg"`. */
  csgBytes: Uint8Array;
  /** openscad's own stderr chatter (capped) — never silent, never flooding. */
  warnings: string[];
}

/**
 * Runs `openscad -o <tmp>/model.csg <sourcePath>` with `cwd` = the source
 * directory (so relative `use`/`include`/`import` resolve exactly as a manual
 * invocation would), reads the output back, and removes the temp dir in a
 * `finally`. Input is the REAL path, never a temp copy — copying would break
 * those relative references with no error to catch it.
 */
export async function convertScadToCsg(sourcePath: string, opts: ScadConvertOptions = {}): Promise<ScadConvertResult> {
  const binary = resolveOpenscadBinary(opts.binary);
  const timeoutMs = opts.timeoutMs ?? SCAD_CONVERT_TIMEOUT_MS;
  const backend = resolveScadBackend(opts.backend);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cad-preview-scad-"));
  // The output name MUST end in `.csg` — openscad selects its exporter from
  // the `-o` extension.
  const outPath = path.join(tmpDir, "model.csg");
  // The input MUST be absolute: `cwd` below is the source directory (so
  // relative `use`/`include`/`import` resolve as a manual invocation would),
  // and a relative argv path would then resolve against that dir instead of
  // the caller's cwd — i.e. `<dir>/examples/OpenSCAD/minimal.scad` instead of
  // the real file (caught by a live-binary run; the stub never checks input
  // existence, so no unit test could see it).
  const absSource = path.resolve(sourcePath);
  try {
    let stderr = "";
    try {
      const res = await execFileAsync(binary, scadArgs(outPath, absSource, { backend, defines: opts.defines }), {
        cwd: path.dirname(absSource),
        env: scadChildEnv(opts.libraryPaths),
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      stderr = res.stderr ?? "";
    } catch (err) {
      if (isMissingBinary(err)) {
        throw new ScadUnavailableError(
          `OpenSCAD binary "${binary}" not found — .scad import needs a user-installed openscad. ` +
            `Install it, point cadPreview.openscadBinary at it, or set ${OPENSCAD_BINARY_ENV}.`
        );
      }
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; signal?: string; killed?: boolean };
      if (e.code === "ETIMEDOUT" || e.killed || e.signal === "SIGTERM") {
        throw new Error(
          `OpenSCAD conversion timed out after ${Math.round(timeoutMs / 1000)}s (child killed) — ` +
            `the model may be too complex, import too large a mesh, or loop; simplify and retry.`
        );
      }
      const excerpt = String(e.stderr ?? (err as Error).message ?? err).slice(-MAX_STDERR_EXCERPT);
      // A stock build that predates the backend switch rejects the flag by
      // name; say so rather than leaving the user to decode a getopt message.
      const backendHint =
        backend && /backend|unrecogni[sz]ed option|unknown option/i.test(excerpt)
          ? ` — this OpenSCAD build may not support --backend=${backend} (needs a 2025+ snapshot); set cadPreview.openscadBackend to "auto" to omit it.`
          : "";
      throw new Error(`openscad failed on ${path.basename(sourcePath)} (exit ${e.code ?? "?"}): ${excerpt}${backendHint}`);
    }
    const warnings = stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .slice(0, MAX_STDERR_LINES)
      .map((l) => `openscad: ${l}`);
    let csgBytes: Uint8Array;
    try {
      csgBytes = new Uint8Array(await fs.readFile(outPath));
    } catch {
      throw new Error(`openscad exited 0 but wrote no .csg output for ${path.basename(sourcePath)} — treating as a failed conversion.`);
    }
    if (csgBytes.length === 0) {
      throw new Error(`openscad wrote an empty .csg for ${path.basename(sourcePath)} — treating as a failed conversion.`);
    }
    return { csgBytes, warnings };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export interface EffectiveSourceOptions {
  binary?: string;
  timeoutMs?: number;
  backend?: string;
  libraryPaths?: string[];
}

/**
 * The single choke every `.scad`-capable call site uses (2 lines each):
 * non-scad formats read straight through untouched; `.scad` converts first
 * and comes back as `{bytes: csgBytes, format: "csg"}` so ALL downstream
 * code (typed against the step/iges/brep/csg world) works with zero
 * widening. `readBytes` is caller-supplied because headless (`node:fs`) and
 * interactive (`vscode.workspace.fs`) read through different APIs.
 *
 * `ScadUnavailableError` propagates for callers to map to
 * `{supported: false}`; every other failure is already a clear thrown Error.
 */
export async function resolveEffectiveSource(opts: {
  modelPath: string;
  format: CadFormat;
  readBytes: () => Promise<Uint8Array>;
  warnings: string[];
  binary?: string;
  timeoutMs?: number;
  backend?: string;
  libraryPaths?: string[];
}): Promise<{ bytes: Uint8Array; format: CadFormat }> {
  if (opts.format !== "scad") {
    return { bytes: await opts.readBytes(), format: opts.format };
  }
  const { csgBytes, warnings } = await convertScadToCsg(opts.modelPath, {
    binary: opts.binary,
    timeoutMs: opts.timeoutMs,
    backend: opts.backend,
    libraryPaths: opts.libraryPaths,
  });
  opts.warnings.push(...warnings);
  return { bytes: csgBytes, format: "csg" };
}
