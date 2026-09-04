/**
 * Fixture generator for the docs screenshot harness (see README in this folder).
 *
 * Runs the REAL extension-host geometry pipeline in plain Node — OpenCascade
 * (OCCT) tessellation + Gmsh meshing — against an example model, and writes the
 * exact `HostToWebview` message payloads (`geometry`, `tree`, `meshingResult`,
 * `meshingOptions`) the extension would post, plus small realistic `parts` and
 * `edits` payloads, as JSON files under `fixtures/`. `capture.mjs` then posts
 * these into the live webview bundle so screenshots show genuine geometry, not
 * mock data.
 *
 * This file is bundled by `make-fixtures.mjs` (esbuild, platform=node) so its
 * `import`s of the `src/` host modules resolve exactly as the shipped extension
 * bundles them (`vscode` is never imported by these modules — verified).
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { loadBRep, exportBRep } from "../../src/occtService";
import { generateMesh, type MeshGenerationInput } from "../../src/gmshService";
import { encodeBuffer, type Part } from "../../src/protocol";
import { DEFAULT_MESH_OPTIONS } from "../../src/meshOptions";
import { viewerBodyHtml } from "../../src/viewerDom";
import { MESH_EXPORT_FORMATS } from "../../src/meshExportFormats";

// This entry is bundled into `.build/` before running, so `import.meta.url`
// can't locate the repo. It is always launched from the repo root (the
// `docs:screenshots` npm script / make-fixtures.mjs), so anchor on cwd. Used as
// the OCCT/Gmsh `extensionPath` (they read the WASM from `<root>/dist/*.wasm`).
const ROOT = process.cwd();
const OUT = path.join(ROOT, "scripts", "screenshots", "fixtures");
const MODEL = path.join(ROOT, "examples", "STP", "bull.stp");

function writeJson(name: string, value: unknown): void {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(value));
  const kb = (fs.statSync(path.join(OUT, name)).size / 1024).toFixed(0);
  console.log(`  wrote ${name} (${kb} KB)`);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`Fixture model: ${path.relative(ROOT, MODEL)}`);

  // The shared, real viewer DOM (single source of truth) for the harness page.
  fs.writeFileSync(path.join(OUT, "body.html"), viewerBodyHtml());
  console.log("  wrote body.html");

  // The export-format registry, as the webview's own `<select>` should end up
  // reflecting it. Emitted here — rather than read by the assertion runner —
  // because this entry is the one place in the screenshot toolchain that can
  // import TypeScript from `src/`; the runner is a plain `.mjs` and cannot.
  // This is what lets `webview-test` assert the picker against the REAL
  // registry instead of a hand-copied list that would drift from it.
  writeJson("registry.json", {
    meshExportFormats: MESH_EXPORT_FORMATS.map((f) => ({ id: f.id, label: f.label, via: f.via })),
  });

  const bytes = new Uint8Array(fs.readFileSync(MODEL));

  // --- Geometry + tree (real OCCT tessellation) --------------------------
  const { groups, edges, points, tree } = await loadBRep(ROOT, bytes, "step");

  const geometry = {
    type: "geometry" as const,
    meshes: groups.flatMap((g) =>
      g.faces.map((f) => ({
        positions: encodeBuffer(f.buffers.positions),
        indices: encodeBuffer(f.buffers.indices),
        groupId: g.id,
        faceId: f.faceId,
      }))
    ),
    edges: edges.map((e) => ({ positions: encodeBuffer(e.positions), edgeId: e.edgeId })),
    points: points.map((p) => ({ position: encodeBuffer(new Float32Array(p.position)), pointId: p.pointId })),
  };
  writeJson("geometry.json", geometry);
  writeJson("tree.json", { type: "tree", root: tree });

  // Model bbox diagonal → a sensible mesh size (mirrors the panel's default).
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const g of groups) {
    for (const f of g.faces) {
      const p = f.buffers.positions;
      for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (p[i + k] < min[k]) min[k] = p[i + k];
          if (p[i + k] > max[k]) max[k] = p[i + k];
        }
      }
    }
  }
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  console.log(`  bbox diagonal ≈ ${diag.toFixed(2)}`);

  // --- Parts (reference REAL ids so the viewer recolours) ----------------
  const faceIds = groups.flatMap((g) => g.faces.map((f) => f.faceId));
  const edgeIds = edges.map((e) => e.edgeId);
  const parts: Part[] = [
    { name: "Body", color: "#4f8cff", volumes: [groups[0].id], surfaces: [], lines: [], points: [] },
    {
      name: "Contact faces",
      color: "#ff8c42",
      volumes: [],
      surfaces: faceIds.slice(0, Math.min(4, faceIds.length)),
      lines: [],
      points: [],
      meshSize: +(diag / 45).toFixed(4),
    },
    { name: "Feature edges", color: "#38c172", volumes: [], surfaces: [], lines: edgeIds.slice(0, Math.min(6, edgeIds.length)), points: [] },
  ];
  writeJson("parts.json", { type: "parts", parts });

  // --- Edits + variables (small, valid, illustrative) --------------------
  const edits = {
    type: "edits" as const,
    ops: [
      { op: "addBox", center: [0, 0, 0], size: [20, 10, 5], exprs: { "size[0]": "L", "size[1]": "H" } },
      { op: "addCylinder", center: [30, 0, 0], axis: [0, 0, 1], radius: 6, height: 20 },
      { op: "translate", targets: [groups[0].id], vec: [0, 0, 10] },
    ],
    variables: [
      { name: "L", expr: "20", value: 20 },
      { name: "H", expr: "L / 2", value: 10 },
    ],
  };
  writeJson("edits.json", edits);

  // --- Meshing options (seeded like the panel) ---------------------------
  const options = { ...DEFAULT_MESH_OPTIONS, sizeMax: +(diag / 14).toFixed(4) };
  writeJson("meshingOptions.json", { type: "meshingOptions", options });

  // --- Generated FE mesh (real Gmsh run, parts → physical groups) --------
  console.log("  running Gmsh (this is the slow step)…");
  const input: MeshGenerationInput = { kind: "brep", stepBytes: bytes };
  const startedAt = Date.now();
  const result = await generateMesh(ROOT, input, options, parts);
  const elapsedMs = Date.now() - startedAt;
  console.log(`  mesh: ${result.nodeCount} nodes, ${result.elementCount} elements in ${elapsedMs} ms`);
  writeJson("meshingResult.json", {
    type: "meshingResult",
    positions: encodeBuffer(result.positions),
    indices: encodeBuffer(result.indices),
    edges: encodeBuffer(result.edges),
    elementGroups: result.elementGroups,
    nodeCount: result.nodeCount,
    elementCount: result.elementCount,
    elapsedMs,
  });

  // --- Tutorial step fixtures (roadmap Tier 3 item 4) ----------------------
  // Every tutorial starts from block.stp (not bull.stp) and its op-list ids
  // were probed live (pinned in scripts/mcp-smoke/run.mjs). Each entry below
  // is a cumulative prefix of its page's "Full operation list", tessellated
  // via the already-4-parameter loadBRep — no new kernel surface.
  const BLOCK = path.join(ROOT, "examples", "STP", "block.stp");
  const blockBytes = new Uint8Array(fs.readFileSync(BLOCK));
  const bracketOps = [
    { op: "addBox", center: [0, 0, 0], size: [60, 40, 6] },
    { op: "addBox", center: [0, -17, 18], size: [60, 6, 30] },
    { op: "boolean", kind: "union", a: ["solid-1"], b: ["solid-2"] },
    { op: "fillet", edges: ["edge-13"], radius: 4 },
    { op: "addCounterboreHole", targets: ["solid-0"], position: [-22, 10, 3], axis: [0, 0, -1], radius: 3, depth: 6, cbRadius: 5, cbDepth: 2 },
    { op: "addCounterboreHole", targets: ["solid-0"], position: [22, 10, 3], axis: [0, 0, -1], radius: 3, depth: 6, cbRadius: 5, cbDepth: 2 },
  ];
  const flangeToolOps = [
    { op: "addCylinder", center: [0, 0, -5], axis: [0, 0, 1], radius: 40, height: 10 },
    { op: "addCylinder", center: [30, 0, -10], axis: [0, 0, 1], radius: 3, height: 20 },
    { op: "patternCircular", targets: ["solid-2"], axisPoint: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 45, count: 8 },
  ];
  const flangeDoneOps = [
    ...flangeToolOps,
    { op: "boolean", kind: "subtract", a: ["solid-1"], b: ["solid-2", "solid-3", "solid-4", "solid-5", "solid-6", "solid-7", "solid-8", "solid-9"] },
  ];
  const enclosureSketchOps = [
    { op: "addRectangleProfile", center: [0, 0, -3], normal: [0, 0, 1], up: [0, 1, 0], width: 80, height: 60 },
  ];
  const enclosureExtrudedOps = [
    ...enclosureSketchOps,
    { op: "extrude", profile: "face-6", dir: [0, 0, 1], length: 48 },
  ];
  const enclosureDoneOps = [
    ...enclosureExtrudedOps,
    { op: "shell", thickness: -6, openingFaces: ["face-11"] },
  ];
  const tutorialSteps: Array<{ name: string; ops: unknown[] }> = [
    { name: "tutorial-bracket-fused", ops: bracketOps.slice(0, 3) },
    { name: "tutorial-bracket-done", ops: bracketOps },
    { name: "tutorial-flange-tools", ops: flangeToolOps },
    { name: "tutorial-flange-done", ops: flangeDoneOps },
    { name: "tutorial-enclosure-sketch", ops: enclosureSketchOps },
    { name: "tutorial-enclosure-extruded", ops: enclosureExtrudedOps },
    { name: "tutorial-enclosure-done", ops: enclosureDoneOps },
  ];
  for (const step of tutorialSteps) {
    const r = await loadBRep(ROOT, blockBytes, "step", step.ops as never[]);
    writeJson(`${step.name}-geometry.json`, {
      type: "geometry",
      meshes: r.groups.flatMap((g) =>
        g.faces.map((f) => ({
          positions: encodeBuffer(f.buffers.positions),
          indices: encodeBuffer(f.buffers.indices),
          groupId: g.id,
          faceId: f.faceId,
        }))
      ),
      edges: r.edges.map((e) => ({ positions: encodeBuffer(e.positions), edgeId: e.edgeId })),
      points: r.points.map((p) => ({ position: encodeBuffer(new Float32Array(p.position)), pointId: p.pointId })),
    });
    writeJson(`${step.name}-tree.json`, { type: "tree", root: r.tree });
    console.log(`  tutorial fixture: ${step.name} (${r.groups.length} solids)`);
  }

  // FEA-prep overlay: the finished bracket meshed at the tutorial's own
  // Size max = 4, so the shot shows the overlay the reader gets.
  console.log("  running Gmsh for the tutorial bracket (fea-prep shot)…");
  const bracketStepBytes = await exportBRep(ROOT, blockBytes, "step", "step", bracketOps as never[]);
  const tutorialMeshInput: MeshGenerationInput = { kind: "brep", stepBytes: bracketStepBytes };
  const tutorialMeshOptions = { ...DEFAULT_MESH_OPTIONS, sizeMax: 4 };
  const tutorialMeshStartedAt = Date.now();
  const tutorialMesh = await generateMesh(ROOT, tutorialMeshInput, tutorialMeshOptions, []);
  console.log(`  tutorial mesh: ${tutorialMesh.nodeCount} nodes, ${tutorialMesh.elementCount} elements in ${Date.now() - tutorialMeshStartedAt} ms`);
  writeJson("tutorial-fea-meshingResult.json", {
    type: "meshingResult",
    positions: encodeBuffer(tutorialMesh.positions),
    indices: encodeBuffer(tutorialMesh.indices),
    edges: encodeBuffer(tutorialMesh.edges),
    elementGroups: tutorialMesh.elementGroups,
    nodeCount: tutorialMesh.nodeCount,
    elementCount: tutorialMesh.elementCount,
    elapsedMs: Date.now() - tutorialMeshStartedAt,
  });

  writeJson("meta.json", { model: path.basename(MODEL), diagonal: diag, generatedAt: new Date().toISOString() });
  console.log("Fixtures ready.");
}

main().catch((err) => {
  console.error("Fixture generation failed:", err);
  process.exit(1);
});
