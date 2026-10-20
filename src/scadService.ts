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
import { sha256Hex } from "./hash";
import { envelope } from "./untrustedText";

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
/** Longest single diagnostic message kept — a pathological `echo()` must not flood a response. */
const MAX_DIAGNOSTIC_LENGTH = 400;
/** Cap on the failure-message stderr excerpt. */
const MAX_STDERR_EXCERPT = 2048;

export type ScadDiagnosticSeverity = "echo" | "warning" | "deprecated" | "error";

/**
 * One parsed line of openscad's stderr. `message` is document-derived text
 * (an `echo()` is written by whoever wrote the `.scad`), so it is carried RAW
 * here — structured fields hold document text unwrapped by convention — and
 * enveloped when rendered into prose by {@link scadDiagnosticLine}.
 */
export interface ScadDiagnostic {
  severity: ScadDiagnosticSeverity;
  message: string;
  file?: string;
  line?: number;
}

/** Out-param for callers that want the structured form beside the `warnings` strings. */
export interface ScadDiagnosticCollector {
  diagnostics: ScadDiagnostic[];
  droppedCount: number;
}

const SEVERITY_RANK: Record<ScadDiagnosticSeverity, number> = { error: 0, warning: 1, deprecated: 2, echo: 3 };

/** Parses ONE stderr line; blank → undefined. */
function parseScadLine(raw: string): ScadDiagnostic | undefined {
  let text = raw.trim();
  if (text === "") return undefined;
  let severity: ScadDiagnosticSeverity = "warning";
  const m = /^(ECHO|WARNING|DEPRECATED|ERROR):\s*/i.exec(text);
  if (m) {
    severity = m[1].toLowerCase() as ScadDiagnosticSeverity;
    text = text.slice(m[0].length);
  }
  // openscad appends ` in file X, line N` to many messages.
  let file: string | undefined;
  let line: number | undefined;
  const loc = /\s+in file (.+?), line (\d+)\s*$/.exec(text);
  if (loc) {
    file = loc[1];
    line = Number(loc[2]);
    text = text.slice(0, loc.index);
  }
  const message = text.length > MAX_DIAGNOSTIC_LENGTH ? text.slice(0, MAX_DIAGNOSTIC_LENGTH) : text;
  return { severity, message, ...(file !== undefined ? { file, line } : {}) };
}

/**
 * Splits openscad's stderr into structured diagnostics and applies the cap
 * BY SEVERITY: errors first, then warnings, deprecations, then echoes (stable
 * within a class), so five `echo()` lines can never push a real `WARNING:`
 * out. Survivors keep file order; whatever did not fit is counted, never
 * silently cut.
 */
