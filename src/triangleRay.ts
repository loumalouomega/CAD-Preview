/**
 * Ray casting against a welded triangle mesh — pure (no THREE, no DOM, no
 * WASM), so the printability analysis stays Node-testable and
 * `three-mesh-bvh` stays webview-only (see `triangleDistance.ts`, the same
 * uniform-grid idea for nearest-point queries).
 *
 * A uniform grid over the mesh bounds holds, per cell, the triangles whose
 * bounding box overlaps it; a ray walks the cells with a 3D DDA and tests each
 * triangle once (Möller–Trumbore, double-sided). The nearest hit wins.
 */

export interface TriangleGrid {
  positions: Float32Array;
  indices: Uint32Array;
  min: [number, number, number];
  /** Cell edge length per axis. */
  cell: [number, number, number];
  dims: [number, number, number];
  /** Triangle ids per cell (flattened `x + dims0 * (y + dims1 * z)`). */
  cells: number[][];
}

/** Hard cap on cells per axis so a huge mesh cannot allocate an enormous grid. */
const MAX_DIM = 64;

export function buildTriangleGrid(positions: Float32Array, indices: Uint32Array): TriangleGrid {
  const nTri = Math.floor(indices.length / 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      if (positions[i + a] < min[a]) min[a] = positions[i + a];
      if (positions[i + a] > max[a]) max[a] = positions[i + a];
    }
  if (nTri === 0 || !Number.isFinite(min[0])) {
    return { positions, indices, min: [0, 0, 0], cell: [1, 1, 1], dims: [1, 1, 1], cells: [[]] };
  }
  // ~2 triangles per cell on average, bounded per axis.
  const perAxis = Math.max(1, Math.min(MAX_DIM, Math.round(Math.cbrt(nTri / 2))));
  const dims: [number, number, number] = [perAxis, perAxis, perAxis];
  const cell: [number, number, number] = [1, 1, 1];
  for (let a = 0; a < 3; a++) {
    const extent = max[a] - min[a];
    // A flat axis (extent 0) gets a unit cell and a single layer.
    if (extent <= 1e-12) {
      dims[a] = 1;
      cell[a] = 1;
    } else cell[a] = extent / dims[a];
  }
  const cells: number[][] = Array.from({ length: dims[0] * dims[1] * dims[2] }, () => []);
  const idx = (c: number[]) => c[0] + dims[0] * (c[1] + dims[1] * c[2]);
  const clampCell = (v: number, a: number) => Math.max(0, Math.min(dims[a] - 1, Math.floor((v - min[a]) / cell[a])));
  for (let t = 0; t < nTri; t++) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k] * 3;
      for (let a = 0; a < 3; a++) {
        const p = positions[v + a];
        if (p < lo[a]) lo[a] = p;
        if (p > hi[a]) hi[a] = p;
      }
    }
    const c0 = [clampCell(lo[0], 0), clampCell(lo[1], 1), clampCell(lo[2], 2)];
    const c1 = [clampCell(hi[0], 0), clampCell(hi[1], 1), clampCell(hi[2], 2)];
    for (let z = c0[2]; z <= c1[2]; z++)
      for (let y = c0[1]; y <= c1[1]; y++)
        for (let x = c0[0]; x <= c1[0]; x++) cells[idx([x, y, z])].push(t);
  }
  return { positions, indices, min, cell, dims, cells };
}

/** Möller–Trumbore, double-sided. Returns the ray parameter `t > eps`, or null. */
function intersectTriangle(
  p: Float32Array,
  i: Uint32Array,
  tri: number,
  o: readonly number[],
  d: readonly number[]
): number | null {
  const a = i[tri * 3] * 3, b = i[tri * 3 + 1] * 3, c = i[tri * 3 + 2] * 3;
  const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
  const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  const tx = o[0] - p[a], ty = o[1] - p[a + 1], tz = o[2] - p[a + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-9 ? t : null;
}

/**
 * Distance along the (unit) direction `dir` from `origin` to the nearest
 * triangle, or `null` when the ray leaves the mesh without a hit.
 */
export function castRay(grid: TriangleGrid, origin: readonly number[], dir: readonly number[]): number | null {
  const { min, cell, dims, cells, positions, indices } = grid;
  // Clip the ray to the grid box (slab test) to find where it enters.
  let tEnter = 0;
  let tExit = Infinity;
  for (let a = 0; a < 3; a++) {
    const lo = min[a];
    const hi = min[a] + cell[a] * dims[a];
    if (Math.abs(dir[a]) < 1e-15) {
      if (origin[a] < lo - 1e-9 || origin[a] > hi + 1e-9) return null;
    } else {
      let t0 = (lo - origin[a]) / dir[a];
      let t1 = (hi - origin[a]) / dir[a];
      if (t0 > t1) [t0, t1] = [t1, t0];
      tEnter = Math.max(tEnter, t0);
      tExit = Math.min(tExit, t1);
      if (tEnter > tExit) return null;
    }
  }
  const start = [origin[0] + dir[0] * tEnter, origin[1] + dir[1] * tEnter, origin[2] + dir[2] * tEnter];
  const c = [0, 0, 0];
  const step = [0, 0, 0];
  const tMax = [Infinity, Infinity, Infinity];
  const tDelta = [Infinity, Infinity, Infinity];
  for (let a = 0; a < 3; a++) {
    c[a] = Math.max(0, Math.min(dims[a] - 1, Math.floor((start[a] - min[a]) / cell[a])));
    if (Math.abs(dir[a]) < 1e-15) continue;
    step[a] = dir[a] > 0 ? 1 : -1;
    const next = min[a] + (c[a] + (step[a] > 0 ? 1 : 0)) * cell[a];
    tMax[a] = tEnter + (next - start[a]) / dir[a];
    tDelta[a] = Math.abs(cell[a] / dir[a]);
  }
  let best: number | null = null;
  const seen = new Set<number>();
  for (;;) {
    const list = cells[c[0] + dims[0] * (c[1] + dims[1] * c[2])];
    for (const tri of list) {
      if (seen.has(tri)) continue;
      seen.add(tri);
      const t = intersectTriangle(positions, indices, tri, origin, dir);
      if (t !== null && (best === null || t < best)) best = t;
    }
    // A hit inside the current cell's exit distance cannot be beaten by later cells.
    const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
    if (best !== null && best <= tMax[a] + 1e-9) return best;
    if (step[a] === 0 || tMax[a] > tExit) return best;
    c[a] += step[a];
    if (c[a] < 0 || c[a] >= dims[a]) return best;
    tMax[a] += tDelta[a];
  }
}
