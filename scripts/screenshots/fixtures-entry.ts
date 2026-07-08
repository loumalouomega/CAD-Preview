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
import { loadBRep } from "../../src/occtService";
import { generateMesh, type MeshGenerationInput } from "../../src/gmshService";
import { encodeBuffer, type Part } from "../../src/protocol";
import { DEFAULT_MESH_OPTIONS } from "../../src/meshOptions";
import { viewerBodyHtml } from "../../src/viewerDom";

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

  writeJson("meta.json", { model: path.basename(MODEL), diagonal: diag, generatedAt: new Date().toISOString() });
  console.log("Fixtures ready.");
}

main().catch((err) => {
  console.error("Fixture generation failed:", err);
  process.exit(1);
});
