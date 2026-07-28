import * as THREE from "three";

export interface MeshMassProperties {
  /** Signed-tetrahedra volume, meaningful only when `meshes` forms a closed
   * (watertight) surface — e.g. a whole loaded object or one "volume" pick's
   * facets, never a single open facet ("surface" pick). */
  volume: number;
  area: number;
  /** Volume-weighted center of mass — the physically meaningful centroid for
   * a closed body. Meaningless (defaults to the area centroid) if `volume`
   * isn't meaningful for this selection. */
  volumeCentroid: [number, number, number];
  /** Area-weighted centroid of the surface — the right centroid for a single
   * open facet, where a signed volume has no physical meaning. */
  areaCentroid: [number, number, number];
}

/**
 * Volume + surface area + both centroid flavors for one or more Three.js
 * meshes, computed entirely client-side (no host round trip — mesh sources
 * have no OCCT shape to query `BRepGProp` against). Promotes the signed-
 * tetrahedra volume algorithm already proven in `meshEdits.test.ts`'s
 * test-only `volumeOf()` helper to production code, adding the matching
 * triangle-area sum and both centroid accumulations in the same triangle
 * loop. World-transformed via `matrixWorld` (`updateWorldMatrix` is called
 * defensively — callers should not assume it's already current).
 *
 * Volume decomposes the mesh into tetrahedra with an apex at the origin: for
 * triangle (a, b, c), the signed tetra volume is `a·(b×c)/6` and its centroid
 * (apex contributes 0) is `(a+b+c)/4` — summing `Σ(vᵢ·cᵢ) / Σvᵢ` gives the
 * volume-weighted center of mass, independent of the coordinate origin, same
 * standard result `BRepGProp.VolumeProperties` computes for a B-rep solid.
 * Passing multiple meshes (e.g. every facet of one "volume" pick) sums all
 * their triangles together, so per-entity (not just whole-model) results
 * fall out of the same function with no special-casing.
 */
export function computeMeshMassProperties(meshes: THREE.Mesh[]): MeshMassProperties {
  let volumeSum = 0;
  let volumeCx = 0;
  let volumeCy = 0;
  let volumeCz = 0;
  let areaSum = 0;
  let areaCx = 0;
  let areaCy = 0;
  let areaCz = 0;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();

  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");
    const index = geometry.getIndex();
    const count = index ? index.count : position.count;

    for (let i = 0; i < count; i += 3) {
      a.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2).applyMatrix4(mesh.matrixWorld);

      const tetraVolume = a.dot(cross.crossVectors(b, c)) / 6;
      volumeSum += tetraVolume;
      volumeCx += tetraVolume * ((a.x + b.x + c.x) / 4);
      volumeCy += tetraVolume * ((a.y + b.y + c.y) / 4);
      volumeCz += tetraVolume * ((a.z + b.z + c.z) / 4);

      const triArea = cross.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).length() / 2;
      areaSum += triArea;
      areaCx += triArea * ((a.x + b.x + c.x) / 3);
      areaCy += triArea * ((a.y + b.y + c.y) / 3);
      areaCz += triArea * ((a.z + b.z + c.z) / 3);
    }
  }

  const volume = Math.abs(volumeSum);
  const volumeCentroid: [number, number, number] =
    Math.abs(volumeSum) > 1e-12
      ? [volumeCx / volumeSum, volumeCy / volumeSum, volumeCz / volumeSum]
      : areaSum > 0
        ? [areaCx / areaSum, areaCy / areaSum, areaCz / areaSum]
        : [0, 0, 0];
  const areaCentroid: [number, number, number] =
    areaSum > 0 ? [areaCx / areaSum, areaCy / areaSum, areaCz / areaSum] : [0, 0, 0];

  return { volume, area: areaSum, volumeCentroid, areaCentroid };
}
