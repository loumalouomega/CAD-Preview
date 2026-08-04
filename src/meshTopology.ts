/**
 * Pure triangle-soup edge/topology analysis — vscode/OCCT-free, mirrors
 * `meshComponents.ts`'s pure-module convention (same file it's meant to be
 * used alongside). Written for the "Mesh → B-rep promotion, diagnostic-
 * first" heal-quality report (`meshHeal.ts`): before spending any OCCT time
 * on a sewing-tolerance ladder, a report can already say a lot from the
 * triangle soup alone — which edges are free (boundary, referenced by
 * exactly one triangle), which are non-manifold (referenced by three or
 * more), and which faces are degenerate (zero or near-zero area).
 *
 * A free edge here is NOT automatically an OCCT-sewing free edge — sewing
 * operates on independently-built tiny B-rep faces with their own
 * coincidence tolerance, so a raw-mesh free edge (two triangles that share
 * an edge geometrically but weren't welded into the same vertex index, e.g.
 * across the default `weldTriangleSoup` epsilon) can still close under
 * sewing's coarser tolerance. This module reports the mesh's OWN edge
 * topology as a fast, WASM-free first signal, not a substitute for the
 * OCCT-side ladder.
 */

import { edgeKey } from "./meshComponents";

/** Same near-zero-area epsilon convention as elsewhere in this codebase's
 * mesh tooling (e.g. `weldTriangleSoup`'s default position epsilon) — a
 * triangle below this area is considered degenerate (collinear or
 * duplicated vertices), not a genuine sliver worth counting as valid. */
const DEGENERATE_AREA_EPSILON = 1e-9;

export interface MeshTopologyStats {
  /** Edges referenced by exactly 1 triangle — mesh boundary/holes. */
  freeEdgeCount: number;
  /** Edges referenced by exactly 2 triangles — the well-formed case. */
  manifoldEdgeCount: number;
  /** Edges referenced by 3+ triangles — a genuine topological defect (e.g.
   * two solids welded along a shared seam, or a self-intersecting mesh). */
  nonManifoldEdgeCount: number;
  /** Triangles whose area is at or below `DEGENERATE_AREA_EPSILON`
   * (collinear or duplicated vertices). */
  degenerateFaceCount: number;
}

/**
 * Analyzes the edge-occurrence topology and degenerate-face count of a
 * triangle subset (e.g. one `connectedComponents()` component) of a welded,
 * indexed mesh.
 */
export function analyzeMeshTopology(positions: Float32Array, indices: Uint32Array, triangles: number[]): MeshTopologyStats {
  const edgeCounts = new Map<string, number>();
  let degenerateFaceCount = 0;

  for (const t of triangles) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    for (const key of [edgeKey(i0, i1), edgeKey(i1, i2), edgeKey(i2, i0)]) {
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }

    const p0 = i0 * 3, p1 = i1 * 3, p2 = i2 * 3;
    const ax = positions[p0], ay = positions[p0 + 1], az = positions[p0 + 2];
    const bx = positions[p1], by = positions[p1 + 1], bz = positions[p1 + 2];
    const cx = positions[p2], cy = positions[p2 + 1], cz = positions[p2 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const cxp = uy * vz - uz * vy;
    const cyp = uz * vx - ux * vz;
    const czp = ux * vy - uy * vx;
    const area = Math.hypot(cxp, cyp, czp) / 2;
    if (area <= DEGENERATE_AREA_EPSILON) degenerateFaceCount++;
  }

  let freeEdgeCount = 0;
  let manifoldEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  for (const count of edgeCounts.values()) {
    if (count === 1) freeEdgeCount++;
    else if (count === 2) manifoldEdgeCount++;
    else nonManifoldEdgeCount++;
  }

  return { freeEdgeCount, manifoldEdgeCount, nonManifoldEdgeCount, degenerateFaceCount };
}
