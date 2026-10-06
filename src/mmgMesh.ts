/** Pure meshio ↔ MMG reference bridge. Overlapping cell regions are encoded
 * as membership combinations, so a single integer reference loses no groups. */
import type { Mesh, Region } from "@meshioplusplus/wasm";
import type { MmgMesh } from "./mmgService";

export function prepareMmgMesh(mesh: Mesh) {
  const warnings: string[] = [];
  if (mesh.dim !== 3 && mesh.dim !== 2) throw new Error("MMG requires 2D or 3D point coordinates");
  if (mesh.points.length % mesh.dim) throw new Error("MMG malformed point coordinates");
  const pointCount = mesh.points.length / mesh.dim;
  const positions = new Float64Array(mesh.points.length / mesh.dim * 3);
  for (let i = 0; i < mesh.points.length / mesh.dim; i++) for (let j = 0; j < mesh.dim; j++) positions[i * 3 + j] = mesh.points[i * mesh.dim + j];
  const regions = (mesh.regions ?? []).filter(r => r.kind === "cell");
  if ((mesh.regions ?? []).some(r => r.kind !== "cell")) warnings.push("Point/side regions are not carried through MMG; only named cell regions survive.");
  if (Object.keys(mesh.point_data ?? {}).length || Object.keys(mesh.cell_data ?? {}).length || Object.keys(mesh.field_data ?? {}).length) warnings.push("Point/cell/field data was dropped: MMG renumbers entities; field transfer is not implemented.");
  const members = regions.map(r => new Set(Array.from(r.entries, Number)));
  const references = new Map<number, number[]>([[1, []]]);
  const ids = new Map<string, number>([["", 1]]);
  const triangles: number[] = [], triangleRefs: number[] = [], tetrahedra: number[] = [], tetraRefs: number[] = [];
  let offset = 0;
  for (const block of mesh.cells) {
    if (!("nodesPerCell" in block)) throw new Error(`MMG does not accept ${block.type}; no implicit simplexification`);
    const count = block.data.length / block.nodesPerCell;
    if (!Number.isInteger(count)) throw new Error("MMG malformed cell block");
    if (block.type !== "tetra" && block.type !== "triangle") {
      if (["vertex", "line"].includes(block.type)) { warnings.push(`${block.type} cells were dropped (MMG remeshes triangles/tetrahedra only).`); offset += count; continue; }
      throw new Error(`MMG does not accept ${block.type}; use linear triangle/tetra meshes (no implicit linearisation)`);
    }
    const arity = block.type === "tetra" ? 4 : 3;
    if (block.nodesPerCell !== arity) throw new Error("MMG malformed connectivity arity");
    const cells = arity === 4 ? tetrahedra : triangles, refs = arity === 4 ? tetraRefs : triangleRefs;
    for (let c = 0; c < count; c++) {
      const membership = members.flatMap((set, index) => set.has(offset + c) ? [index] : []);
      const key = membership.join(",");
      let ref = ids.get(key);
      if (ref === undefined) { ref = ids.size + 1; ids.set(key, ref); references.set(ref, membership); }
      refs.push(ref);
      for (let j = 0; j < arity; j++) {
        const id = Number(block.data[c * arity + j]);
        // Validate before Int32Array narrowing; an oversized BigInt index
        // must not wrap into a valid but unrelated vertex.
        if (!Number.isSafeInteger(id) || id < 0 || id >= pointCount || id >= 0x7fffffff) throw new Error("MMG vertex index out of range");
        cells.push(id + 1);
      }
    }
    offset += count;
  }
  const input: MmgMesh = { positions, triangles: Int32Array.from(triangles), triangleRefs: Int32Array.from(triangleRefs), tetrahedra: Int32Array.from(tetrahedra), tetraRefs: Int32Array.from(tetraRefs) };
  return { input, regions, references, warnings };
}

export function harvestMmgMesh(output: MmgMesh, bridge: ReturnType<typeof prepareMmgMesh>): Mesh {
  const cells: Mesh["cells"] = [];
  const membership: number[][] = bridge.regions.map(() => []);
  let offset = 0;
  for (const [type, data, refs, arity, oldRefs] of [
    ["tetra", output.tetrahedra, output.tetraRefs, 4, bridge.input.tetraRefs],
    ["triangle", output.triangles, output.triangleRefs, 3, bridge.input.triangleRefs],
  ] as const) {
    const surviving = new Set(refs);
    for (const ref of oldRefs) if ((bridge.references.get(ref)?.length ?? 0) > 0 && !surviving.has(ref)) throw new Error(`MMG lost a named ${type} region (reference ${ref}); no output written`);
    if (!data.length) continue;
    cells.push({ type, nodesPerCell: arity, data: Int32Array.from(data, n => n - 1) });
    for (let c = 0; c < refs.length; c++) for (const region of bridge.references.get(refs[c]) ?? []) membership[region].push(offset + c);
    offset += refs.length;
  }
  const regions: Region[] = bridge.regions.flatMap((r, i) => membership[i].length ? [{ ...r, entries: Int32Array.from(membership[i]) }] : []);
  return { dim: 3, points: output.positions, cells, regions };
}
