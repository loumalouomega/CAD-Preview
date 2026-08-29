import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { makeFaceMaterial } from "./geometryBuilder";

// Patch THREE prototypes once so `Mesh.raycast` uses the BVH when present and
// falls back to the original brute-force path otherwise. The patch is
// idempotent across HMR / repeated imports. `three-mesh-bvh`'s own
// `src/index.d.ts` already augments `three`'s `BufferGeometry` type with
// `boundsTree` / `computeBoundsTree` / `disposeBoundsTree`.
if (!(THREE.BufferGeometry.prototype as unknown as Record<string, unknown>).computeBoundsTree) {
  (THREE.BufferGeometry.prototype as unknown as Record<string, unknown>).computeBoundsTree = computeBoundsTree;
  (THREE.BufferGeometry.prototype as unknown as Record<string, unknown>).disposeBoundsTree = disposeBoundsTree;
  (THREE.Mesh.prototype as unknown as Record<string, unknown>).raycast = acceleratedRaycast;
}

/** Default angle (degrees) below which adjacent triangles are treated coplanar. */
export const FACET_ANGLE_TOLERANCE = 15;
/** Above this facet count a mesh is left whole (avoids exploding curved meshes). */
export const MAX_FACETS = 512;

/**
 * Segments a triangle mesh into connected, near-coplanar regions ("facets") — the
 * visual flat faces a user expects to click (a cube → 6 facets). Returns an array
 * mapping each triangle index to its facet id. Facet ids are assigned by the first
 * unvisited triangle in index order, so they are deterministic (stable across
 * reopen) for an unchanged geometry.
 *
 * Works on indexed and non-indexed geometry: STL/OBJ meshes duplicate coincident
 * vertices, so adjacency is computed on position-welded ("canonical") vertices.
 *
 * `triangleRegion`, when given, is an additional per-triangle constraint
 * (one entry per triangle, any comparable value — typically a region index
 * or `-1` for "none"): two triangles never merge across a boundary where
 * this value differs, even if they're coplanar within tolerance. Purely
 * restrictive — every existing call site (which omits it) behaves
 * identically to before; this can only ever produce the same or MORE
 * facets, never fewer. Used to keep a meshio++-imported document's
 * region-derived Parts referencing the same facet ids the model actually
 * displays — see `src/meshioService.ts`'s `convertToStlBoundaryWithRegions`
 * and CLAUDE.md's "meshio++ integration" section.
 */
export function segmentCoplanarFacets(
  geometry: THREE.BufferGeometry,
  angleToleranceDeg = FACET_ANGLE_TOLERANCE,
  triangleRegion?: ArrayLike<number>
): number[] {
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.getIndex();
  const triCount = (index ? index.count : pos.count) / 3;
  if (triCount === 0) return [];

  const corner = (t: number, k: number): number =>
    index ? index.getX(t * 3 + k) : t * 3 + k;

  // Weld coincident vertices by quantizing positions to a scale-relative epsilon.
  const box = new THREE.Box3().setFromBufferAttribute(pos);
  const size = box.getSize(new THREE.Vector3());
  const eps = Math.max(size.x, size.y, size.z, 1) * 1e-6;
  const canon = new Map<string, number>();
  let nextCanon = 0;
  const canonOf = (vi: number): number => {
    const x = Math.round(pos.getX(vi) / eps);
    const y = Math.round(pos.getY(vi) / eps);
    const z = Math.round(pos.getZ(vi) / eps);
    const key = `${x},${y},${z}`;
    let c = canon.get(key);
    if (c === undefined) { c = nextCanon++; canon.set(key, c); }
    return c;
  };

  // Per-triangle canonical corners + face normal.
  const triCanon: Array<[number, number, number]> = [];
  const normals: THREE.Vector3[] = [];
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const cb = new THREE.Vector3(), ab = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const a = corner(t, 0), b = corner(t, 1), c = corner(t, 2);
    triCanon.push([canonOf(a), canonOf(b), canonOf(c)]);
    vA.fromBufferAttribute(pos, a); vB.fromBufferAttribute(pos, b); vC.fromBufferAttribute(pos, c);
    cb.subVectors(vC, vB); ab.subVectors(vA, vB); cb.cross(ab);
    if (cb.lengthSq() > 0) cb.normalize();
    normals.push(cb.clone());
  }

  // Map each undirected edge (canonical vertex pair) to its triangles.
  const ekey = (p: number, q: number): string => (p < q ? `${p}_${q}` : `${q}_${p}`);
  const edgeMap = new Map<string, number[]>();
  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = triCanon[t];
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const k = ekey(p, q);
      const arr = edgeMap.get(k);
      if (arr) arr.push(t); else edgeMap.set(k, [t]);
    }
  }

  // Flood-fill across shared edges where the normal angle is within tolerance.
  const cosTol = Math.cos((angleToleranceDeg * Math.PI) / 180);
  const facetOf = new Array<number>(triCount).fill(-1);
  let facetId = 0;
  for (let start = 0; start < triCount; start++) {
    if (facetOf[start] !== -1) continue;
    facetOf[start] = facetId;
    const stack = [start];
    while (stack.length) {
      const t = stack.pop()!;
      const [a, b, c] = triCanon[t];
      for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
        for (const nt of edgeMap.get(ekey(p, q)) ?? []) {
          if (nt === t || facetOf[nt] !== -1) continue;
          if (triangleRegion && triangleRegion[t] !== triangleRegion[nt]) continue;
          if (normals[t].dot(normals[nt]) >= cosTol) {
            facetOf[nt] = facetId;
            stack.push(nt);
          }
        }
      }
    }
    facetId++;
  }
  return facetOf;
}

