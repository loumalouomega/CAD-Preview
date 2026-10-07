/** Live product-pipeline regression (no temporary injected tool). */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { remeshMesh, getMeshio } from "../../../src/meshioService";
import type { Mesh } from "@meshioplusplus/wasm";
import { buildPartsFromMeshioRegions } from "../../../src/meshioRegionParts";
import { createKernelClient } from "../../../src/kernelClient";
import { DEFAULT_MESH_OPTIONS } from "../../../src/meshOptions";

console.log = console.error.bind(console);
console.info = console.error.bind(console);
console.warn = console.error.bind(console);

async function readMed(bytes: Uint8Array): Promise<Mesh> {
  const m = await getMeshio();
  m.FS.writeFile("/prod.med", bytes);
  try { return m.readMesh("/prod.med", "med"); }
  finally { m.FS.unlink("/prod.med"); }
}

function volumes(mesh: Mesh) {
  const result = new Map<string, number>([["total", 0]]);
  const groups = (mesh.regions ?? []).filter(r => r.kind === "cell").map(r => ({ name: r.name, cells: new Set(Array.from(r.entries, Number)) }));
  let offset = 0;
  for (const block of mesh.cells) {
    assert("nodesPerCell" in block);
    const count = block.data.length / block.nodesPerCell;
    if (block.type === "tetra") for (let c = 0; c < count; c++) {
      const corners = Array.from(block.data.slice(c * 4, c * 4 + 4), id => Array.from(mesh.points.slice(Number(id) * 3, Number(id) * 3 + 3)));
      const [a, b, d] = corners.slice(1).map(p => p.map((v, i) => v - corners[0][i]));
      const volume = Math.abs(a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0]) + a[2] * (b[0] * d[1] - b[1] * d[0])) / 6;
      result.set("total", result.get("total")! + volume);
      for (const group of groups) if (group.cells.has(offset + c)) result.set(group.name, (result.get(group.name) ?? 0) + volume);
    }
    offset += count;
  }
  return result;
}

async function run() {
  const bytes = readFileSync("examples/MED/two-material-tets.med");
  const kernel = createKernelClient(process.cwd());
  try {
    const result = await kernel.remeshMesh(process.cwd(), bytes, "med", { hmax: 0.6 });
    assert(result.report.outputCells > 2);
    assert.deepEqual(result.regionNames.sort(), ["MaterialA", "MaterialB"]);
    const before = volumes(await readMed(bytes)), after = volumes(await readMed(result.bytes));
    for (const [name, volume] of before) assert(Math.abs(after.get(name)! / volume - 1) < 1e-6);
    const boundary = await kernel.convertToStlBoundaryWithRegions(result.bytes, "med");
    assert(boundary.regions);
    assert.deepEqual(buildPartsFromMeshioRegions(boundary.stlBytes, boundary.regions).map(p => p.name).sort(), ["MaterialA", "MaterialB"]);
    const generated = await kernel.generateMesh(process.cwd(), { kind: "brep", stepBytes: readFileSync("examples/STP/block.stp") },
      { ...DEFAULT_MESH_OPTIONS, sizeMax: 2 },
      [{ name: "Wall", color: "#ff0000", volumes: [], surfaces: ["face-0"], lines: [], points: [] }]);
    const g = await kernel.remeshMesh(process.cwd(), Buffer.from(generated.mshText), "gmsh", { hmax: 1 });
    const gb = await kernel.convertToStlBoundaryWithRegions(g.bytes, "med");
    assert(g.regionNames.includes("Wall"));
    assert(gb.regions && buildPartsFromMeshioRegions(gb.stlBytes, gb.regions).some(p => p.name === "Wall"));
    const s = await remeshMesh(process.cwd(), readFileSync("examples/STL/large-sphere-100k.stl"), "stl", { hausd: 0.01, hausdRelative: false });
    assert(s.report.outputCells < s.report.inputCells);
    assert(s.report.wasmBytes < 256 * 1024 ** 2);
    const surface = await readMed(s.bytes);
    let maxVertexRadialError = 0;
    for (let i = 0; i < surface.points.length; i += 3) maxVertexRadialError = Math.max(maxVertexRadialError, Math.abs(Math.hypot(...surface.points.slice(i, i + 3)) - 10));
    assert(maxVertexRadialError <= 0.01);
    console.error(JSON.stringify({ volume: result.report, materialVolumes: Object.fromEntries(after), surface: s.report, maxVertexRadialError, parts: result.regionNames }));
  } finally { kernel.cancelCurrent(); }
}
run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
