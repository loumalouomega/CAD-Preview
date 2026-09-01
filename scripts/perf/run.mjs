/**
 * Performance regression harness (`npm run perf`, roadmap "Performance
 * regression harness", closed): spawns the real `dist/mcp-server.js` (real
 * OCCT + Gmsh WASM, same process this repo's `mcp:smoke` already drives) and
 * benchmarks `load_model` (B-rep read + tessellate) and `generate_mesh` (FE
 * meshing) against four graded STEP fixtures under `examples/STP/` — small
 * (~21 KB), medium (~113 KB, the same `bull.stp` used everywhere else in
 * this codebase), large (~333 KB), and xlarge (~2.3 MB). Reports wall-clock
 * ms and, on Linux, the server process's RSS delta (`/proc/<pid>/status`) —
 * `null` elsewhere (macOS/Windows), degrading gracefully rather than
 * throwing, matching this codebase's usual "optional signal, never blocks
 * the run" convention (e.g. Playwright's `render_snapshot`).
 *
 * Compares each stage's wall-clock time against a checked-in baseline
 * (`scripts/perf/baseline.json`, captured once on this dev environment) with
 * a deliberately generous 3x tolerance — machine-to-machine variance (this
 * script has no CI job wired up; it's meant to be run by hand before/after a
 * change to something on the "load, tessellation, or meshing" hot path, per
 * the roadmap item's own framing) is real, and 3x is still comfortably below
 * the "10x regression nothing would catch" failure mode the item was filed
 * to close. A flagged stage prints a warning; the run only exits non-zero
 * when `PERF_STRICT=1` is set, so this never breaks `npm test`/normal CI by
 * merely existing — it's an opt-in gate, not an automatic one.
 *
 * `--update-baseline` overwrites `baseline.json` with the numbers from this
 * run (use after a deliberate, reviewed perf-affecting change).
 *
 * Prerequisite: `npm run build` (the `perf` npm script chains it, same as `mcp:smoke`).
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = path.join(ROOT, "dist", "mcp-server.js");
const BASELINE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "baseline.json");
const REGRESSION_FACTOR = 3;
const UPDATE_BASELINE = process.argv.includes("--update-baseline");
const STRICT = process.env.PERF_STRICT === "1";

/** Small → xlarge, spanning roughly two orders of magnitude of STEP file
 * size (and, by extension, tessellated triangle/mesh-element count) — the
 * same "graded model sizes" framing the roadmap item asked for. */
const FIXTURES = [
  { name: "small", file: "angle1.stp" },
  { name: "medium", file: "bull.stp" },
  { name: "large", file: "piston.stp" },
  { name: "xlarge", file: "turbine.stp" },
];

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// --- minimal newline-delimited JSON-RPC stdio client (mirrors mcp-smoke) ---

const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
child.on("exit", (code) => {
  if (!shuttingDown) fail(`server exited early (code ${code})`);
});
let shuttingDown = false;

let nextId = 1;
const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`non-JSON line on stdout (protocol pollution): ${line.slice(0, 200)}`);
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`RPC error: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    }
  }
});

function request(method, params, timeoutMs = 300_000) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs} ms`)), timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function call(name, args) {
  let result = await request("tools/call", { name, arguments: args });
  // A WASM abort in the kernel worker surfaces as "… the kernel has been
  // reset; try the operation again." (all four services' fault vocabularies
  // — including the `wasmtable` signature this harness itself uncovered —
  // reset the singleton before rethrowing). The kernel-client transparently
  // respawns a fresh worker for the NEXT call, so one clean retry recovers.
  // Retrying is safe here without a state-reset callback (the reason
  // mcp-smoke's `callWithCleanRetry` needs one): this harness's two call
  // types are read-only benchmarking — `load_model`/`generate_mesh` never
  // persist sidecar state, so the aborted attempt cannot leave a partial
  // write the retry would double-apply.
  if (/kernel has been reset/i.test(result.content?.[0]?.text ?? "")) {
    console.error(`  (kernel reset mid-${name} — retrying once on a fresh worker)`);
    result = await request("tools/call", { name, arguments: args });
  }
  if (result.isError) fail(`${name} returned an error: ${result.content?.[0]?.text ?? ""}`);
  return JSON.parse(result.content?.[0]?.text ?? "");
}

/** RSS of the (single, long-lived) server process — `null` off Linux or if
 * the process has already exited, never thrown. */
