/**
 * Pure triangle-soup geometry helpers — vertex welding, connected-component
 * (per-"solid") segmentation, and per-component bounding box / signed volume
 * — vscode/OCCT/THREE-free (mirrors `modelDiff.ts`'s pure-module convention).
 * Written for `stlSolidSignatures.ts`'s Compare-Models support: a raw STL
 * triangle soup (`stlParser.ts`) has no shared-vertex indexing and no
 * "which triangles form the same solid" grouping at all — both are derived
 * here from pure geometric adjacency.
 *
 * No existing code in this codebase does true edge-adjacency connected-
 * component segmentation — `src/webview/meshFacets.ts`'s
 * `segmentCoplanarFacets` looks similar (weld + edge→triangle map + BFS) but
 * solves the OPPOSITE problem (splitting one solid into flat *faces* by
 * gating the flood-fill on face-normal angle); the weld/adjacency-map/BFS
 * *scaffolding* is the same shape, but the flood-fill here has no angle gate
 * at all — any two triangles sharing an edge are the same connected
 * component, full stop.
 */

export interface Vec3Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** A welded (deduplicated-vertex) indexed mesh. */
export interface WeldedMesh {
  /** Deduplicated vertex positions, 3 floats each. */
  positions: Float32Array;
  /** Triangle vertex indices into `positions`, 3 per triangle. */
  indices: Uint32Array;
}

/**
 * Welds a flat, ungrouped triangle soup (`stlParser.ts`'s output — 9 floats
 * per triangle, no sharing) into an indexed mesh, merging vertices whose
 * coordinates round to the same value at `epsilon` precision — the same
 * quantized-position-hash technique `meshFacets.ts`'s `canonOf` already uses
 * for the identical "STL/mesh geometry has no native shared-vertex indexing"
 * problem, just applied to positions on their own rather than
 * position+normal.
 */
export function weldTriangleSoup(soup: Float32Array, epsilon = 1e-5): WeldedMesh {
  const triangleCount = Math.floor(soup.length / 9);
  const indices = new Uint32Array(triangleCount * 3);
  const positions: number[] = [];
  const seen = new Map<string, number>();

  const inv = 1 / epsilon;
  let cursor = 0;
  for (let i = 0; i < triangleCount * 3; i++) {
    const x = soup[cursor++];
    const y = soup[cursor++];
    const z = soup[cursor++];
    const key = `${Math.round(x * inv)}_${Math.round(y * inv)}_${Math.round(z * inv)}`;
    let idx = seen.get(key);
    if (idx === undefined) {
      idx = positions.length / 3;
      positions.push(x, y, z);
      seen.set(key, idx);
    }
    indices[i] = idx;
  }
  return { positions: new Float32Array(positions), indices };
}

/**
 * Undirected edge key, order-independent (`a_b` with the smaller index first).
 *
 * Exported because three separate modules were maintaining a byte-identical
 * private copy (`meshTopology.ts`, and now `silhouetteEdges.ts`), all keying
 * the same welded-vertex-index space — the same drift hazard the shared
 * `enumerateEdges`/`EDGE_DEFLECTION` consolidation already removed on the
 * B-rep side. Any change to the key format has to stay consistent across
 * every consumer, so there is exactly one.
 */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/**
 * Segments a welded mesh's triangles into connected components — two
 * triangles are in the same component iff there's a chain of shared EDGES
 * (not just a shared vertex — the standard "manifold connected component"
 * definition) between them. Returns one array of triangle indices per
 * component, in first-encountered order (deterministic given a fixed
 * `indices` order, which `weldTriangleSoup` derives deterministically from
 * file order).
 */
