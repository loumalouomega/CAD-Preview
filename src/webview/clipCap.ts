import * as THREE from "three";

/**
 * Marks the stencil buffer for one clipped mesh: a back-face-increment and
 * front-face-decrement twin sharing its geometry (never disposed here — see
 * `disposeClipCap`), positioned to match its CURRENT world transform via a
 * frozen `matrix` copy rather than parenting, so this works regardless of
 * where the source mesh sits in its own hierarchy. Both are invisible
 * (`colorWrite: false`) and ignore the depth buffer (`depthTest: false`) —
 * see `buildClipCap`'s doc comment for why the accumulated count is correct.
 */
function stencilMarkerPair(source: THREE.Mesh, plane: THREE.Plane, renderOrder: number): THREE.Mesh[] {
  const shared = {
    depthWrite: false,
    depthTest: false,
    colorWrite: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    clippingPlanes: [plane] as THREE.Plane[],
  };

  const back = new THREE.MeshBasicMaterial({
    ...shared,
    side: THREE.BackSide,
    stencilFail: THREE.IncrementWrapStencilOp,
    stencilZFail: THREE.IncrementWrapStencilOp,
    stencilZPass: THREE.IncrementWrapStencilOp,
  });
  const front = new THREE.MeshBasicMaterial({
    ...shared,
    side: THREE.FrontSide,
    stencilFail: THREE.DecrementWrapStencilOp,
    stencilZFail: THREE.DecrementWrapStencilOp,
    stencilZPass: THREE.DecrementWrapStencilOp,
  });

  const meshes = [new THREE.Mesh(source.geometry, back), new THREE.Mesh(source.geometry, front)];
  for (const m of meshes) {
    m.matrixAutoUpdate = false;
    m.matrix.copy(source.matrixWorld);
    m.renderOrder = renderOrder;
  }
  return meshes;
}

/**
 * Builds a solid-looking cap over a clip plane's cross-section — the
 * standard three.js stencil-buffer technique (see the official
 * `webgl_clipping_stencil` example, which this closely follows): render the
 * FULL boundary of every clipped solid TWICE, back faces incrementing the
 * stencil buffer and front faces decrementing it, both invisible and
 * ignoring the depth buffer. For a genuinely closed (watertight) boundary,
 * the accumulated stencil value at a given pixel is exactly the parity of
 * how many times the view ray crosses that boundary before reaching the cut
 * plane — nonzero precisely where that point sits INSIDE a solid. A single
 * large quad, drawn afterward with a `stencilFunc: NotEqual` test against 0,
 * then paints solid color only there: a real opaque "cut face," not the
 * see-through hollow `MeshStandardMaterial` + `clippingPlanes` alone gives.
 *
 * The marking step is submitted per SOURCE MESH, not merged into one
 * geometry first — deliberately. In this codebase a solid's boundary is N
 * separate per-face `THREE.Mesh`es (see `geometryBuilder.ts`), not one
 * watertight `BufferGeometry` per solid. The stencil buffer accumulates
 * additively across draw calls regardless of how many separate geometries
 * contribute the same triangles, so submitting each face mesh through its
 * own back/front pair — into the SAME stencil buffer, before the cap draws —
 * gives an identical result to merging them first, with no merge step
 * needed. This also means feeding the same solid's boundary in TWICE (e.g.
 * accidentally including both a hidden model face and the FE-mesh overlay
 * covering it) is harmless for a `!= 0` test — doubling a nonzero count
 * stays nonzero, doubling zero stays zero — merely wasteful, not wrong;
 * still, callers should pass only the currently-visible target meshes.
 *
 * Requires the renderer to have been created with `{ stencil: true }` —
 * without a stencil buffer, the marking passes are silent no-ops and the cap
 * never appears (the model still looks correctly clipped, just uncapped, as
 * it did before this module existed).
 */
export function buildClipCap(
  targets: THREE.Mesh[],
  plane: THREE.Plane,
  center: THREE.Vector3,
  size: number,
  color: number
): THREE.Group {
  const MARK_ORDER = 1;
  const CAP_ORDER = 2;

  const group = new THREE.Group();
  for (const target of targets) {
    for (const marker of stencilMarkerPair(target, plane, MARK_ORDER)) group.add(marker);
  }

  // Unit size, always resized via `.scale` (see `repositionClipCap`) — avoids
  // rebuilding this geometry on every offset-slider tick.
  const capGeometry = new THREE.PlaneGeometry(1, 1);
  const capMaterial = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.75,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  });
  const cap = new THREE.Mesh(capGeometry, capMaterial);
  cap.renderOrder = CAP_ORDER;
  // Reset the stencil buffer right after drawing the cap so leftover marks
  // (e.g. if `size` somehow undershoots the true cross-section) don't bleed
  // into whatever renders next — `Viewer.renderGizmo()`'s separate pass in
  // particular, which shares this same stencil buffer.
  cap.onAfterRender = (renderer) => renderer.clearStencil();
  repositionClipCap(cap, plane, center, size);
  group.add(cap);

  // Stashed so a cheap plane-move (see `repositionClipCap`) can find the cap
  // directly without a `traverse()` — the marker meshes carry no state a
  // move needs to touch (their `clippingPlanes` array already references the
  // SAME `plane` object the caller mutates in place).
  group.userData.capMesh = cap;
  group.userData.capGeometry = capGeometry;
  return group;
}

/** Repositions/reorients/resizes an existing cap mesh in place — the cheap
 * path an offset-slider drag or axis switch uses instead of a full
 * `buildClipCap` rebuild, since neither changes which meshes are targeted. */
export function repositionClipCap(cap: THREE.Mesh, plane: THREE.Plane, center: THREE.Vector3, size: number): void {
  cap.position.copy(center);
  cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal);
  cap.scale.set(size, size, 1);
}

/** Disposes everything `buildClipCap` created — every marker mesh's geometry
 * is a SOURCE mesh's own geometry (owned by `model`/`meshOverlay`, disposed
 * there) and must NOT be disposed here; only materials, plus the cap's own
 * (self-owned) `PlaneGeometry`. */
export function disposeClipCap(group: THREE.Group): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
  (group.userData.capGeometry as THREE.BufferGeometry | undefined)?.dispose();
}
