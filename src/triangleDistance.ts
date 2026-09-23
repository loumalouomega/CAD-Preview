/**
 * Point-to-triangle-mesh distance with a uniform 3D grid index — pure (no
 * OCCT, no THREE), so it runs host-side and unit-tests headless. Shared by
 * the mesh-aware tessellation export's chordal-error sampling and the
 * CAD-to-mesh deviation map.
 *
 * Why a grid and not a BVH: `three-mesh-bvh` is webview-only (it pulls in
 * THREE and patches prototypes — see `meshRegionGrow.ts`), and every other
 * host module here avoids THREE. A uniform grid over triangle bounding boxes
 * is the 3D generalization of `hiddenLineRemoval.ts`'s 2D screen grid:
 * cells sized from the mean triangle extent, each triangle registered in
 * every cell its bbox overlaps, and a nearest query that grows a shell of
 * cells until the best distance found is provably closer than any unvisited
 * shell.
 */

export type Vec3 = [number, number, number];

/** Closest point on triangle (a,b,c) to p — Ericson, Real-Time Collision
 * Detection §5.1.5 (Voronoi-region case analysis; no divisions by zero for
 * non-degenerate input, and a degenerate triangle still returns a point on
 * its segments). Writes into `out`, returns squared distance. */
export function closestPointOnTriangle(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  out: Float64Array
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) {
    qx = ax; qy = ay; qz = az;
  } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) {
      qx = bx; qy = by; qz = bz;
    } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) {
          qx = cx; qy = cy; qz = cz;
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              qx = bx + w * (cx - bx); qy = by + w * (cy - by); qz = bz + w * (cz - bz);
            } else {
              const denom = va + vb + vc;
              if (!(Math.abs(denom) > 0)) {
                // Degenerate (collinear/zero-area) triangle: fall back to vertex a.
                qx = ax; qy = ay; qz = az;
              } else {
                const v = vb / denom;
                const w = vc / denom;
                qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
              }
            }
          }
        }
      }
    }
  }
  out[0] = qx; out[1] = qy; out[2] = qz;
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

export interface TriangleGrid {
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
  readonly triangleCount: number;
  readonly min: Vec3;
  readonly cell: number;
  readonly dims: [number, number, number];
  /** cell index → triangle ids (flattened CSR). */
  readonly cellStart: Uint32Array;
  readonly cellTris: Uint32Array;
}

/** Builds a uniform grid over `indices`' triangles. `targetPerCell` tunes
 * cell size relative to the mean triangle extent; the cell count is capped
 * so a pathological input can't allocate unboundedly. */
export function buildTriangleGrid3D(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  options: { maxCells?: number } = {}
): TriangleGrid {
  const triangleCount = Math.floor(indices.length / 3);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let extentSum = 0;
  for (let t = 0; t < triangleCount; t++) {
    let tmin0 = Infinity, tmin1 = Infinity, tmin2 = Infinity, tmax0 = -Infinity, tmax1 = -Infinity, tmax2 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k] * 3;
      const x = positions[v], y = positions[v + 1], z = positions[v + 2];
      if (x < tmin0) tmin0 = x; if (x > tmax0) tmax0 = x;
      if (y < tmin1) tmin1 = y; if (y > tmax1) tmax1 = y;
      if (z < tmin2) tmin2 = z; if (z > tmax2) tmax2 = z;
    }
    extentSum += Math.max(tmax0 - tmin0, tmax1 - tmin1, tmax2 - tmin2);
    if (tmin0 < min[0]) min[0] = tmin0; if (tmax0 > max[0]) max[0] = tmax0;
    if (tmin1 < min[1]) min[1] = tmin1; if (tmax1 > max[1]) max[1] = tmax1;
    if (tmin2 < min[2]) min[2] = tmin2; if (tmax2 > max[2]) max[2] = tmax2;
  }
  if (triangleCount === 0) {
    return { positions, indices, triangleCount, min: [0, 0, 0], cell: 1, dims: [1, 1, 1], cellStart: new Uint32Array(2), cellTris: new Uint32Array(0) };
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const diag = Math.hypot(size[0], size[1], size[2]) || 1;
  const maxCells = options.maxCells ?? 2_000_000;
  let cell = Math.max(extentSum / triangleCount, diag * 1e-6);
  let dims: [number, number, number];
  for (;;) {
    dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil(size[a] / cell) || 1)) as [number, number, number];
    if (dims[0] * dims[1] * dims[2] <= maxCells) break;
    cell *= 1.5;
  }
  const cellCount = dims[0] * dims[1] * dims[2];
  const clampIdx = (v: number, a: number) => Math.min(dims[a] - 1, Math.max(0, Math.floor((v - min[a]) / cell)));
  const counts = new Uint32Array(cellCount + 1);
  const triRange = new Int32Array(triangleCount * 6);
  for (let t = 0; t < triangleCount; t++) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k] * 3;
      for (let a = 0; a < 3; a++) {
        const c = positions[v + a];
        if (c < lo[a]) lo[a] = c;
        if (c > hi[a]) hi[a] = c;
      }
    }
    for (let a = 0; a < 3; a++) {
      triRange[t * 6 + a] = clampIdx(lo[a], a);
      triRange[t * 6 + 3 + a] = clampIdx(hi[a], a);
    }
    for (let i = triRange[t * 6]; i <= triRange[t * 6 + 3]; i++)
      for (let j = triRange[t * 6 + 1]; j <= triRange[t * 6 + 4]; j++)
        for (let k = triRange[t * 6 + 2]; k <= triRange[t * 6 + 5]; k++) counts[(i * dims[1] + j) * dims[2] + k + 1]++;
  }
  for (let c = 1; c <= cellCount; c++) counts[c] += counts[c - 1];
  const cellStart = counts;
  const fill = cellStart.slice(0, cellCount);
  const cellTris = new Uint32Array(cellStart[cellCount]);
  for (let t = 0; t < triangleCount; t++) {
    for (let i = triRange[t * 6]; i <= triRange[t * 6 + 3]; i++)
      for (let j = triRange[t * 6 + 1]; j <= triRange[t * 6 + 4]; j++)
        for (let k = triRange[t * 6 + 2]; k <= triRange[t * 6 + 5]; k++) cellTris[fill[(i * dims[1] + j) * dims[2] + k]++] = t;
  }
  return { positions, indices, triangleCount, min: [min[0], min[1], min[2]], cell, dims, cellStart, cellTris };
}