function readRssKb() {
  try {
    const status = fs.readFileSync(`/proc/${child.pid}/status`, "utf8");
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function timed(fn) {
  const rssBefore = readRssKb();
  const started = Date.now();
  const value = await fn();
  const wallMs = Date.now() - started;
  const rssAfter = readRssKb();
  const rssDeltaKb = rssBefore != null && rssAfter != null ? rssAfter - rssBefore : null;
  return { value, wallMs, rssDeltaKb };
}

// --- the benchmark -----------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-preview-perf-"));
const results = [];

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "perf", version: "0" },
  });
  notify("notifications/initialized");
  if (init.serverInfo.name !== "cad-preview") fail("initialize handshake failed");

  // Warm-up: pay the one-time OCCT/Gmsh WASM init cost on a throwaway tiny
  // load, outside every reported measurement, so every graded fixture below
  // reflects steady-state (already-initialized-singleton) performance, not
  // whichever fixture happened to run first.
  const warmupPath = path.join(dir, "warmup.stp");
  fs.copyFileSync(path.join(ROOT, "examples", "STP", "angle1.stp"), warmupPath);
  const warmupLoad = await call("load_model", { path: warmupPath });
  const warmupDiagonal = warmupLoad.bbox?.diagonal;
  await call("generate_mesh", {
    path: warmupPath,
    options: { dimension: 3, ...(warmupDiagonal ? { sizeMin: 0, sizeMax: warmupDiagonal / 20 } : {}) },
  });
  console.log("Warm-up complete (WASM singletons initialized).\n");

  for (const fixture of FIXTURES) {
    const src = path.join(ROOT, "examples", "STP", fixture.file);
    const sizeKb = Math.round(fs.statSync(src).size / 1024);
    const model = path.join(dir, fixture.file);
    fs.copyFileSync(src, model);

    console.error(`--- benchmarking ${fixture.name} (${fixture.file}, ${sizeKb} KB) ---`);
    const load = await timed(() => call("load_model", { path: model }));
    // Explicit bbox-derived sizeMax (same diagonal/20 default the interactive
    // panel's own syncMeshSizeSeed() seeds) rather than the unbounded "auto"
    // sentinel — on some of the larger real-world fixtures here, Gmsh's
    // curvature-based automatic sizing produces a mesh fine enough to trip a
    // "PLC Error: a segment and a facet intersect" robustness failure. An
    // explicit, appropriately-scaled size avoids that without favoring one
    // fixture's timing over another's.
    const diagonal = load.value.bbox?.diagonal;
    const meshOptions = { dimension: 3, ...(diagonal ? { sizeMin: 0, sizeMax: diagonal / 20 } : {}) };
    const mesh = await timed(() => call("generate_mesh", { path: model, options: meshOptions }));

    results.push({
      name: fixture.name,
      file: fixture.file,
      sizeKb,
      loadMs: load.wallMs,
      loadRssDeltaKb: load.rssDeltaKb,
      meshMs: mesh.wallMs,
      meshSelfReportedMs: mesh.value.elapsedMs,
      meshRssDeltaKb: mesh.rssDeltaKb,
    });
  }
} catch (err) {
  fail(err.stack ?? String(err));
} finally {
  shuttingDown = true;
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- report + baseline comparison -------------------------------------------

console.log(
  "fixture".padEnd(8) +
    "size(KB)".padStart(10) +
    "load(ms)".padStart(10) +
    "loadΔRSS(KB)".padStart(14) +
    "mesh(ms)".padStart(10) +
    "meshΔRSS(KB)".padStart(14)
);
for (const r of results) {
  console.log(
    r.name.padEnd(8) +
      String(r.sizeKb).padStart(10) +
      String(r.loadMs).padStart(10) +
      String(r.loadRssDeltaKb ?? "n/a").padStart(14) +
      String(r.meshMs).padStart(10) +
      String(r.meshRssDeltaKb ?? "n/a").padStart(14)
  );
}
console.log();

if (UPDATE_BASELINE) {
  const baseline = Object.fromEntries(results.map((r) => [r.name, { loadMs: r.loadMs, meshMs: r.meshMs }]));
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`Baseline updated: ${BASELINE_PATH}`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
  console.log(`No baseline found at ${BASELINE_PATH} — run with --update-baseline to create one.`);
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
let regressions = 0;
for (const r of results) {
  const base = baseline[r.name];
  if (!base) {
    console.log(`⚠ no baseline entry for "${r.name}" — run with --update-baseline to add one.`);
    continue;
  }
  for (const [stage, ms, baseMs] of [
    ["load_model", r.loadMs, base.loadMs],
    ["generate_mesh", r.meshMs, base.meshMs],
  ]) {
    if (ms > baseMs * REGRESSION_FACTOR) {
      regressions++;
      console.log(
        `⚠ REGRESSION: ${r.name} ${stage} took ${ms} ms, more than ${REGRESSION_FACTOR}x the ${baseMs} ms baseline`
      );
    }
  }
}

if (regressions === 0) {
  console.log(`No regressions ≥${REGRESSION_FACTOR}x baseline (${BASELINE_PATH}).`);
} else if (STRICT) {
  fail(`${regressions} regression(s) ≥${REGRESSION_FACTOR}x baseline — failing (PERF_STRICT=1).`);
} else {
  console.log(`${regressions} regression(s) found — set PERF_STRICT=1 to fail the run on this.`);
}
