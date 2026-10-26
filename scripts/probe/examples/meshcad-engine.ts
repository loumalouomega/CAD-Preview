/** `engine: "meshcad"` end-to-end probe through generateMesh / exportMdpa (meshio++ 17.21 meshCadSurface).
 * Run: npm run probe -- scripts/probe/examples/meshcad-engine.ts --run   (diagnostics: JSON on stderr)
 * Exit 0 means the probe completed, not that the gate passed.
 *
 * block.stp (surface area 94) and bull.stp at dimension 2: engine used, element types, the Gmsh model's
 * own summed triangle area (corner nodes only — quadratic edge nodes lie on the same planar faces), quality,
 * the MDPA the same request writes, and the downgrades/refusals.
 */
import * as fs from "fs";
import { generateMesh, exportMdpa, exportMeshFormat } from "../../../src/gmshService";
import { DEFAULT_MESH_OPTIONS, type MeshOptions } from "../../../src/meshOptions";

console.log = console.error.bind(console);

/** Triangle area from the MSH text (corner nodes of types 2/9/21). */
function mshArea(msh: string): { area: number; byType: Record<string, number>; degenerate: number } {
  const lines = msh.split("\n");
  const nodes = new Map<number, number[]>();
  let i = lines.indexOf("$Nodes") + 1;
  const [blocks] = lines[i++].split(" ").map(Number);
  for (let b = 0; b < blocks; b++) {
    const [, , , n] = lines[i++].split(" ").map(Number);
    const tags = lines.slice(i, i + n).map(Number);
    i += n;
    for (let k = 0; k < n; k++) nodes.set(tags[k], lines[i++].split(" ").map(Number));
  }
  let j = lines.indexOf("$Elements") + 1;
  const [eb] = lines[j++].split(" ").map(Number);
  let area = 0, degenerate = 0;
  const byType: Record<string, number> = {};
  for (let b = 0; b < eb; b++) {
    const [dim, , type, n] = lines[j++].split(" ").map(Number);
    for (let k = 0; k < n; k++) {
      const row = lines[j++].split(" ").map(Number).slice(1);
      if (dim !== 2) continue;
      byType[String(type)] = (byType[String(type)] ?? 0) + 1;
      const [A, B, C] = [row[0], row[1], row[2]].map((t) => nodes.get(t)!);
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const a = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
      if (a < 1e-12) degenerate++;
      area += a;
    }
  }
  return { area, byType, degenerate };
}

async function main(): Promise<void> {
  const ext = process.cwd();
  const out: Record<string, unknown> = {};
  const brep = (f: string) => ({ kind: "brep" as const, stepBytes: fs.readFileSync(f) });
  const base: MeshOptions = { ...DEFAULT_MESH_OPTIONS, engine: "meshcad", dimension: 2 };
  const cases: Array<[string, ReturnType<typeof brep>, Partial<MeshOptions>]> = [
    ["block-auto", brep("examples/STP/block.stp"), {}],
    ["block-size1", brep("examples/STP/block.stp"), { sizeMax: 1 }],
    ["block-order2", brep("examples/STP/block.stp"), { sizeMax: 1, elementOrder: 2 }],
    ["block-minAngle25", brep("examples/STP/block.stp"), { sizeMax: 1, meshcadMinAngle: 25 }],
    ["bull-size3", brep("examples/STP/bull.stp"), { sizeMax: 3 }],
    ["bull-order2", brep("examples/STP/bull.stp"), { sizeMax: 3, elementOrder: 2 }],
  ];
  for (const [name, input, o] of cases) {
    const row: Record<string, unknown> = {};
    try {
      const t0 = Date.now();
      const r = await generateMesh(ext, input, { ...base, ...o }, []);
      row.ms = Date.now() - t0;
      row.engineUsed = r.engineUsed;
      row.nodeCount = r.nodeCount;
      row.elementCount = r.elementCount;
      row.meshcad = r.meshcad && { ...r.meshcad, warnings: r.meshcad.warnings.slice(0, 2) };
      row.warnings = r.warnings.slice(0, 3);
      row.quality = r.quality ? { min: r.quality.min, mean: r.quality.mean } : null;
      row.drawnTriangles = r.indices.length / 3;
      const a = mshArea(r.mshText);
      row.area = Math.round(a.area * 1000) / 1000;
      row.mshTypes = a.byType;
      row.degenerate = a.degenerate;
      const mdpa = await exportMdpa(ext, input, { ...base, ...o }, [], "elements").catch((e: Error) => `ERR ${e.message}`);
      row.mdpa = mdpa.startsWith("ERR ") ? mdpa : { chars: mdpa.length, elementBlocks: [...new Set(mdpa.match(/Begin Elements \w+/g) ?? [])] };
    } catch (e) {
      row.error = String((e as Error)?.message ?? e).slice(0, 400);
    }
    out[name] = row;
  }
  // Downgrades and refusals.
  const block = brep("examples/STP/block.stp");
  for (const [name, input, opts] of [
    ["dim3", block, { dimension: 3 as const }],
    ["stl", { kind: "stl" as const, stlBytes: fs.readFileSync("examples/STL/cube.stl") }, {}],
    ["periodic", block, { periodic: [{ slave: "a", master: "b", translation: [1, 0, 0] as [number, number, number] }] }],
    ["quads", block, { elementShape: "subdivided" as const }],
  ] as Array<[string, any, object]>) {
    try {
      const r = await generateMesh(ext, input, { ...base, ...opts }, []);
      out[`refuse-${name}`] = { engineUsed: r.engineUsed, warnings: r.warnings };
    } catch (e) {
      out[`refuse-${name}`] = { threw: String((e as Error).message).slice(0, 200) };
    }
  }
  try {
    const msh = await exportMeshFormat(ext, block, { ...base, sizeMax: 1 }, [], "vtk" as never);
    out["export-vtk"] = { type: typeof msh, size: (msh as any)?.length ?? (msh as any)?.byteLength };
  } catch (e) { out["export-vtk"] = { threw: String((e as Error).message).slice(0, 200) }; }
  console.error(JSON.stringify(out, null, 2));
}
main().then(() => process.exit(0), () => process.exit(0));
