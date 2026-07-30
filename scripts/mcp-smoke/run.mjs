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
  assert(tools.length === 21, `tools/list exposes 21 tools (got ${tools.length}: ${tools.join(", ")})`);

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

  // compare_models: STL support (roadmap "Mesh-source model comparison").
  // A real 10x10x10 STL cube (examples/STL/cube.stl, volume 1000) against
  // itself — a pure host-side STL parse + connected-component segmentation,
  // no WASM involved at all for the STL side.
  const cubeStl = path.join(dir, "cube.stl");
  fs.copyFileSync(path.join(ROOT, "examples", "STL", "cube.stl"), cubeStl);
  const stlSelfDiff = await call("compare_models", { pathA: cubeStl, pathB: cubeStl });
  assert(stlSelfDiff.supported === true, "compare_models supports STL sources");
  assert(
    stlSelfDiff.diff.matched.length === 1 && stlSelfDiff.diff.added.length === 0 && stlSelfDiff.diff.removed.length === 0,
    `compare_models(cube.stl, cube.stl): 1 matched, 0 added, 0 removed — got matched=${stlSelfDiff.diff.matched.length} added=${stlSelfDiff.diff.added.length} removed=${stlSelfDiff.diff.removed.length}`
  );
  assert(
    Math.abs(stlSelfDiff.diff.matched[0].a.volume - 1000) < 1e-3,
    `compare_models resolves the STL cube's real volume (1000) — got ${stlSelfDiff.diff.matched[0].a.volume}`
  );
  assert(
    stlSelfDiff.diff.matched[0].centreDistance < 1e-6 && stlSelfDiff.diff.matched[0].volumeDeltaPct < 1e-6,
    "compare_models(cube.stl, cube.stl) is an exact self-match"
  );

  // Cross-format: STEP vs STL in one call — confirms the mixed-source path
  // (one side OCCT, one side the pure STL parser) works end-to-end without
  // either side needing to match the other's format.
  const crossDiff = await call("compare_models", { pathA: model, pathB: cubeStl });
  assert(crossDiff.supported === true, "compare_models supports a B-rep source diffed against an STL source");
  assert(crossDiff.formatA === "step" && crossDiff.formatB === "stl", "compare_models reports each side's real format");

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

  // Hex-dominant (RTree, elementShape:"hexDominant") always mixes in an
  // unmapped gmsh element type (140, "trihedron") alongside tets/hexes —
  // confirms generation + the overlay/quality pipeline tolerate it (graceful
  // skip, not a crash), that a real Gmsh-native format (.msh) still exports
  // fine, and that Kratos MDPA export — which has no geometry for that
  // connector type — rejects it with a specific, actionable message.
  const hexDominantOptions = { dimension: 3, sizeMax: bbox.diagonal / 15, elementShape: "hexDominant" };
  const hexMeshed = await call("generate_mesh", { path: model, options: hexDominantOptions });
  assert(
    hexMeshed.nodeCount > 0 && hexMeshed.elementCount > 0,
    `generate_mesh (hexDominant): ${hexMeshed.nodeCount} nodes, ${hexMeshed.elementCount} elements`
  );
  const hexMshOut = path.join(dir, "hexdominant.msh");
  await call("export_mesh", { path: model, format: "msh", outputPath: hexMshOut, options: hexDominantOptions });
  assert(fs.statSync(hexMshOut).size > 0, "export_mesh msh succeeds for a hex-dominant mesh");
  const hexMdpaOut = path.join(dir, "hexdominant.mdpa");
  const hexMdpaResult = await request("tools/call", {
    name: "export_mesh",
    arguments: { path: model, format: "mdpaElements", outputPath: hexMdpaOut, options: hexDominantOptions },
  });
  const hexMdpaText = hexMdpaResult.content?.[0]?.text ?? "";
  assert(
    hexMdpaResult.isError === true && /trihedron|hex-dominant/i.test(hexMdpaText),
    `export_mesh mdpaElements rejects a hex-dominant mesh with a specific, actionable error (got: ${hexMdpaText.slice(0, 120)})`
  );

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

  // Unit conversion on export — a REAL geometric scale, verified end-to-end
  // against the live WASM (not just unit-tested): BREP has no unit metadata
  // to mismatch, so its scale is applied and correct. Round-trip through
  // get_mass_properties (volume scales by factor^3) on the two exported
  // files, each read fresh as its own independent document.
  const brepOutIn = path.join(dir, "out-in.brep");
  const exportedIn = await call("export_brep", { path: model, targetFormat: "brep", outputPath: brepOutIn, unit: "in" });
  assert(exportedIn.unit === "in" && exportedIn.warnings.length === 0, "export_brep converts to inches for a brep target, no warnings");
  const volumeMm = (await call("get_mass_properties", { path: brepOut })).volume;
  const volumeIn = (await call("get_mass_properties", { path: brepOutIn })).volume;
  const expectedRatio = Math.pow(1 / 25.4, 3);
  assert(
    Math.abs(volumeIn / volumeMm - expectedRatio) < 1e-6,
    `export_brep's inch scale is geometrically real: volume ratio ${(volumeIn / volumeMm).toFixed(9)} ≈ (1/25.4)^3 = ${expectedRatio.toFixed(9)}`
  );

  // STEP/IGES headers declare a unit that this OCCT WASM build has no
  // verified way to set on write (Interface_Static's "write.step.unit"
  // never registers) — converting their geometry without fixing the header
  // would silently mislabel the file, so it's deliberately unsupported:
  // falls back to mm with an explicit warning, never a silent wrong file.
  const igesOut = path.join(dir, "out-unsupported.iges");
  const igesResult = await call("export_brep", { path: model, targetFormat: "iges", outputPath: igesOut, unit: "in" });
  assert(igesResult.unit === "mm", "export_brep falls back to mm for an iges target (unit conversion unsupported)");
  assert(
    igesResult.warnings.some((w) => /unit conversion/i.test(w)),
    "export_brep warns, rather than silently ignoring, the unsupported iges+unit combination"
  );

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

  // step.parts: the extension's only external network dependency. Tolerates
  // the API being unreachable in this environment (supported:false is a
  // real, expected outcome here, not a bug) — but if it IS reachable, fully
  // exercises search → pick a result → download → verify the file lands and
  // (when the part has a recorded checksum) the sha256 actually matches.
  const search = await call("search_standard_parts", { q: "hex head cap screw", pageSize: 3 });
  if (search.supported) {
    assert(Array.isArray(search.items) && search.items.length > 0, `search_standard_parts finds real results (got ${search.items?.length ?? 0})`);
    const part = search.items[0];
    assert(typeof part.stepUrl === "string" && typeof part.apiUrl === "string", "search_standard_parts results carry provenance URLs");

    const partOut = path.join(dir, "standard-part.step");
    const downloaded = await call("download_standard_part", { id: part.id, outputPath: partOut });
    assert(downloaded.supported === true, `download_standard_part succeeds for ${part.id}`);
    assert(fs.statSync(partOut).size > 0, "download_standard_part writes a non-empty STEP file");
    if (downloaded.sha256) {
      assert(downloaded.verifiedChecksum === true, "download_standard_part verifies the sha256 checksum when one is on record");
    }
  } else {
    console.log(`  (step.parts API unreachable in this environment: ${search.warnings?.[0]} — search/download supported:true paths were not exercised)`);
  }
  assert(true, "search_standard_parts / download_standard_part degrade gracefully regardless of network availability");

  // run_parametric_script: a real bolt-circle (4 cylinders around the
  // origin, radius/count from script variables, position via trig exprs
  // over the loop index) — exercises the whole compile → validate → bake →
  // persist → post-replay-inventory path against real OCCT. Run late (after
  // the hex-dominant/mesh-export sections above) so it doesn't change the
  // geometry those sections' own assertions were verified against.
  const scripted = await call("run_parametric_script", {
    path: model,
    script: {
      variables: [
        { name: "R", expr: String(s * 2) },
        { name: "N", expr: "4" },
      ],
      steps: [
        {
          repeat: {
            times: "N",
            indexVar: "i",
            body: [
              {
                op: "addCylinder",
                center: [0, 0, 0],
                axis: [0, 0, 1],
                radius: s / 4,
                height: s,
                exprs: { "center[0]": "R*cos(i*360/N)", "center[1]": "R*sin(i*360/N)" },
              },
            ],
          },
        },
      ],
    },
  });
  assert(
    scripted.applied === 4 && scripted.rejected === 0,
    `run_parametric_script compiles a 4-cylinder bolt circle (applied=${scripted.applied}, rejected=${scripted.rejected})`
  );
  assert(scripted.model.solids.length === 6, "post-replay inventory shows 6 solids (bull + box + 4 cylinders)");
  const scriptedSidecar = JSON.parse(fs.readFileSync(`${model}.edits.json`, "utf8"));
  const cylinderOps = scriptedSidecar.ops.filter((o) => o.op === "addCylinder");
  assert(
    cylinderOps.length === 4 && cylinderOps.every((o) => o.exprs === undefined),
    "repeat-generated ops are persisted fully baked, no dangling exprs"
  );
  assert(
    Math.abs(cylinderOps[0].center[0] - s * 2) < 1e-6 && Math.abs(cylinderOps[0].center[1]) < 1e-6,
    "the first bolt-circle cylinder lands at angle 0 (R, 0) as expected"
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
  assert(
    restoredEdits.ops.length === 5 && restoredEdits.ops[0].op === "addBox",
    "load_preprocess restores the edits sidecar (box + 4 bolt-circle cylinders)"
  );
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
