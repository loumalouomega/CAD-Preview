/**
 * Opt-in end-to-end smoke test for the MCP server (`npm run mcp:smoke`):
 * spawns the real `dist/mcp-server.js` (real OCCT + Gmsh + meshio++ WASM) and
 * drives it over actual stdio JSON-RPC — initialize → tools/list → load_model →
 * apply_edit_ops → inspect/measure → compare_models → generate_mesh →
 * export_mesh (msh + geoUnrolled) → export_brep → a meshio++-only VTK source
 * meshed and exported to MED/XDMF (the meshio bridge) → render_snapshot
 * (tolerating a missing Chromium) → save_preprocess → load_preprocess —
 * against a temp copy of `examples/STP/bull.stp`, asserting real geometry/mesh
 * output, sidecar validity, that the CAD source is byte-identical afterward,
 * and that a preprocess archive round-trips the source + edits sidecar into a
 * fresh copy. Any WASM stdout pollution breaks the JSON-RPC framing
 * immediately, so this doubles as the stdout-rebind regression test — for all
 * three WASM modules, since meshio++'s default print path also goes through
 * console.log/console.error (see meshioService.ts).
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

/** tools/call wrapper: raw result (full content array), fails on isError. */
async function callRaw(name, args) {
  const result = await request("tools/call", { name, arguments: args });
  if (result.isError) fail(`${name} returned an error: ${result.content?.[0]?.text ?? ""}`);
  return result;
}

