/**
 * Opt-in end-to-end smoke test for the MCP server (`npm run mcp:smoke`):
 * spawns the real `dist/mcp-server.js` (real OCCT + Gmsh WASM) and drives it
 * over actual stdio JSON-RPC — initialize → tools/list → load_model →
 * apply_edit_ops → generate_mesh → export_mesh (msh + geoUnrolled) →
 * export_brep → save_preprocess → load_preprocess — against a temp copy of
 * `examples/STP/bull.stp`, asserting real geometry/mesh output, sidecar
 * validity, that the CAD source is byte-identical afterward, and that a
 * preprocess archive round-trips the source + edits sidecar into a fresh
 * copy. Any WASM stdout pollution breaks the JSON-RPC framing immediately,
 * so this doubles as the stdout-rebind regression test.
 *
 * Prerequisite: `npm run build` (the `mcp:smoke` npm script chains it).
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = path.join(ROOT, "dist", "mcp-server.js");
const FIXTURE = path.join(ROOT, "examples", "STP", "bull.stp");

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function assert(cond, message) {
  if (!cond) fail(message);
  console.log(`✓ ${message}`);
}

// --- minimal newline-delimited JSON-RPC stdio client ------------------------

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

/** tools/call wrapper: unwraps the JSON text content block, fails on isError. */
async function call(name, args) {
  const result = await request("tools/call", { name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) fail(`${name} returned an error: ${text}`);
  return JSON.parse(text);
}

// --- the scenario ------------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-preview-mcp-smoke-"));
const model = path.join(dir, "bull.stp");
fs.copyFileSync(FIXTURE, model);
const originalBytes = fs.readFileSync(model);

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-smoke", version: "0" },
  });
  notify("notifications/initialized");
  assert(init.serverInfo.name === "cad-preview", "initialize handshake");

  const tools = (await request("tools/list", {})).tools.map((t) => t.name);
  assert(tools.length === 14, `tools/list exposes 14 tools (got ${tools.length}: ${tools.join(", ")})`);

  const caps = await call("describe_capabilities", {});
  assert(caps.ops.length >= 40 && caps.meshExportFormats.length >= 10, "describe_capabilities catalog populated");

  const loaded = await call("load_model", { path: model });
  assert(loaded.solids.length === 1 && loaded.solids[0].faceIds.length > 10, "load_model tessellates bull.stp");
  assert(loaded.bbox && loaded.bbox.diagonal > 0, "load_model reports a bounding box");
  const { bbox } = loaded;

  // Add a box beside the bull, sized/placed off the real bbox.
  const s = bbox.diagonal / 10;
  const applied = await call("apply_edit_ops", {
    path: model,
    ops: [
      { op: "addBox", center: [bbox.max[0] + s, 0, 0], size: [s, s, s] },
      { op: "addBox", center: [0, 0, 0] }, // deliberately malformed
    ],
  });
  assert(applied.applied === 1 && applied.rejected === 1, "apply_edit_ops accepts the box, rejects the malformed op");
  assert(applied.model.solids.length === 2, "post-replay inventory shows 2 solids");

  const sidecar = JSON.parse(fs.readFileSync(`${model}.edits.json`, "utf8"));
  assert(sidecar.ops.length === 1 && sidecar.ops[0].op === "addBox", "edits sidecar is valid JSON with the op");

  const meshed = await call("generate_mesh", { path: model, options: { sizeMax: bbox.diagonal / 15 } });
  assert(meshed.nodeCount > 0 && meshed.elementCount > 0, `generate_mesh: ${meshed.nodeCount} nodes, ${meshed.elementCount} elements in ${meshed.elapsedMs} ms`);

  const mshOut = path.join(dir, "out.msh");
  await call("export_mesh", { path: model, format: "msh", outputPath: mshOut, options: { sizeMax: bbox.diagonal / 15 } });
  const msh = fs.readFileSync(mshOut, "utf8");
  assert(msh.includes("$MeshFormat") && msh.includes("$Elements"), "export_mesh msh writes a real Gmsh mesh");

  const geoOut = path.join(dir, "out.geo_unrolled");
  const geoResult = await call("export_mesh", { path: model, format: "geoUnrolled", outputPath: geoOut, options: { sizeMax: bbox.diagonal / 15 } });
  assert(geoResult.written.length === 2, "export_mesh geoUnrolled writes the .geo_unrolled + .xao pair");
  assert(fs.readFileSync(geoOut, "utf8").includes('Merge "out.geo_unrolled.xao";'), "Merge stub rewritten to the sibling companion");
  assert(fs.statSync(`${geoOut}.xao`).size > 0, "XAO companion has content");

  const brepOut = path.join(dir, "out.brep");
  const breped = await call("export_brep", { path: model, targetFormat: "brep", outputPath: brepOut });
  assert(breped.editsBaked === 1 && fs.statSync(brepOut).size > 0, "export_brep writes with the edit baked in");

  await call("set_part", { path: model, name: "Bull", volumes: ["solid-0"] });

  const zipOut = path.join(dir, "bull.preprocess.zip");
  const saved = await call("save_preprocess", { path: model, outputPath: zipOut });
  assert(
    saved.included.edits && saved.included.parts && fs.statSync(zipOut).size > 0,
    "save_preprocess writes a non-empty .zip including the edits + parts sidecars"
  );
  assert(!saved.included.meshOptions, "save_preprocess omits mesh options never explicitly set via set_mesh_options");

  const restoredDir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-preview-mcp-smoke-restore-"));
  const restoredModel = path.join(restoredDir, "bull-restored.stp");
  const loaded2 = await call("load_preprocess", { zipPath: zipOut, outputPath: restoredModel });
  assert(
    loaded2.manifestSource === "bull.stp" && loaded2.restored.edits && loaded2.restored.parts,
    "load_preprocess restores the manifest + edits/parts flags"
  );
  assert(
    Buffer.compare(fs.readFileSync(restoredModel), originalBytes) === 0,
    "load_preprocess restores a byte-identical CAD source copy"
  );
  const restoredEdits = JSON.parse(fs.readFileSync(`${restoredModel}.edits.json`, "utf8"));
  assert(restoredEdits.ops.length === 1 && restoredEdits.ops[0].op === "addBox", "load_preprocess restores the edits sidecar");
  const restoredParts = JSON.parse(fs.readFileSync(`${restoredModel}.parts.json`, "utf8"));
  assert(restoredParts.parts.length === 1 && restoredParts.parts[0].name === "Bull", "load_preprocess restores the parts sidecar");
  fs.rmSync(restoredDir, { recursive: true, force: true });

  assert(Buffer.compare(fs.readFileSync(model), originalBytes) === 0, "CAD source file is byte-identical");

  console.log("\nMCP smoke test passed.");
} catch (err) {
  fail(err.stack ?? String(err));
} finally {
  shuttingDown = true;
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
