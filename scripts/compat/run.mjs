/**
 * Dependency and format compatibility corpus (`npm run compat`).
 *
 * A TABLE-DRIVEN sibling of `mcp:smoke`: every row in `corpus.json` is one
 * deterministic check against the real `dist/mcp-server.js` (real OCCT, Gmsh,
 * meshio++ WASM) — open a committed fixture, write a mesh export from the
 * seed model and re-open it, or round-trip a B-rep export through
 * `get_mass_properties`. It is what makes a kernel upgrade cheap to verify:
 * run it before and after the bump and diff the table.
 *
 * Known upstream limitations are rows too: a row with `knownLimitation`
 * asserts the CURRENT failure text; if the failure disappears the row is
 * reported FIXED-UPSTREAM — a finding to record and re-scope, never a
 * failure. Timing is deliberately NOT measured here (`npm run perf` owns
 * that) so this stays a correctness gate.
 *
 * The stdio JSON-RPC client is a small copy of mcp-smoke's (this repo's
 * convention: scripts/* entries share no modules). Prerequisite: `npm run
 * build` (the npm script chains it). `--only <substring>` filters rows.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = path.join(ROOT, "dist", "mcp-server.js");
const EXAMPLES = path.join(ROOT, "examples");
const corpus = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "corpus.json"), "utf8"));
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : undefined;

function pkgVersion(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return "missing";
  }
}
const versions = {
  "opencascade.js": pkgVersion("opencascade.js"),
  "@loumalouomega/gmsh-wasm": pkgVersion("@loumalouomega/gmsh-wasm"),
  "@meshioplusplus/wasm": pkgVersion("@meshioplusplus/wasm"),
  "float-tetwild-wasm": pkgVersion("float-tetwild-wasm"),
};

// --- minimal stdio JSON-RPC client -----------------------------------------

const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", () => {}); // kernel logs are noise here
let nextId = 1;
const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`✗ stdout is not pure JSON-RPC: ${line.slice(0, 200)}`);
      process.exit(1);
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});
function request(method, params, timeoutMs = 300_000) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
  });
}
/** tools/call → parsed JSON, or throws the tool's error text. A transient
 * self-healing WASM abort ("kernel has been reset") is retried once — every
 * call here is read-only or writes a fresh output path, so a retry is safe. */
async function call(name, args, retried = false) {
  const result = await request("tools/call", { name, arguments: args });
  if (result.isError) {
    const text = result.content?.[0]?.text ?? "";
    if (!retried && /kernel has been reset/i.test(text)) return call(name, args, true);
    throw new Error(text);
  }
  return JSON.parse(result.content?.[0]?.text ?? "");
}

// --- checks ------------------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-preview-compat-"));

function stageFixture(row) {
  const rowDir = path.join(dir, row.id);
  fs.mkdirSync(rowDir, { recursive: true });
  if (row.fixtureDir) {
    fs.cpSync(path.join(EXAMPLES, row.fixtureDir), rowDir, { recursive: true });
    return path.join(rowDir, row.fixture);
  }
  const dest = path.join(rowDir, path.basename(row.fixture));
  fs.copyFileSync(path.join(EXAMPLES, row.fixture), dest);
  for (const s of row.siblings ?? []) fs.copyFileSync(path.join(EXAMPLES, s), path.join(rowDir, path.basename(s)));
  return dest;
}

function countFaces(model) {
  return (model?.solids ?? []).reduce((n, s) => n + (s.faceIds?.length ?? 0), 0);
}

function checkExpect(res, expect) {
  const problems = [];
  if (expect.format && res.format !== expect.format) problems.push(`format ${res.format} ≠ ${expect.format}`);
  const model = res.model ?? res; // load_model spreads the B-rep entity summary at top level
  if (expect.solids !== undefined && (model?.solids?.length ?? 0) !== expect.solids)
    problems.push(`solids ${model?.solids?.length} ≠ ${expect.solids}`);
  if (expect.faces !== undefined && countFaces(model) !== expect.faces) problems.push(`faces ${countFaces(model)} ≠ ${expect.faces}`);
  if (expect.edges !== undefined && model?.edgeCount !== expect.edges) problems.push(`edges ${model?.edgeCount} ≠ ${expect.edges}`);
  const tri = res.meshEntities?.triangleCount;
  if (expect.triangles !== undefined && tri !== expect.triangles) problems.push(`triangles ${tri} ≠ ${expect.triangles}`);
  if (expect.trianglesMin !== undefined && !(tri >= expect.trianglesMin)) problems.push(`triangles ${tri} < ${expect.trianglesMin}`);
  const comps = res.meshEntities?.components?.length;
  if (expect.components !== undefined && comps !== expect.components) problems.push(`components ${comps} ≠ ${expect.components}`);
  const warnings = (res.warnings ?? []).join(" ");
  if (expect.warningIncludes && !warnings.includes(expect.warningIncludes)) problems.push(`warnings lack "${expect.warningIncludes}"`);
  if (expect.warningExcludes && warnings.includes(expect.warningExcludes)) problems.push(`warnings contain "${expect.warningExcludes}"`);
  return problems;
}

