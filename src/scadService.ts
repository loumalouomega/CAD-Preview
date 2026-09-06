/**
 * OpenSCAD `.scad` → `.csg` conversion via a user-installed `openscad`
 * binary (roadmap Tier 2 item 2, path (b), closed) — the only half of the
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
 * Live-binary caveat, stated plainly: NO `openscad` binary exists in this
 * environment, so the `-o out.csg in.scad` invocation shape and the
 * `--version` probe contract below follow FreeCAD's documented architecture
 * (cited in the roadmap item) but are UNVERIFIED against a real binary here.
 * Tests drive a stub-binary script through the real `execFile` plumbing
 * (arg shape, cwd, timeout-kill, error mapping all genuinely exercised);
 * fidelity of the flags themselves needs one manual run where openscad is
 * installed before release.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CadFormat } from "./fileRouter";

const execFileAsync = promisify(execFileCb);

/** Env override for headless use (the MCP server has no vscode settings to
 * read) — explicit param wins, then this, then {@link DEFAULT_OPENSCAD_BINARY}. */
export const OPENSCAD_BINARY_ENV = "OPENSCAD_BINARY";
/** Binary name resolved via PATH when nothing else is configured. */
export const DEFAULT_OPENSCAD_BINARY = "openscad";
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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cad-preview-scad-"));
  // The output name MUST end in `.csg` — openscad selects its exporter from
  // the `-o` extension.
  const outPath = path.join(tmpDir, "model.csg");
  try {
    let stderr = "";
    try {
      const res = await execFileAsync(binary, ["-o", outPath, sourcePath], {
        cwd: path.dirname(path.resolve(sourcePath)),
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
      throw new Error(`openscad failed on ${path.basename(sourcePath)} (exit ${e.code ?? "?"}): ${excerpt}`);
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
}): Promise<{ bytes: Uint8Array; format: CadFormat }> {
  if (opts.format !== "scad") {
    return { bytes: await opts.readBytes(), format: opts.format };
  }
  const { csgBytes, warnings } = await convertScadToCsg(opts.modelPath, { binary: opts.binary, timeoutMs: opts.timeoutMs });
  opts.warnings.push(...warnings);
  return { bytes: csgBytes, format: "csg" };
}
