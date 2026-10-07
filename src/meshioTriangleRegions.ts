import type { Mesh } from "@meshioplusplus/wasm";

/** Exact coordinate key, not a proximity/bbox match. extractSurface may
 * renumber points, but copies their coordinates. Sort corners for winding. */
export function triangleCoordinateKey(points: ArrayLike<number>, dim: number, ids: ArrayLike<number>): string {
  return Array.from(ids, id => [points[id * dim], points[id * dim + 1], dim === 3 ? points[id * dim + 2] : 0].join(",")).sort().join(";");
}

/** Mixed volume+boundary meshes carry physical surface groups on explicit
 * triangle cells, NOT on the parent tetrahedron. Prefer those exact facets
 * over the volume-region fallback. This is needed for remeshed BC Parts. */
export function explicitTriangleRegions(mesh: Mesh, regionSets: Array<{ ids: Set<number> }>): Map<string, number> {
  const result = new Map<string, number>();
  let offset = 0;
  for (const block of mesh.cells) {
    const count = "nodesPerCell" in block ? block.data.length / block.nodesPerCell :
      ("cellOffsets" in block ? block.cellOffsets.length : block.rowOffsets.length) - 1;
    if ("nodesPerCell" in block && block.type === "triangle" && block.nodesPerCell === 3) {
      for (let t = 0; t < count; t++) {
        const r = regionSets.findIndex(region => region.ids.has(offset + t));
        if (r >= 0) result.set(triangleCoordinateKey(mesh.points, mesh.dim, block.data.slice(t * 3, t * 3 + 3)), r);
      }
    }
    offset += count;
  }
  return result;
}