async function remesh(file) {
  const r = await call("generate_mesh", { path: file, options: { dimension: 3 } });
  if (!(r.elementCount > 0)) throw new Error(`generate_mesh produced ${r.elementCount} elements`);
  return `${r.elementCount} el`;
}

/** Runs one row; returns { status, detail, stage }. Throws are caught per stage. */
async function runRow(row, seedPath) {
  let stage = "run";
  try {
    if (row.check === "load") {
      const file = stageFixture(row);
      stage = "load";
      const res = await call("load_model", { path: file });
      const problems = checkExpect(res, row.expect ?? {});
      if (problems.length) return { status: "FAIL", stage, detail: problems.join("; ") };
      let detail = res.format;
      if (row.expect?.remesh) {
        stage = "remesh";
        detail += ` · remesh ${await remesh(file)}`;
      }
      return { status: "PASS", stage, detail };
    }
    if (row.check === "export") {
      const out = path.join(dir, row.id, `out.${exportExtension(row.format)}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      stage = "export";
      const res = await call("export_mesh", { path: seedPath, format: row.format, outputPath: out });
      const written = res.written ?? [];
      if (!written.length || written.some((w) => !(w.bytes > 0))) return { status: "FAIL", stage, detail: "empty export" };
      if (row.companion && !written.some((w) => w.path.endsWith(row.companion)))
        return { status: "FAIL", stage, detail: `no ${row.companion} companion written` };
      let detail = `${written.length} file(s)`;
      if (row.reload) {
        stage = "reload";
        const back = await call("load_model", { path: out });
        detail += ` · reopens as ${back.format}`;
        if (row.remesh) {
          stage = "remesh";
          detail += ` · remesh ${await remesh(out)}`;
        }
      }
      return { status: "PASS", stage, detail };
    }
    if (row.check === "brepExport") {
      const out = path.join(dir, row.id, `out.${row.format === "iges" ? "igs" : row.format === "step" ? "stp" : "brep"}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      stage = "export";
      let source = seedPath;
      if (row.via) {
        // A source can't target its own format (that's save_model), so reach
        // it through an intermediate B-rep format first.
        source = path.join(dir, row.id, `via.${row.via}`);
        await call("export_brep", { path: seedPath, targetFormat: row.via, outputPath: source });
      }
      await call("export_brep", { path: source, targetFormat: row.format, outputPath: out });
      stage = "mass";
      const mass = await call("get_mass_properties", { path: out });
      const rel = Math.abs(mass.volume - corpus.seedVolume) / corpus.seedVolume;
      if (!(rel < 1e-6)) return { status: "FAIL", stage, detail: `volume ${mass.volume} ≠ ${corpus.seedVolume}` };
      return { status: "PASS", stage, detail: `volume ${mass.volume.toFixed(6)}` };
    }
    return { status: "FAIL", stage, detail: `unknown check ${row.check}` };
  } catch (err) {
    return { status: "FAIL", stage, detail: (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200) };
  }
}

const EXTENSIONS = {
  mdpaElements: "mdpa", mdpaGeometries: "mdpa", msh2: "msh2", mesh: "mesh", gid: "post.msh", avsucd: "avs", netgen: "vol", flac3d: "f3grid", flux: "pf3",
};
function exportExtension(format) {
  return EXTENSIONS[format] ?? format;
}

// --- main --------------------------------------------------------------------

let exitCode = 0;
try {
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "compat", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const seedPath = path.join(dir, "seed", path.basename(corpus.seed));
  fs.mkdirSync(path.dirname(seedPath), { recursive: true });
  fs.copyFileSync(path.join(EXAMPLES, corpus.seed), seedPath);

  console.log(`compat corpus — ${Object.entries(versions).map(([k, v]) => `${k}@${v}`).join(", ")}`);
  const rows = corpus.rows.filter((r) => !only || r.id.includes(only));
  const results = [];
  for (const row of rows) {
    let r = await runRow(row, seedPath);
    const kl = row.knownLimitation;
    if (kl) {
      if (r.status === "FAIL" && r.stage === kl.stage && r.detail.includes(kl.match)) r = { status: "KNOWN", stage: r.stage, detail: kl.note };
      else if (r.status === "PASS") r = { status: "FIXED-UPSTREAM", stage: kl.stage, detail: `no longer fails: ${kl.note}` };
    }
    results.push({ id: row.id, ...r });
    const mark = { PASS: "✓", KNOWN: "·", "FIXED-UPSTREAM": "!", FAIL: "✗" }[r.status];
    console.log(`${mark} ${r.status.padEnd(14)} ${row.id.padEnd(30)} ${r.detail}`);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(
    `\n${results.length} rows: ${count("PASS")} pass, ${count("KNOWN")} known limitation, ${count("FIXED-UPSTREAM")} fixed upstream, ${count("FAIL")} fail`
  );
  if (count("FIXED-UPSTREAM")) console.log("A FIXED-UPSTREAM row is a finding: record it in CLAUDE.md and update corpus.json.");
  fs.writeFileSync(path.join(ROOT, "scripts", "compat", "last-run.json"), JSON.stringify({ versions, results }, null, 2) + "\n");
  if (count("FAIL")) exitCode = 1;
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : err}`);
  exitCode = 1;
} finally {
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
