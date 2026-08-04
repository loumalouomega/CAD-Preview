/**
 * Pure triangle-mesh silhouette extraction — vscode/OCCT/THREE-free, a
 * sibling of `meshComponents.ts`/`meshTopology.ts` reusing their shared
 * `edgeKey` and the same edge→triangle adjacency scaffolding.
 *
 * The silhouette of a mesh, seen from a given direction, is the set of edges
 * where the surface turns away from the viewer: an edge whose two adjacent
 * triangles disagree about whether they face the camera. Drawn on their own
 * these edges read as the model's outline, which is exactly what an SVG
 * silhouette export needs — and, unlike anything built on OCCT, this works
 * identically for a B-rep (via its tessellation) and for a raw STL/OBJ/PLY/
 * glTF mesh, with no kernel involvement at all.
 *
 * **Known limitation, documented rather than fixed:** this assumes consistent
 * triangle winding across the mesh. A mesh with mixed winding (some triangles
 * wound clockwise, some counter-clockwise, as some exporters and hand-edited
 * files produce) will report spurious interior edges, because the facing test
 * flips with the winding. There is no cheap, reliable way to repair winding
 * for an arbitrary open mesh, so the honest thing is to say so — the output
 * is a review/illustration artifact, not a certified drawing.
 */

import { edgeKey } from "./meshComponents";

export type Vec3 = readonly [number, number, number];

/**
 * The silhouette edges of a welded, indexed mesh viewed along `direction`,
 * as pairs of vertex indices into `positions`. Deduplicated, in deterministic
 * first-encountered triangle order.
 *
 * `direction` follows this codebase's own `ViewState.viewDirection`
 * convention: it points from the model TOWARD the camera, so a triangle is
 * front-facing when its normal has a positive dot product with it.
 *
 * An edge is kept when it is:
 *  - shared by exactly 2 triangles that DISAGREE about facing (the silhouette
 *    proper), or
 *  - referenced by exactly 1 triangle (an open boundary — this is what lets an
 *    unclosed STL/glTF still draw as something sensible rather than nothing),
 *    or
 *  - referenced by 3+ triangles (non-manifold — always a genuine feature of
 *    the geometry, the same judgement `meshTopology.ts` already applies).
 *
 * A triangle exactly edge-on to the viewer (`dot === 0`) counts as back-
 * facing. That is deterministic rather than arbitrary, and it puts exactly one
 * silhouette line along a cylinder's tangent instead of zero or two.
 */
export function silhouetteEdges(positions: Float32Array, indices: Uint32Array, direction: Vec3): Array<[number, number]> {
  const triangleCount = Math.floor(indices.length / 3);
  if (triangleCount === 0) return [];

  const [dx, dy, dz] = direction;
  const front = new Uint8Array(triangleCount);
  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3] * 3;
    const i1 = indices[t * 3 + 1] * 3;
    const i2 = indices[t * 3 + 2] * 3;
    const ux = positions[i1] - positions[i0];
    const uy = positions[i1 + 1] - positions[i0 + 1];
    const uz = positions[i1 + 2] - positions[i0 + 2];
    const vx = positions[i2] - positions[i0];
    const vy = positions[i2 + 1] - positions[i0 + 1];
    const vz = positions[i2 + 2] - positions[i0 + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    front[t] = nx * dx + ny * dy + nz * dz > 0 ? 1 : 0;
  }

  // Edge → the triangles referencing it, plus the vertex pair to emit.
  const edges = new Map<string, { a: number; b: number; triangles: number[] }>();
  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    for (const [a, b] of [
      [i0, i1],
      [i1, i2],
      [i2, i0],
    ]) {
      if (a === b) continue; // degenerate triangle edge — nothing to draw
      const key = edgeKey(a, b);
      const existing = edges.get(key);
      if (existing) existing.triangles.push(t);
      else edges.set(key, { a, b, triangles: [t] });
    }
  }

  const result: Array<[number, number]> = [];
  for (const { a, b, triangles } of edges.values()) {
    const keep =
      triangles.length === 1 ||
      triangles.length > 2 ||
      (triangles.length === 2 && front[triangles[0]] !== front[triangles[1]]);
    if (keep) result.push([a, b]);
  }
  return result;
}
