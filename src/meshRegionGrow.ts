/**
 * Seeded, dihedral-gated region growing over a welded triangle mesh
 * (roadmap item 9).
 *
 * **Why this exists when `meshFacets.ts`'s `segmentCoplanarFacets` already
 * does a dihedral-gated flood fill.** That function is genuinely host-callable
 * (`meshioRegionParts.ts` imports it) and its algorithm is the right shape, but
 * three things make it the wrong tool here:
 *
 *  1. It is **global segmentation, not a seeded grow** — it partitions every
 *     triangle in the mesh and has no size cap, where this needs "start here,
 *     stop after N".
 *  2. It is DOM-free but **not THREE-free**: importing it pulls in `three` and
 *     `three-mesh-bvh` and runs a top-level prototype monkey-patch. Every pure
 *     mesh module in this codebase (`meshComponents`, `meshTopology`,
 *     `silhouetteEdges`, `primitiveSdf`) is dependency-free, and so is this.
 *  3. Its 15° tolerance is tuned for splitting **flat** faces apart. Fitting a
 *     cylinder needs the opposite — a gate loose enough to walk *across* a
 *     tessellated curve without stopping at every facet boundary.
 *
 * The flood-fill discipline (edge→triangle `Map`, `Uint8Array` visited,
 * explicit stack) is copied from `meshComponents.ts`'s `connectedComponents`,
 * which is the same walk without a gate.
 */

import { edgeKey } from "./meshComponents";
import { triangleNormals } from "./silhouetteEdges";
import { normalCos } from "./hiddenLineRemoval";

export interface GrowOptions {
  /**
   * Maximum angle between adjacent triangles' normals for the walk to cross
   * their shared edge, in degrees.
   *
   * The default is deliberately looser than `meshFacets.ts`'s 15°: that one
   * exists to split flat faces apart, whereas a region meant to be fitted with
   * a cylinder or sphere has to walk across a tessellated curve. At 40° a
   * cube's 90° edges still stop the walk, while a sphere tessellated at even a
   * fairly coarse resolution stays connected.
   */
  angleDeg?: number;
  /**
   * Hard cap on how many triangles the region may contain. Growing stops as
   * soon as it is reached — the region is still returned, and `capped` says so,
   * rather than the caller silently receiving a truncated region that looks
   * complete.
   */
  maxTriangles?: number;
}

export interface GrownRegion {
  /** Triangle indices, in the order visited. The `triangles: number[]` subset
   * convention `boundsOfTriangles`/`areaOfTriangles`/`analyzeMeshTopology` all
   * already accept. */
  triangles: number[];
  /** True when growing stopped at `maxTriangles` rather than at a real edge. */
  capped: boolean;
}

export const DEFAULT_GROW_ANGLE_DEG = 40;
export const DEFAULT_MAX_REGION_TRIANGLES = 200_000;

/**
 * Grows a region outward from `seedTriangle`, crossing an edge only when the
 * two triangles' normals differ by less than `angleDeg`.
 *
 * A degenerate neighbour (zero-area, so `normalCos` is `NaN`) is **not**
 * crossed: `NaN >= cos` is false, so it stops the walk rather than being
 * treated as coplanar. That is the conservative direction — a degenerate
 * triangle carries no orientation to justify continuing through it.
 *
 * Returns an empty region for an out-of-range seed rather than throwing, so a
 * caller resolving a seed from a user-supplied point degrades to "nothing
 * found" instead of an exception.
 */
export function growRegion(
  positions: Float32Array,
  indices: Uint32Array,
  seedTriangle: number,
  options: GrowOptions = {}
): GrownRegion {
  const triangleCount = Math.floor(indices.length / 3);
  if (!Number.isInteger(seedTriangle) || seedTriangle < 0 || seedTriangle >= triangleCount) {
    return { triangles: [], capped: false };
  }
  const angleDeg = options.angleDeg ?? DEFAULT_GROW_ANGLE_DEG;
  const maxTriangles = options.maxTriangles ?? DEFAULT_MAX_REGION_TRIANGLES;
  const cosTol = Math.cos((angleDeg * Math.PI) / 180);

  const edgeToTriangles = new Map<string, number[]>();
  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    for (const key of [edgeKey(i0, i1), edgeKey(i1, i2), edgeKey(i2, i0)]) {
      const list = edgeToTriangles.get(key);
      if (list) list.push(t);
      else edgeToTriangles.set(key, [t]);
    }
  }

  const normals = triangleNormals(positions, indices);
  const visited = new Uint8Array(triangleCount);
  const triangles: number[] = [];
  const stack = [seedTriangle];
  visited[seedTriangle] = 1;
  let capped = false;

  while (stack.length > 0) {
    if (triangles.length >= maxTriangles) {
      capped = true;
      break;
    }
    const t = stack.pop()!;
    triangles.push(t);
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    for (const key of [edgeKey(i0, i1), edgeKey(i1, i2), edgeKey(i2, i0)]) {
      for (const neighbor of edgeToTriangles.get(key)!) {
        if (visited[neighbor]) continue;
        // NaN (a degenerate neighbour) fails this comparison and so stops the
        // walk — deliberate, see the doc comment.
        if (!(normalCos(normals, t, neighbor) >= cosTol)) continue;
        visited[neighbor] = 1;
        stack.push(neighbor);
      }
    }
  }

  return { triangles, capped };
}

/**
 * The triangle whose centroid is nearest `point`, or `-1` for an empty mesh.
 *
 * **Centroid distance, not true point-to-triangle distance** — a deliberate
 * simplification for resolving a *seed*. A neighbouring smaller triangle can be
 * nearer by centroid than the one actually containing the point, but both land
 * in the same grown region whenever the point is anywhere on a coherent
 * surface, which is the only case a seed is meaningful in.
 */
export function nearestTriangleToPoint(
  positions: Float32Array,
  indices: Uint32Array,
  point: readonly [number, number, number]
): number {
  const triangleCount = Math.floor(indices.length / 3);
  let best = -1;
  let bestD2 = Infinity;
  for (let t = 0; t < triangleCount; t++) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k] * 3;
      cx += positions[v];
      cy += positions[v + 1];
      cz += positions[v + 2];
    }
    cx /= 3;
    cy /= 3;
    cz /= 3;
    const dx = cx - point[0];
    const dy = cy - point[1];
    const dz = cz - point[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = t;
    }
  }
  return best;
}

/** Unique vertex positions referenced by `triangles`, as points to fit. */
export function regionPoints(
  positions: Float32Array,
  indices: Uint32Array,
  triangles: readonly number[]
): [number, number, number][] {
  const seen = new Set<number>();
  const out: [number, number, number][] = [];
  for (const t of triangles) {
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k];
      if (seen.has(v)) continue;
      seen.add(v);
      out.push([positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]);
    }
  }
  return out;
}

/** Unit normals of `triangles`, skipping degenerate ones. Used by the cylinder
 * fit, whose axis comes from the covariance of the region's normals. */
export function regionNormals(
  positions: Float32Array,
  indices: Uint32Array,
  triangles: readonly number[]
): [number, number, number][] {
  const normals = triangleNormals(positions, indices);
  const out: [number, number, number][] = [];
  for (const t of triangles) {
    const x = normals[t * 3];
    const y = normals[t * 3 + 1];
    const z = normals[t * 3 + 2];
    const n = Math.hypot(x, y, z);
    if (n < 1e-20) continue;
    out.push([x / n, y / n, z / n]);
  }
  return out;
}