/**
 * Replaces a loaded `THREE.Mesh` with a `THREE.Group` of per-facet sub-meshes so
 * individual flat faces can be picked and coloured — mirroring the B-rep
 * per-face model. The group is the pickable **volume** (`groupId = volumeId`);
 * each facet sub-mesh is a **surface** entity (`entityId = volumeId/face-K`).
 *
 * If the mesh yields no facets, or more than {@link MAX_FACETS} (e.g. an organic
 * curved mesh), it is kept whole as a single surface to avoid a draw-call
 * explosion. Returns the object that should stand in for `mesh`.
 *
 * `triangleRegion`, when given, is forwarded to {@link segmentCoplanarFacets}
 * (see its doc comment) — used only for meshio++-imported documents.
 */
export function buildMeshFacetGroup(mesh: THREE.Mesh, volumeId: string, triangleRegion?: ArrayLike<number>): THREE.Object3D {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const facetOf = segmentCoplanarFacets(geometry, FACET_ANGLE_TOLERANCE, triangleRegion);
  const facetCount = facetOf.length ? Math.max(...facetOf) + 1 : 0;

  if (facetCount <= 1 || facetCount > MAX_FACETS) {
    // Keep the mesh whole; expose it as one surface entity.
    mesh.userData.groupId = volumeId;
    mesh.userData.entityType = "surface";
    mesh.userData.entityId = `${volumeId}/face-0`;
    // BVH-accelerate kept-whole meshes (the dense-scan case — see Tier 2 item
    // 1 in doc/roadmap.md). `indirect: true` preserves the original triangle
    // order so any index-based logic stays correct if later code keys on it.
    // The BVH lives with the geometry for the session; it is freed when the
    // geometry is disposed on document close — no per-rebuild disposal needed
    // (the geometry is shared with the cached pristine clone).
    const geo = mesh.geometry as THREE.BufferGeometry;
    if (!geo.boundsTree) {
      try {
        geo.computeBoundsTree?.({ indirect: true });
      } catch {
        // BVH build failure is non-fatal — fall back to brute-force raycast.
      }
    }
    return mesh;
  }

  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.getIndex();
  const corner = (t: number, k: number): number =>
    index ? index.getX(t * 3 + k) : t * 3 + k;

  const buckets: number[][] = Array.from({ length: facetCount }, () => []);
  facetOf.forEach((f, t) => buckets[f].push(t));

  const group = new THREE.Group();
  group.name = mesh.name;
  group.userData.groupId = volumeId;
  group.position.copy(mesh.position);
  group.quaternion.copy(mesh.quaternion);
  group.scale.copy(mesh.scale);

  buckets.forEach((tris, fIdx) => {
    const positions = new Float32Array(tris.length * 9);
    let o = 0;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const vi = corner(t, k);
        positions[o++] = pos.getX(vi);
        positions[o++] = pos.getY(vi);
        positions[o++] = pos.getZ(vi);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, makeFaceMaterial());
    // Same stash `geometryBuilder.ts`'s `buildFaceMesh()` does — required by
    // `Viewer.setDisplayMode()`'s Flat mode material swap.
    m.userData.standardMaterial = m.material;
    m.userData.groupId = volumeId;
    m.userData.entityType = "surface";
    m.userData.entityId = `${volumeId}/face-${fIdx}`;
    group.add(m);
  });

  return group;
}

function disposeMesh(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  const mat = mesh.material as THREE.Material | THREE.Material[];
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose()); else mat.dispose();
}

/**
 * Replaces every `THREE.Mesh` in a loaded model with a facetted group (see
 * {@link buildMeshFacetGroup}). Each mesh's existing `userData.groupId` (a stable
 * `node-N` id) becomes its volume id, so the Components tree highlight keeps
 * working. Returns the (possibly new) root — when the loaded object IS a mesh
 * (e.g. a single-mesh STL), it has no parent and is replaced by its facet group.
 *
 * `triangleRegion`, when given, is applied to whichever single mesh is found
 * (a meshio++ import always yields exactly one root mesh — the STL boundary
 * — so there is never an ambiguity about which mesh it applies to); see
 * {@link segmentCoplanarFacets}'s doc comment.
 */
export function splitMeshesIntoFacets(object: THREE.Object3D, triangleRegion?: ArrayLike<number>): THREE.Object3D {
  // Root-is-mesh: nothing to splice into, so return the replacement directly.
  if (object instanceof THREE.Mesh) {
    const volumeId = (object.userData.groupId as string) ?? object.uuid;
    const replacement = buildMeshFacetGroup(object, volumeId, triangleRegion);
    if (replacement !== object) disposeMesh(object);
    return replacement;
  }

  const meshes: THREE.Mesh[] = [];
  object.traverse((o) => { if (o instanceof THREE.Mesh) meshes.push(o); });
  for (const mesh of meshes) {
    const volumeId = (mesh.userData.groupId as string) ?? mesh.uuid;
    const replacement = buildMeshFacetGroup(mesh, volumeId, triangleRegion);
    if (replacement !== mesh && mesh.parent) {
      mesh.parent.add(replacement);
      mesh.parent.remove(mesh);
      disposeMesh(mesh);
    }
  }
  return object;
}