/** tools/call wrapper: unwraps + JSON-parses the first (text) content block. */
async function call(name, args) {
  const result = await callRaw(name, args);
  return JSON.parse(result.content?.[0]?.text ?? "");
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
  assert(tools.length === 18, `tools/list exposes 18 tools (got ${tools.length}: ${tools.join(", ")})`);

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

  // inspect/measure: real OCCT entity facts + distance for the bull solid
  // (solid-0) and the just-added box (solid-1).
  const bullFacts = await call("inspect", { path: model, entityId: "solid-0" });
  assert(
    bullFacts.supported === true && bullFacts.bbox && bullFacts.center && bullFacts.area > 0,
    "inspect resolves solid-0's bbox/center/area"
  );
  const boxFacts = await call("inspect", { path: model, entityId: "solid-1" });
  assert(boxFacts.supported === true && boxFacts.kind === "solid", "inspect resolves the added box (solid-1)");

  const measured = await call("measure", { path: model, from: "solid-0", to: "solid-1" });
  assert(
    measured.supported === true && measured.distance > 0,
    `measure reports a positive distance between solid-0 and solid-1 (got ${measured.distance})`
  );

  // compare_models: the edited model (bull + added box) against a fresh,
  // unedited copy of the same fixture (just the bull) — the bull solid
  // should match itself exactly (centreDistance/volumeDeltaPct ~ 0) and the
  // added box should show up as `added`, nothing as `removed`.
  const originalCopy = path.join(dir, "bull-original.stp");
  fs.copyFileSync(FIXTURE, originalCopy);
  const diff = await call("compare_models", { pathA: model, pathB: originalCopy });
  assert(diff.supported === true, "compare_models supports B-rep sources");
  assert(
    diff.diff.matched.length === 1 && diff.diff.added.length === 0 && diff.diff.removed.length === 1,
    `compare_models(edited, original): 1 matched (the bull), 0 added, 1 removed (the box) — got matched=${diff.diff.matched.length} added=${diff.diff.added.length} removed=${diff.diff.removed.length}`
  );
  assert(
    diff.diff.matched[0].centreDistance < 1e-6 && diff.diff.matched[0].volumeDeltaPct < 1e-6,
    "compare_models reports the matched bull solid as an exact match (0 displacement, 0 volume delta)"
  );

  // render_snapshot: Playwright/Chromium is a devDependency this environment
  // may or may not have installed (`npx playwright install chromium`) — this
  // MUST tolerate both outcomes, never hard-require Chromium in CI/smoke.
  const rawRender = await callRaw("render_snapshot", { path: model });
  const render = JSON.parse(rawRender.content[0].text);
  if (render.supported) {
    // The JSON text block deliberately summarizes images as {label,mimeType}
    // (base64 omitted so the text payload doesn't double in size) — the
    // actual base64 pixel data only lives in the raw tool result's separate
    // `image` content blocks.
    assert(render.images.length === 4, `render_snapshot returns 4 images (got ${render.images.length})`);
    assert(
      render.images.every((img) => img.mimeType === "image/png" && !("dataBase64" in img)),
      "render_snapshot's JSON text summary omits base64 (label/mimeType only)"
    );
    const imageBlocks = rawRender.content.filter((c) => c.type === "image");
    assert(imageBlocks.length === 4, "render_snapshot's raw tool result carries 4 image content blocks");
    assert(
      imageBlocks.every((b) => b.mimeType === "image/png" && b.data.length > 1000),
      "render_snapshot's image content blocks carry non-trivial base64 PNG data"
    );
    const firstBytes = Buffer.from(imageBlocks[0].data, "base64");
    assert(
      firstBytes[0] === 0x89 && firstBytes[1] === 0x50 && firstBytes[2] === 0x4e && firstBytes[3] === 0x47,
      "render_snapshot's first image has a real PNG signature"
    );
  } else {
    assert(
      /playwright|chromium/i.test(render.warnings?.[0] ?? ""),
      `render_snapshot gracefully reports unavailable renderer (got: ${render.warnings?.[0]})`
    );
    console.log("  (Playwright/Chromium not installed in this environment — render_snapshot's supported:true path was not exercised)");
  }

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

  // meshio++ integration: a VTK source (meshio-only format, no OCCT/gmsh-native
  // reader) is meshable headless via a host-side STL-boundary conversion, and
  // a generated mesh can be re-encoded to formats gmsh-wasm's own writer can't
  // produce (MED/CGNS/XDMF) via the same meshio module.
  const vtkModel = path.join(dir, "tet.vtk");
  fs.writeFileSync(
    vtkModel,
    "# vtk DataFile Version 3.0\ntet\nASCII\nDATASET UNSTRUCTURED_GRID\n" +
      "POINTS 4 float\n0 0 0\n1 0 0\n0 1 0\n0 0 1\nCELLS 1 5\n4 0 1 2 3\nCELL_TYPES 1\n10\n"
  );
  const vtkLoaded = await call("load_model", { path: vtkModel });
  assert(vtkLoaded.strategy === "meshio" && vtkLoaded.tree === null, "load_model routes .vtk through meshio, route info only");
  assert(vtkLoaded.warnings[0].includes("meshable via generate_mesh"), "load_model notes the .vtk source IS meshable headless");

  const vtkMeshed = await call("generate_mesh", { path: vtkModel, options: { sizeMax: 0.5 } });
  assert(vtkMeshed.nodeCount > 0 && vtkMeshed.elementCount > 0, `generate_mesh on a meshio-only .vtk source: ${vtkMeshed.nodeCount} nodes, ${vtkMeshed.elementCount} elements`);

  const medOut = path.join(dir, "tet.med");
  const medResult = await call("export_mesh", { path: vtkModel, format: "med", outputPath: medOut, options: { sizeMax: 0.5 } });
  assert(medResult.written.length === 1 && fs.statSync(medOut).size > 0, "export_mesh med (meshio bridge) writes a non-empty file");

  const cgnsOut = path.join(dir, "tet.cgns");
  const cgnsResult = await call("export_mesh", { path: vtkModel, format: "cgns", outputPath: cgnsOut, options: { sizeMax: 0.5, dimension: 3 } });
  assert(cgnsResult.written.length === 1 && fs.statSync(cgnsOut).size > 0, "export_mesh cgns (meshio bridge, 3D volume mesh) writes a non-empty file");

  const xdmfOut = path.join(dir, "tet.xdmf");
  const xdmfResult = await call("export_mesh", { path: vtkModel, format: "xdmf", outputPath: xdmfOut, options: { sizeMax: 0.5 } });
  assert(xdmfResult.written.length === 2, "export_mesh xdmf (meshio bridge) writes the .xdmf + .h5 companion pair");
  const xdmfText = fs.readFileSync(xdmfOut, "utf8");
  assert(xdmfText.includes("tet.h5"), "xdmf's embedded HDF references are rewritten to the companion's real filename");
  assert(fs.statSync(path.join(dir, "tet.h5")).size > 0, "HDF5 companion has content");

  await call("set_part", { path: model, name: "Bull", volumes: ["solid-0"] });

  // MED export on a model WITH a part — exercises the group-preserving bridge
  // path end-to-end (gmsh physical group → MSH 4.1 $Entities → meshio++ 9.7.0
  // regions → merge([mesh]) block consolidation → MED families). If any step
  // of that chain throws (the pre-9.7.0 $Entities error, MED's Python-fallback
  // trip, or the same-cell-type-sections rejection), this call fails.
  const bullMedOut = path.join(dir, "bull.med");
  const bullMed = await call("export_mesh", { path: model, format: "med", outputPath: bullMedOut, options: { sizeMax: bbox.diagonal / 15 } });
  assert(
    bullMed.written.length === 1 && fs.statSync(bullMedOut).size > 0,
    "export_mesh med on a model with a part (meshio bridge, groups preserved) writes a non-empty file"
  );

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