export interface NearestHit {
  distance: number;
  triangle: number;
  point: Vec3;
}

/** Exact nearest point on the gridded mesh to p (null for an empty grid). */
export function nearestOnGrid(grid: TriangleGrid, p: Vec3): NearestHit | null {
  if (grid.triangleCount === 0) return null;
  const { dims, cell, min, positions, indices, cellStart, cellTris } = grid;
  const q = new Float64Array(3);
  const best = new Float64Array(3);
  let bestD2 = Infinity;
  let bestTri = -1;
  const ci = [0, 1, 2].map((a) => Math.min(dims[a] - 1, Math.max(0, Math.floor((p[a] - min[a]) / cell))));
  const maxR = Math.max(dims[0], dims[1], dims[2]);
  for (let r = 0; r <= maxR; r++) {
    // Every triangle not yet tested lives only in cells OUTSIDE the ring-r box
    // B_r = cells [ci-r, ci+r]. p lies inside B_r except on sides where B_r is
    // clamped by the grid boundary (no cells beyond), so the nearest unvisited
    // cell is at least the distance from p to the nearest B_r face that still
    // has cells beyond it. Once the best hit is no farther, it is exact.
    // Checked BEFORE scanning ring r, so the scanned box is B_(r-1).
    if (bestTri >= 0) {
      const s = r - 1;
      let bound = Infinity;
      for (let a = 0; a < 3; a++) {
        if (ci[a] - s > 0) bound = Math.min(bound, p[a] - (min[a] + (ci[a] - s) * cell));
        if (ci[a] + s < dims[a] - 1) bound = Math.min(bound, min[a] + (ci[a] + s + 1) * cell - p[a]);
      }
      if (bound === Infinity || Math.sqrt(bestD2) <= bound) break;
    }
    for (let i = ci[0] - r; i <= ci[0] + r; i++) {
      if (i < 0 || i >= dims[0]) continue;
      for (let j = ci[1] - r; j <= ci[1] + r; j++) {
        if (j < 0 || j >= dims[1]) continue;
        for (let k = ci[2] - r; k <= ci[2] + r; k++) {
          if (k < 0 || k >= dims[2]) continue;
          if (Math.max(Math.abs(i - ci[0]), Math.abs(j - ci[1]), Math.abs(k - ci[2])) !== r) continue;
          const c = (i * dims[1] + j) * dims[2] + k;
          for (let s = cellStart[c]; s < cellStart[c + 1]; s++) {
            const t = cellTris[s];
            const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, cc = indices[t * 3 + 2] * 3;
            const d2 = closestPointOnTriangle(
              p[0], p[1], p[2],
              positions[a], positions[a + 1], positions[a + 2],
              positions[b], positions[b + 1], positions[b + 2],
              positions[cc], positions[cc + 1], positions[cc + 2],
              q
            );
            if (d2 < bestD2) {
              bestD2 = d2;
              bestTri = t;
              best.set(q);
            }
          }
        }
      }
    }
  }
  return { distance: Math.sqrt(bestD2), triangle: bestTri, point: [best[0], best[1], best[2]] };
}