export function connectedComponents(indices: Uint32Array): number[][] {
  const triangleCount = Math.floor(indices.length / 3);
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

  const visited = new Uint8Array(triangleCount);
  const components: number[][] = [];
  for (let start = 0; start < triangleCount; start++) {
    if (visited[start]) continue;
    const component: number[] = [];
    const stack = [start];
    visited[start] = 1;
    while (stack.length > 0) {
      const t = stack.pop()!;
      component.push(t);
      const i0 = indices[t * 3];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];
      for (const key of [edgeKey(i0, i1), edgeKey(i1, i2), edgeKey(i2, i0)]) {
        for (const neighbor of edgeToTriangles.get(key)!) {
          if (!visited[neighbor]) {
            visited[neighbor] = 1;
            stack.push(neighbor);
          }
        }
      }
    }
    components.push(component);
  }
  return components;
}

/** Bounding box of the vertices referenced by `triangles` (a subset of
 * `indices`, e.g. one connected component) — `undefined` for an empty list. */
export function boundsOfTriangles(positions: Float32Array, indices: Uint32Array, triangles: number[]): Vec3Bounds | undefined {
  if (triangles.length === 0) return undefined;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const t of triangles) {
    for (let c = 0; c < 3; c++) {
      const vi = indices[t * 3 + c] * 3;
      for (let axis = 0; axis < 3; axis++) {
        const v = positions[vi + axis];
        if (v < min[axis]) min[axis] = v;
        if (v > max[axis]) max[axis] = v;
      }
    }
  }
  return { min, max };
}

export function boundsCenter(bounds: Vec3Bounds): [number, number, number] {
  return [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
}

export function boundsDiagonal(bounds: Vec3Bounds): number {
  return Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
}

/**
 * Signed-tetrahedra volume of the triangles in `triangles` (a subset of
 * `indices`, e.g. one connected component) — the standard divergence-theorem
 * formula (`Σ v0·(v1×v2) / 6`, one tetrahedron per triangle against the
 * origin), the same shape `gmshElementTypes.ts`'s `signedVolume` and the
 * webview's `meshMassProperties.ts` both already use elsewhere in this
 * codebase for an analogous "volume from a closed triangle mesh" need.
 * Returns the unsigned magnitude (`Math.abs`) — this codebase's volume
 * fields are always non-negative (matching `BRepGProp.VolumeProperties`'s
 * `Mass()` convention the B-rep side already returns), so triangle winding
 * order (outward vs inward-facing) never flips the sign of what's reported.
 */
export function volumeOfTriangles(positions: Float32Array, indices: Uint32Array, triangles: number[]): number {
  let sum = 0;
  for (const t of triangles) {
    const i0 = indices[t * 3] * 3;
    const i1 = indices[t * 3 + 1] * 3;
    const i2 = indices[t * 3 + 2] * 3;
    const ax = positions[i0], ay = positions[i0 + 1], az = positions[i0 + 2];
    const bx = positions[i1], by = positions[i1 + 1], bz = positions[i1 + 2];
    const cx = positions[i2], cy = positions[i2 + 1], cz = positions[i2 + 2];
    sum += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return Math.abs(sum / 6);
}

/**
 * Sum of per-triangle areas (`|cross(v1-v0, v2-v0)| / 2`) over `triangles` —
 * the natural sibling of `volumeOfTriangles` above, added for the "Mesh →
 * B-rep promotion, diagnostic-first" heal-quality report (`meshHeal.ts`),
 * which needs a raw (pre-heal) surface area to compare a hypothetical
 * healed-solid's OCCT-computed area against.
 */
export function areaOfTriangles(positions: Float32Array, indices: Uint32Array, triangles: number[]): number {
  let sum = 0;
  for (const t of triangles) {
    const i0 = indices[t * 3] * 3;
    const i1 = indices[t * 3 + 1] * 3;
    const i2 = indices[t * 3 + 2] * 3;
    const ax = positions[i0], ay = positions[i0 + 1], az = positions[i0 + 2];
    const bx = positions[i1], by = positions[i1 + 1], bz = positions[i1 + 2];
    const cx = positions[i2], cy = positions[i2 + 1], cz = positions[i2 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const cxp = uy * vz - uz * vy;
    const cyp = uz * vx - ux * vz;
    const czp = ux * vy - uy * vx;
    sum += Math.hypot(cxp, cyp, czp) / 2;
  }
  return sum;
}