export function parseScadStderr(stderr: string, cap: number = MAX_STDERR_LINES): { diagnostics: ScadDiagnostic[]; droppedCount: number } {
  const all = stderr.split(/\r?\n/).map(parseScadLine).filter((d): d is ScadDiagnostic => d !== undefined);
  if (all.length <= cap) return { diagnostics: all, droppedCount: 0 };
  const keep = new Set(
    all
      .map((d, i) => ({ i, r: SEVERITY_RANK[d.severity] }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .slice(0, Math.max(0, cap))
      .map((x) => x.i)
  );
  return { diagnostics: all.filter((_, i) => keep.has(i)), droppedCount: all.length - keep.size };
}

/** Prose rendering of a diagnostic: the document-derived message is enveloped. */
export function scadDiagnosticLine(d: ScadDiagnostic): string {
  const where = d.file !== undefined ? ` (${d.file}:${d.line})` : "";
  return `openscad ${d.severity}: ${envelope(d.message, "openscad", MAX_DIAGNOSTIC_LENGTH)}${where}`;
}

/** The `warnings` strings for a parsed stderr: one line per diagnostic plus a dropped-count line. */
export function scadWarningLines(diagnostics: readonly ScadDiagnostic[], droppedCount: number): string[] {
  const lines = diagnostics.map(scadDiagnosticLine);
  if (droppedCount > 0) lines.push(`openscad: ${droppedCount} more diagnostic(s) not shown (lower-severity lines are dropped first)`);
  return lines;
}

/** `.csg` importer notes (skipped nodes, tokenizer complaints) as diagnostics, so one list covers both stages. */
export function csgWarningDiagnostic(message: string): ScadDiagnostic {
  return { severity: "warning", message };
}

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

/** A conversion that ran (or tried to) and failed — distinct from
 * {@link ScadUnavailableError}, which means there was nothing to run. `kind`
 * lets the MCP layer code the failure (`source-timeout` vs
 * `source-conversion-failed`) without matching message text. The message is
 * unchanged from before this class existed. */
export class ScadConvertError extends Error {
  constructor(message: string, readonly kind: "timeout" | "failed") {
    super(message);
    this.name = "ScadConvertError";
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

/**
 * The argv for a conversion: flags, `-D`s, then `-o <out> <in>`, then — only
 * when a `depfile` is wanted — `-d <depfile>` LAST. It trails the stock
 * invocation so every argv prefix existing stubs and tests pin is unchanged;
 * verified against OpenSCAD 2021.01 that `-d` is accepted after the
 * positional input.
 */
export function scadArgs(
  outPath: string,
  absSource: string,
  opts: { backend?: ScadBackend; defines?: Record<string, ScadValue>; depfile?: string } = {}
): string[] {
  const args: string[] = [];
  if (opts.backend) args.push(`--backend=${opts.backend}`);
  for (const [name, value] of Object.entries(opts.defines ?? {})) {
    // Names are validated here too (not only in scadParams) because this is the
    // one place a caller-supplied string becomes argv.
    if (!isValidScadName(name)) throw new Error(`Invalid OpenSCAD variable name for -D: "${name}"`);
    args.push("-D", `${name}=${formatScadValue(value)}`);
  }
  args.push("-o", outPath, absSource);
  if (opts.depfile) args.push("-d", opts.depfile);
  return args;
}

/**
 * Parses the Make-style dependency file `openscad -d` writes into absolute
 * dependency paths (the source itself and `exclude`d paths removed, order kept,
 * duplicates dropped).
 *
 * Format, captured from OpenSCAD 2021.01 (not assumed): one rule
 * `<output>: \` followed by tab-indented, backslash-continued paths, the
 * source LAST; spaces inside a path are `\ `-escaped; used libraries,
 * includes and `import()`ed files are all listed, and a missing `import()`
 * target is listed too while a missing `include`/`use` is not (it only warns).
 * Parsed defensively beyond what the binary emits — multiple rules, `$$`,
 * `\#`, CRLF, and a Windows `C:\` drive colon (a target ends at a colon
 * followed by whitespace or the end of the rule, never at a drive letter's).
 */
export function parseMakeDepfile(text: string, opts: { cwd: string; exclude?: readonly string[] }): string[] {
  const exclude = new Set((opts.exclude ?? []).map((p) => path.resolve(opts.cwd, p)));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rule of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    if (rule.trim() === "") continue;
    const m = /(?<!\\):(?=\s|$)/.exec(rule);
    if (!m) continue;
    const deps = rule.slice(m.index + 1);
    let cur = "";
    const flush = (): void => {
      if (cur === "") return;
      const abs = path.resolve(opts.cwd, cur);
      cur = "";
      if (exclude.has(abs) || seen.has(abs)) return;
      seen.add(abs);
      out.push(abs);
    };
    for (let i = 0; i < deps.length; i++) {
      const c = deps[i];
      if (c === "\\" && i + 1 < deps.length && (deps[i + 1] === " " || deps[i + 1] === "#")) {
        cur += deps[++i];
      } else if (c === "$" && deps[i + 1] === "$") {
        cur += "$";
        i++;
      } else if (/\s/.test(c)) {
        flush();
      } else {
        cur += c;
      }
    }
    flush();
  }
  return out;
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
  /**
   * WASM-first conversion (roadmap "Build and bundle an OpenSCAD WASM port"):
   * when present, `convertScadToCsg` tries the kernel-worker's
   * `convertScadViaWasm` before spawning the user-installed binary, and falls
   * back to the binary on any WASM failure (unavailable, abort, or a
   * construct the WASM path declines). Structural type (not `Pipeline`) so
   * this vscode-free module never imports the tool surface.
   */
  wasm?: {
    extensionPath: string;
    convertScadViaWasm: (
      extensionPath: string,
      modelPath: string,
      opts: { backend?: string; defines?: Record<string, ScadValue>; libraryPaths?: string[] }
    ) => Promise<{
      csgBytes: Uint8Array;
      warnings: string[];
      diagnostics: ScadDiagnostic[];
      droppedCount: number;
      dependencies: string[];
    }>;
  };
}

export interface ScadConvertResult {
  /** Converted `.csg` file bytes, ready to feed the shipped `.csg` pipeline as `format: "csg"`. */
  csgBytes: Uint8Array;
  /** openscad's own stderr chatter as prose (capped by severity, enveloped) — never silent, never flooding. */
  warnings: string[];
  /** The same chatter, structured. */
  diagnostics: ScadDiagnostic[];
  /** Diagnostics that did not fit the cap. */
  droppedCount: number;
  /**
   * Absolute paths of every file the evaluation read besides the source itself
   * (`use`/`include`d libraries, `import()`ed meshes), from openscad's `-d`
   * dependency list. `[]` when openscad wrote none or the list was unreadable.
   * Hit or miss, the same list a fresh conversion would have produced.
   */
  dependencies: string[];
  /** `true` when this result came from the in-memory cache and no `openscad` process was spawned. */
  cached?: boolean;
}

// ---------------------------------------------------------------------------
// Conversion cache (OpenSCAD include tracking and conversion cache)
// ---------------------------------------------------------------------------

/** Entries kept. A handful covers "preview, clearance check and export of the same source" with room for a few models. */
const SCAD_CACHE_MAX_ENTRIES = 8;

interface ScadCacheEntry {
  /** Everything that selects the conversion besides file CONTENT: path, binary identity, backend, `-D` set, library paths. */
  staticKey: string;
  /** sha256 of the source and of each dependency, `"absent"` for a listed file that did not exist. */
  hashes: Array<{ file: string; sha256: string }>;
  csgBytes: Uint8Array;
  warnings: string[];
  diagnostics: ScadDiagnostic[];
  droppedCount: number;
  dependencies: string[];
}

/** Most-recently-used first. Module state on purpose: it is the "last few compiles" memo, and is process-local. */
let scadCache: ScadCacheEntry[] = [];

/** Drops every cached conversion (tests; also safe to call after changing a binary in place). */
export function clearScadConversionCache(): void {
  scadCache = [];
}

type DependencyListener = (sourcePath: string, dependencies: readonly string[]) => void;
const dependencyListeners = new Set<DependencyListener>();

/**
 * Subscribes to "this source depends on these files", fired after EVERY
 * conversion, cache hit or miss (so a late subscriber still learns the list on
 * the next call). `provider.ts` uses it to watch included files without
 * threading a collector through ~25 `readOcctSource` call sites. Returns the
 * unsubscribe function.
 */
export function onScadDependencies(listener: DependencyListener): () => void {
  dependencyListeners.add(listener);
  return () => {
    dependencyListeners.delete(listener);
  };
}

function notifyDependencies(sourcePath: string, dependencies: readonly string[]): void {
  for (const l of dependencyListeners) {
    try {
      l(sourcePath, dependencies);
    } catch {
      // A broken listener must never fail a conversion.
    }
  }
}

/**
 * The binary's identity for cache purposes: resolved path + mtime + size.
 * Deliberately NOT a `--version` spawn — that would make a "cached" conversion
 * cost a process, and the point is that an unchanged model spawns nothing. An
 * in-place upgrade changes mtime/size, so it still misses. `undefined` (cannot
 * resolve or stat) disables caching for that call.
 */
async function binaryIdentity(binary: string): Promise<string | undefined> {
  const candidates: string[] = [];
  if (binary.includes("/") || binary.includes("\\") || path.isAbsolute(binary)) {
    candidates.push(binary);
  } else {
    const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (dir === "") continue;
      for (const ext of exts) candidates.push(path.join(dir, binary + ext));
    }
  }
  for (const c of candidates) {
    try {
      const st = await fs.stat(c);
      if (st.isFile()) return `${path.resolve(c)}:${st.mtimeMs}:${st.size}`;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function scadStaticKey(parts: {
  absSource: string;
  binaryId: string;
  backend: ScadBackend | undefined;
  defines: Record<string, ScadValue> | undefined;
  env: NodeJS.ProcessEnv;
}): string {
  const defines = Object.entries(parts.defines ?? {})
    .map(([k, v]) => [k, formatScadValue(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([parts.absSource, parts.binaryId, parts.backend ?? null, defines, parts.env[OPENSCAD_LIBRARY_ENV] ?? ""]);
}

async function hashFileOrAbsent(file: string): Promise<string> {
  try {
    return sha256Hex(await fs.readFile(file));
  } catch {
    return "absent";
  }
}

/** A cached entry is valid only while every recorded file still hashes the same. */
async function entryStillValid(entry: ScadCacheEntry): Promise<boolean> {
  for (const h of entry.hashes) {
    if ((await hashFileOrAbsent(h.file)) !== h.sha256) return false;
  }
  return true;
}

/** `include`/`use` of a file that does not exist is NOT in the dependency list (openscad only warns), so creating it later cannot invalidate an entry — such a result is never cached. */
const MISSING_INCLUDE_DIAGNOSTIC = /Can't open (include file|library)/i;

function scadWasmStaticKey(opts: {
  absSource: string;
  backend: ScadBackend | undefined;
  defines: Record<string, ScadValue> | undefined;
  libraryPaths: readonly string[] | undefined;
}): string {
  const defines = Object.entries(opts.defines ?? {})
    .map(([k, v]) => [k, formatScadValue(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const libs = (opts.libraryPaths ?? []).map((p) => p.trim()).filter((p) => p !== "");
  return JSON.stringify(["wasm", opts.absSource, opts.backend ?? "manifold", defines, libs]);
}

/**
 * WASM-first conversion with the same cache/watcher contract as the binary
 * path. Returns `undefined` when the caller passed no `wasm` (binary-only
 * call sites and unit tests with stub binaries). Throws on WASM failure so
 * the caller falls back to the binary — a WASM miss is never cached and never
 * notifies watchers (the binary run that follows does both).
 */
async function convertScadViaWasmCached(
  absSource: string,
  opts: ScadConvertOptions
): Promise<ScadConvertResult | undefined> {
  if (!opts.wasm) return undefined;
  const backend = resolveScadBackend(opts.backend);
  const staticKey = scadWasmStaticKey({ absSource, backend, defines: opts.defines, libraryPaths: opts.libraryPaths });
  const idx = scadCache.findIndex((e) => e.staticKey === staticKey);
  if (idx >= 0) {
    const entry = scadCache[idx];
    if (await entryStillValid(entry)) {
      scadCache.splice(idx, 1);
      scadCache.unshift(entry);
      notifyDependencies(absSource, entry.dependencies);
      return {
        csgBytes: entry.csgBytes.slice(),
        warnings: [...entry.warnings],
        diagnostics: entry.diagnostics.map((d) => ({ ...d })),
        droppedCount: entry.droppedCount,
        dependencies: [...entry.dependencies],
        cached: true,
      };
    }
    scadCache.splice(idx, 1);
  }
  const result = await opts.wasm.convertScadViaWasm(opts.wasm.extensionPath, absSource, {
    backend: opts.backend,
    defines: opts.defines,
    libraryPaths: opts.libraryPaths,
  });
  const files = [absSource, ...result.dependencies];
  const hashes = await Promise.all(files.map(async (file) => ({ file, sha256: await hashFileOrAbsent(file) })));
  if (hashes[0].sha256 !== "absent") {
    scadCache.unshift({
      staticKey,
      hashes,
      csgBytes: result.csgBytes.slice(),
      warnings: [...result.warnings],
      diagnostics: result.diagnostics.map((d) => ({ ...d })),
      droppedCount: result.droppedCount,
      dependencies: [...result.dependencies],
    });
    if (scadCache.length > SCAD_CACHE_MAX_ENTRIES) scadCache.length = SCAD_CACHE_MAX_ENTRIES;
  }
  notifyDependencies(absSource, result.dependencies);
  return result;
}

/**
 * Converts a `.scad` source to `.csg` bytes, through a small in-memory cache.
 *
 * Every `.scad` consumer — opening, each edit's re-tessellation, `load_model`,
 * mass properties, export, meshing — lands here, and a real model takes seconds
 * under CGAL, so an agent asking three questions used to pay three
 * conversions. A conversion is reused only while EVERYTHING it read still has
 * the same bytes: the source and every file openscad's own `-d` dependency
 * list names (so an edited `use <lib.scad>` is a miss — a source-text-only key
 * would serve stale geometry), under the same binary, backend, `-D` set and
 * library paths. A result is never cached when openscad wrote no dependency
 * list (cannot prove freshness) or when it warned about an `include`/`use` it
 * could not open (creating that file later would not be seen).
 */
export async function convertScadToCsg(sourcePath: string, opts: ScadConvertOptions = {}): Promise<ScadConvertResult> {
  const absSource = path.resolve(sourcePath);
  // WASM-first (roadmap "Build and bundle an OpenSCAD WASM port"): the
  // kernel-worker's bundled module needs no install and is byte-identical to
  // the binary on every committed fixture. Only a `ScadWasmFallbackError`
  // (unavailable, or a construct the WASM path declines: missing include,
  // import()/surface(), caps) falls back to the binary below. Any other WASM
  // failure (syntax error, stack overflow, empty output) is a genuine
  // conversion failure and surfaces — a binary retry would fail the same way
  // (or hang to the 120 s timeout on recursion).
  if (opts.wasm) {
    try {
      const wasmResult = await convertScadViaWasmCached(absSource, opts);
      if (wasmResult) return wasmResult;
    } catch (err) {
      if ((err as Error)?.name !== "ScadWasmFallbackError") throw err;
      if (process.env.CAD_PREVIEW_KERNEL_TRACE) console.error(`[scad-wasm-fallback] ${(err as Error).message}`);
      // fall through to the binary path
    }
  }
  const binary = resolveOpenscadBinary(opts.binary);
  const backend = resolveScadBackend(opts.backend);
  const binaryId = await binaryIdentity(binary);
  const staticKey =
    binaryId === undefined
      ? undefined
      : scadStaticKey({ absSource, binaryId, backend, defines: opts.defines, env: scadChildEnv(opts.libraryPaths) });

  if (staticKey !== undefined) {
    const idx = scadCache.findIndex((e) => e.staticKey === staticKey);
    if (idx >= 0) {
      const entry = scadCache[idx];
      if (await entryStillValid(entry)) {
        scadCache.splice(idx, 1);
        scadCache.unshift(entry);
        notifyDependencies(absSource, entry.dependencies);
        return {
          csgBytes: entry.csgBytes.slice(),
          warnings: [...entry.warnings],
          diagnostics: entry.diagnostics.map((d) => ({ ...d })),
          droppedCount: entry.droppedCount,
          dependencies: [...entry.dependencies],
          cached: true,
        };
      }
      scadCache.splice(idx, 1);
    }
  }

  const { result, depsKnown } = await spawnScadConversion(sourcePath, opts);
  if (staticKey !== undefined && depsKnown && !result.diagnostics.some((d) => MISSING_INCLUDE_DIAGNOSTIC.test(d.message))) {
    const files = [absSource, ...result.dependencies];
    const hashes = await Promise.all(files.map(async (file) => ({ file, sha256: await hashFileOrAbsent(file) })));
    // A source that vanished between the run and now is not cacheable.
    if (hashes[0].sha256 !== "absent") {
      scadCache.unshift({
        staticKey,
        hashes,
        csgBytes: result.csgBytes.slice(),
        warnings: [...result.warnings],
        diagnostics: result.diagnostics.map((d) => ({ ...d })),
        droppedCount: result.droppedCount,
        dependencies: [...result.dependencies],
      });
      if (scadCache.length > SCAD_CACHE_MAX_ENTRIES) scadCache.length = SCAD_CACHE_MAX_ENTRIES;
    }
  }
  notifyDependencies(absSource, result.dependencies);
  return result;
}

/**
 * Runs `openscad -o <tmp>/model.csg <sourcePath> -d <tmp>/model.d` with `cwd` =
 * the source directory (so relative `use`/`include`/`import` resolve exactly as
 * a manual invocation would), reads the output back, and removes the temp dir
 * in a `finally`. Input is the REAL path, never a temp copy — copying would
 * break those relative references with no error to catch it. `depsKnown` is
 * false when no readable dependency list came back.
 */
async function spawnScadConversion(
  sourcePath: string,
  opts: ScadConvertOptions
): Promise<{ result: ScadConvertResult; depsKnown: boolean }> {
  const binary = resolveOpenscadBinary(opts.binary);
  const timeoutMs = opts.timeoutMs ?? SCAD_CONVERT_TIMEOUT_MS;
  const backend = resolveScadBackend(opts.backend);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cad-preview-scad-"));
  // The output name MUST end in `.csg` — openscad selects its exporter from
  // the `-o` extension.
  const outPath = path.join(tmpDir, "model.csg");
  const depPath = path.join(tmpDir, "model.d");
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
      const res = await execFileAsync(binary, scadArgs(outPath, absSource, { backend, defines: opts.defines, depfile: depPath }), {
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
        throw new ScadConvertError(
          `OpenSCAD conversion timed out after ${Math.round(timeoutMs / 1000)}s (child killed) — ` +
            `the model may be too complex, import too large a mesh, or loop; simplify and retry.`,
          "timeout"
        );
      }
      const rawExcerpt = String(e.stderr ?? (err as Error).message ?? err).slice(-MAX_STDERR_EXCERPT);
      // stderr is document-influenced (echo(), file names): enveloped in the message.
      const excerpt = envelope(rawExcerpt, "openscad", MAX_STDERR_EXCERPT);
      // A stock build that predates the backend switch rejects the flag by
      // name; say so rather than leaving the user to decode a getopt message.
      const backendHint =
        backend && /backend|unrecogni[sz]ed option|unknown option/i.test(rawExcerpt)
          ? ` — this OpenSCAD build may not support --backend=${backend} (needs a 2025+ snapshot); set cadPreview.openscadBackend to "auto" to omit it.`
          : "";
      throw new ScadConvertError(`openscad failed on ${path.basename(sourcePath)} (exit ${e.code ?? "?"}): ${excerpt}${backendHint}`, "failed");
    }
    const { diagnostics, droppedCount } = parseScadStderr(stderr);
    const warnings = scadWarningLines(diagnostics, droppedCount);
    let csgBytes: Uint8Array;
    try {
      csgBytes = new Uint8Array(await fs.readFile(outPath));
    } catch {
      throw new ScadConvertError(`openscad exited 0 but wrote no .csg output for ${path.basename(sourcePath)} — treating as a failed conversion.`, "failed");
    }
    if (csgBytes.length === 0) {
      throw new ScadConvertError(`openscad wrote an empty .csg for ${path.basename(sourcePath)} — treating as a failed conversion.`, "failed");
    }
    // The dependency list is best-effort: a missing/unreadable one just means
    // "cannot prove freshness", never a failed conversion.
    let dependencies: string[] = [];
    let depsKnown = false;
    try {
      dependencies = parseMakeDepfile(await fs.readFile(depPath, "utf8"), { cwd: path.dirname(absSource), exclude: [absSource, outPath] });
      depsKnown = true;
    } catch {
      // stays unknown
    }
    return { result: { csgBytes, warnings, diagnostics, droppedCount, dependencies }, depsKnown };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export interface EffectiveSourceOptions {
  binary?: string;
  timeoutMs?: number;
  backend?: string;
  libraryPaths?: string[];
  /** Customizer overrides, each passed as `-D name=value` (roadmap "OpenSCAD Customizer panel in the viewer" — the
   * interactive panel persists them in `<model>.scad-params.json` and replays them here; headless `convert_scad`
   * passes per-call `parameters` the same way). Validate with `validateScadOverrides` first. */
  defines?: Record<string, ScadValue>;
  /** WASM-first conversion (see {@link ScadConvertOptions.wasm}); when present `.scad` prefers the bundled WASM. */
  wasm?: ScadConvertOptions["wasm"];
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
  /** Optional collector: receives the structured diagnostics (and the dropped count) alongside the `warnings` prose. */
  diagnostics?: ScadDiagnosticCollector;
  binary?: string;
  timeoutMs?: number;
  backend?: string;
  libraryPaths?: string[];
  /** Customizer overrides for a `.scad` source (see {@link EffectiveSourceOptions.defines}). */
  defines?: Record<string, ScadValue>;
  /** WASM-first conversion (see {@link ScadConvertOptions.wasm}); when present `.scad` prefers the bundled WASM. */
  wasm?: ScadConvertOptions["wasm"];
}): Promise<{ bytes: Uint8Array; format: CadFormat }> {
  if (opts.format !== "scad") {
    return { bytes: await opts.readBytes(), format: opts.format };
  }
  const { csgBytes, warnings, diagnostics, droppedCount } = await convertScadToCsg(opts.modelPath, {
    binary: opts.binary,
    timeoutMs: opts.timeoutMs,
    backend: opts.backend,
    libraryPaths: opts.libraryPaths,
    defines: opts.defines,
    ...(opts.wasm ? { wasm: opts.wasm } : {}),
  });
  opts.warnings.push(...warnings);
  if (opts.diagnostics) {
    opts.diagnostics.diagnostics.push(...diagnostics);
    opts.diagnostics.droppedCount += droppedCount;
  }
  return { bytes: csgBytes, format: "csg" };
}
