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

/** Like `call`, but an `isError` result is reported as `{error}` instead of
 * `callRaw`'s usual fail()-and-exit — for call sites that expect SOME calls
 * in a loop/sequence to legitimately fail (e.g. scanning edges for the one
 * that's circular) and need to inspect the error rather than abort the
 * whole smoke run on the first non-matching one. */
async function callTolerant(name, args) {
  const result = await request("tools/call", { name, arguments: args });
  if (result.isError) return { error: result.content?.[0]?.text ?? "" };
  return { value: JSON.parse(result.content?.[0]?.text ?? "") };
}

/** Max absolute coordinate magnitude across every node in a Gmsh MSH 4.1
 * `$Nodes` block — a cheap proxy for "how big is this mesh's geometry" used
 * to verify export_mesh's unit conversion produced a REAL geometric scale,
 * not just a label. MSH 4.1 node blocks interleave a run of node TAGS (one
 * bare integer per line) followed by a run of coordinate lines (exactly 3
 * floats) per entity — filtering for lines with exactly 3 whitespace-
 * separated float-parseable tokens cleanly distinguishes coordinate lines
 * from both the single-integer tag lines and the 4-token block header lines. */
function maxAbsMshCoord(mshText) {
  const body = mshText.split("$Nodes")[1]?.split("$EndNodes")[0] ?? "";
  let max = 0;
  for (const line of body.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length !== 3) continue;
    const nums = tokens.map(Number);
    if (nums.some((n) => Number.isNaN(n))) continue;
    for (const n of nums) max = Math.max(max, Math.abs(n));
  }
  return max;
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
  assert(tools.length === 22, `tools/list exposes 22 tools (got ${tools.length}: ${tools.join(", ")})`);

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

  // measure_exact (roadmap "Exact-precision measurement"): a genuine host
  // round trip against the live OCCT shape — BRepExtrema_DistShapeShape for
  // distance, BRepAdaptor_Curve for radius/edgeLength — distinct from both
  // `measure`'s bbox-centre convention above and the interactive viewer's
  // triangulated-approximation Measure tool.
  const exactDist = await call("measure_exact", { path: model, kind: "distance", entityIdA: "solid-0", entityIdB: "solid-1" });
  assert(
    exactDist.supported === true && exactDist.value > 0 && Array.isArray(exactDist.fromPoint) && Array.isArray(exactDist.toPoint),
    `measure_exact reports a real geometric distance + nearest points between solid-0 and solid-1 (got ${exactDist.value})`
  );

  // A cylinder with a known radius, added specifically to verify radius/
  // edgeLength against an exact expected value (not just "the call didn't
  // throw") — its circular rim edge is found by scanning the new edge count
  // (measure_exact rejects non-circular edges by design), not a hardcoded
  // index, so this stays robust against edge-numbering shifts. Uses its OWN
  // copy of the fixture (not the shared `model`) so this extra solid doesn't
  // throw off the solid/edge counts every later step in this script assumes.
  const radiusTestModel = path.join(dir, "bull-for-radius-test.stp");
  fs.copyFileSync(FIXTURE, radiusTestModel);
  const knownRadius = s / 4;
  const cylApplied = await call("apply_edit_ops", {
    path: radiusTestModel,
    ops: [{ op: "addCylinder", center: [bbox.max[0] + 3 * s, 0, 0], radius: knownRadius, height: s, axis: [0, 0, 1] }],
  });
  assert(cylApplied.applied === 1, "apply_edit_ops accepts the cylinder for measure_exact radius verification");
  let cylinderRadiusFound = null;
  for (let i = 0; i < cylApplied.model.edgeCount; i++) {
    // Tolerant call: most edges are non-circular (an expected MCP tool-level
    // error, not a protocol failure) — `callTolerant` reports that as
    // `{error}` instead of `callRaw`'s usual fail()-on-isError, so the loop
    // can just skip past it.
    const r = await callTolerant("measure_exact", { path: radiusTestModel, kind: "radius", entityIdA: `edge-${i}` });
    if (r.error || Math.abs(r.value.value - knownRadius) > 1e-6) continue;
    cylinderRadiusFound = r.value;
    const len = await call("measure_exact", { path: radiusTestModel, kind: "edgeLength", entityIdA: `edge-${i}` });
    assert(
      Math.abs(len.value - 2 * Math.PI * knownRadius) < 1e-6,
      `measure_exact edgeLength on the cylinder's rim matches its circumference exactly (2*pi*r = ${(2 * Math.PI * knownRadius).toFixed(6)}, got ${len.value})`
    );
    break;
  }
  assert(
    cylinderRadiusFound !== null,
    `measure_exact radius finds the cylinder's rim edge and resolves its exact radius (expected ${knownRadius})`
  );

  // Error paths degrade to a clear, actionable error, never a meaningless number.
  const distanceWithoutB = await callTolerant("measure_exact", { path: model, kind: "distance", entityIdA: "solid-0" });
  assert(
    distanceWithoutB.error && /entityIdB/.test(distanceWithoutB.error),
    "measure_exact distance without entityIdB fails with a clear, actionable error"
  );
  const nonCircular = await callTolerant("measure_exact", { path: model, kind: "radius", entityIdA: "edge-0" });
  assert(
    nonCircular.error && /not a circular arc/.test(nonCircular.error),
    "measure_exact radius on a non-circular edge fails with a clear, actionable error rather than a meaningless best-fit number"
  );

  // Entity-id rebinding after topology-changing ops (roadmap item, closed) —
  // a Part referencing face-N/edge-N ids used to silently lose them once a
  // later topology-changing op renumbered the tessellation. Verified against
  // the real WASM with a fully-controlled, deterministic scenario: add a
  // detached box (a brand-new solid, appended AFTER the bull in explorer
  // order) and assign a Part to one of ITS OWN faces, then fillet an edge of
  // the (unrelated) bull — a successful fillet adds a new face to the bull's
  // own topology, shifting every id that comes after it in the compound
  // (including the box's). The box's face is geometrically untouched by any
  // of this, so the rebind pass must find it again under its new id. Own
  // fixture copy — this deliberately corrupts the rebindModel's op stack
  // with a handful of no-op fillet attempts (see below), so it must not be
  // the shared `model` other steps in this script depend on.
  const rebindModel = path.join(dir, "bull-for-rebind-test.stp");
  fs.copyFileSync(FIXTURE, rebindModel);
  const rebindAdd = await call("apply_edit_ops", {
    path: rebindModel,
    ops: [{ op: "addBox", center: [bbox.max[0] + 3 * s, 0, 0], size: [s, s, s] }],
  });
  const boxSolid = rebindAdd.model.solids[rebindAdd.model.solids.length - 1];
  assert(boxSolid.faceIds.length === 6, `the added box tessellates to 6 faces (got ${boxSolid.faceIds.length})`);
  const targetFace = boxSolid.faceIds[0];
  const beforeFacts = await call("inspect", { path: rebindModel, entityId: targetFace });
  assert(beforeFacts.supported === true, `inspect resolves the box's own face (${targetFace}) before the fillet`);

  await call("set_part", { path: rebindModel, name: "RebindTest", surfaces: [targetFace] });

  // Try a handful of the bull's own edges with a tiny fillet radius (small
  // relative to model scale, to maximize the odds any given edge accepts
  // it) until one genuinely adds a face to the bull's own topology — a
  // silently-skipped fillet (radius too large for that particular edge)
  // wouldn't exercise the rebind path at all, so this keeps trying rather
  // than trusting edge-0 blindly. Failed attempts are harmless leftover
  // no-op ops in rebindModel's own sidecar, never removed (this fixture is
  // single-purpose and discarded with the rest of `dir` at the end).
  const tinyRadius = bbox.diagonal / 5000;
  const bullBaselineFaceCount = rebindAdd.model.solids[0].faceIds.length;
  let filletResult = null;
  for (let i = 0; i < 8 && !filletResult; i++) {
    const attempt = await callTolerant("apply_edit_ops", {
      path: rebindModel,
      ops: [{ op: "fillet", edges: [`edge-${i}`], radius: tinyRadius }],
    });
    if (attempt.error) continue;
    if (attempt.value.model.solids[0].faceIds.length > bullBaselineFaceCount) filletResult = attempt.value;
  }
  assert(filletResult !== null, "found a bull edge whose fillet genuinely adds a face to the bull's own topology");

  const state = await call("get_state", { path: rebindModel });
  const rebindPart = state.parts.find((p) => p.name === "RebindTest");
  assert(rebindPart !== undefined, "the RebindTest part still exists after the fillet");
  assert(
    rebindPart.surfaces.length === 1,
    `the part's face reference survived the fillet as exactly one id (got ${JSON.stringify(rebindPart.surfaces)})`
  );
  const afterFace = rebindPart.surfaces[0];
  const afterFacts = await call("inspect", { path: rebindModel, entityId: afterFace });
  assert(afterFacts.supported === true, `inspect resolves the rebound face id (${afterFace}) after the fillet`);
  const centreDelta = Math.hypot(
    afterFacts.center[0] - beforeFacts.center[0],
    afterFacts.center[1] - beforeFacts.center[1],
    afterFacts.center[2] - beforeFacts.center[2]
  );
  const areaDelta = Math.abs(afterFacts.area - beforeFacts.area);
  assert(
    centreDelta < 1e-6 && areaDelta < 1e-6,
    `the rebound face (${targetFace} -> ${afterFace}) is geometrically identical to the box's original face ` +
      `(centre delta ${centreDelta.toExponential(2)}, area delta ${areaDelta.toExponential(2)})`
  );
  assert(
    filletResult.warnings.some((w) => /Rebound/.test(w)),
    `apply_edit_ops surfaces a rebind summary warning (got: ${JSON.stringify(filletResult.warnings)})`
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

  // compare_models: OBJ/PLY support (roadmap item, closed). examples/OBJ/cube.obj
  // and examples/PLY/cube.ply are both a real unit cube (volume 1) — pure
  // host-side parsers (objParser.ts/plyParser.ts), no WASM involved for
  // either side.
  const cubeObj = path.join(dir, "cube.obj");
  fs.copyFileSync(path.join(ROOT, "examples", "OBJ", "cube.obj"), cubeObj);
  const objSelfDiff = await call("compare_models", { pathA: cubeObj, pathB: cubeObj });
  assert(objSelfDiff.supported === true, "compare_models supports OBJ sources");
  assert(
    objSelfDiff.diff.matched.length === 1 && objSelfDiff.diff.added.length === 0 && objSelfDiff.diff.removed.length === 0,
    `compare_models(cube.obj, cube.obj): 1 matched, 0 added, 0 removed — got matched=${objSelfDiff.diff.matched.length} added=${objSelfDiff.diff.added.length} removed=${objSelfDiff.diff.removed.length}`
  );
  assert(
    Math.abs(objSelfDiff.diff.matched[0].a.volume - 1) < 1e-4,
    `compare_models resolves the OBJ cube's real volume (1) — got ${objSelfDiff.diff.matched[0].a.volume}`
  );

  const cubePly = path.join(dir, "cube.ply");
  fs.copyFileSync(path.join(ROOT, "examples", "PLY", "cube.ply"), cubePly);
  const plySelfDiff = await call("compare_models", { pathA: cubePly, pathB: cubePly });
  assert(plySelfDiff.supported === true, "compare_models supports PLY sources");
  assert(
    Math.abs(plySelfDiff.diff.matched[0].a.volume - 1) < 1e-4,
    `compare_models resolves the PLY cube's real volume (1) — got ${plySelfDiff.diff.matched[0].a.volume}`
  );

  // Cross-format: OBJ vs PLY directly, and both against the STEP bull — the
  // exact-same mixed-source dispatch path the STL case already confirmed,
  // now covering the two newer parsers too.
  const objVsPly = await call("compare_models", { pathA: cubeObj, pathB: cubePly });
  assert(
    objVsPly.supported === true && objVsPly.formatA === "obj" && objVsPly.formatB === "ply",
    "compare_models diffs an OBJ source against a PLY source directly"
  );
  const bullVsObj = await call("compare_models", { pathA: model, pathB: cubeObj });
  assert(bullVsObj.supported === true, "compare_models diffs a B-rep source against an OBJ source");

  // glTF remains unsupported headless (no host-side parser, by design — see
  // CLAUDE.md) — confirms it still degrades to a clear message, not a crash
  // (a normal supported:false response, not a tool error), now that OBJ/PLY
  // are supported alongside it in the same format family.
  const gltfRejected = await call("compare_models", { pathA: model, pathB: path.join(ROOT, "examples", "GLTF", "cube.gltf") });
  assert(
    gltfRejected.supported === false && /STEP\/IGES\/BREP\/STL\/OBJ\/PLY/i.test(gltfRejected.warnings?.[0] ?? ""),
    `compare_models still rejects glTF with a clear message, not a crash (got: ${JSON.stringify(gltfRejected)})`
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

  // Unit conversion for export_mesh (roadmap item, closed) — a REAL geometric
  // scale applied BEFORE Gmsh ever sees the geometry (mirroring export_brep's
  // unit param). `options` stays in the SAME native-mm numeric space as the
  // plain mm export above — the tool itself rescales sizeMin/sizeMax to match
  // internally (scaleMeshOptionsForUnit); pre-dividing here too would double-
  // scale it into an absurdly fine mesh (confirmed the hard way: this exact
  // mistake once made this call stall past the 300s client timeout instead of
  // erroring, since the "size too small" degenerate case is slow, not a
  // clean failure). Verified against the live WASM by comparing the two
  // exported .msh files' own node coordinate magnitudes, not just trusting
  // the tool didn't throw.
  const mshInOut = path.join(dir, "out-in.msh");
  const mshIn = await call("export_mesh", {
    path: model,
    format: "msh",
    outputPath: mshInOut,
    unit: "in",
    options: { sizeMax: bbox.diagonal / 15 },
  });
  assert(mshIn.warnings.length === 0, "export_mesh unit=in produces no warnings for a B-rep source");
  const mmMax = maxAbsMshCoord(msh);
  const inMax = maxAbsMshCoord(fs.readFileSync(mshInOut, "utf8"));
  assert(mmMax > 0 && inMax > 0, "both exported .msh files have real node coordinates to compare");
  assert(
    Math.abs(inMax / mmMax - 1 / 25.4) < 0.02,
    `export_mesh unit=in scales node coordinates by ~1/25.4 (mm max ${mmMax.toFixed(3)}, in max ${inMax.toFixed(3)}, ratio ${(inMax / mmMax).toFixed(5)})`
  );

  const mshUnknownUnit = await call("export_mesh", {
    path: model,
    format: "msh",
    outputPath: path.join(dir, "out-badunit.msh"),
    unit: "parsec",
    options: { sizeMax: bbox.diagonal / 15 },
  });
  assert(
    mshUnknownUnit.warnings.some((w) => /unknown unit/i.test(w)),
    "export_mesh falls back to mm and warns for an unrecognized unit"
  );

  // Same unit conversion for an STL (raw-file-meshed, not OCCT re-exported)
  // source — exercises the new host-side scaleStlBytes path, not exportBRep's
  // scaleFactor. cube.stl is a 10x10x10 cube (see the compare_models section
  // above), so its own max node coordinate should sit near half the diagonal.
  const cubeMshOut = path.join(dir, "cube.msh");
  await call("export_mesh", { path: cubeStl, format: "msh", outputPath: cubeMshOut, options: { sizeMax: 5 } });
  const cubeMshInOut = path.join(dir, "cube-in.msh");
  const cubeMshIn = await call("export_mesh", {
    path: cubeStl,
    format: "msh",
    outputPath: cubeMshInOut,
    unit: "in",
    options: { sizeMax: 5 }, // same native-mm value as the mm export above — see the B-rep case's comment
  });
  assert(cubeMshIn.warnings.length === 0, "export_mesh unit=in produces no warnings for an STL source");
  const cubeMmMax = maxAbsMshCoord(fs.readFileSync(cubeMshOut, "utf8"));
  const cubeInMax = maxAbsMshCoord(fs.readFileSync(cubeMshInOut, "utf8"));
  assert(cubeMmMax > 0 && cubeInMax > 0, "both exported STL-sourced .msh files have real node coordinates to compare");
  assert(
    Math.abs(cubeInMax / cubeMmMax - 1 / 25.4) < 0.02,
    `export_mesh unit=in scales an STL source's node coordinates by ~1/25.4 too (mm max ${cubeMmMax.toFixed(3)}, in max ${cubeInMax.toFixed(3)}, ratio ${(cubeInMax / cubeMmMax).toFixed(5)})`
  );

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

  // Richer meshio++ import visibility (roadmap item, partly closed): a real
  // MED file (examples/MED/two-material-tets.med — two tetrahedra, each its
  // own named cell region "MaterialA"/"MaterialB", plus a "Temperature"
  // point-data field, written by meshio++'s own MED writer from a hand-built
  // mesh) declares metadata `readMeshioMetadata()` (readMetadata()-backed)
  // can now see, even though it's still informational only — not yet
  // auto-converted into Parts/geometry, see CLAUDE.md's "meshio++
  // integration" section.
  const medFixture = path.join(dir, "two-material-tets.med");
  fs.copyFileSync(path.join(ROOT, "examples", "MED", "two-material-tets.med"), medFixture);
  const medLoaded = await call("load_model", { path: medFixture });
  assert(medLoaded.strategy === "meshio", "load_model routes .med through meshio too");
  const metadataWarning = medLoaded.warnings.find((w) => /also declares/i.test(w));
  assert(
    metadataWarning && /MaterialA/.test(metadataWarning) && /MaterialB/.test(metadataWarning) && /Temperature/.test(metadataWarning),
    `load_model surfaces the MED file's real region names + point-data field name (got: ${JSON.stringify(medLoaded.warnings)})`
  );
  // Still geometry-only under the hood — the region/data visibility above is
  // additive, not a replacement for the existing STL-boundary mesh path.
  const medMeshed = await call("generate_mesh", { path: medFixture, options: { sizeMax: 0.5 } });
  assert(medMeshed.nodeCount > 0 && medMeshed.elementCount > 0, `generate_mesh still works on the MED source: ${medMeshed.nodeCount} nodes, ${medMeshed.elementCount} elements`);
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
