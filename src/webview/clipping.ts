import * as THREE from "three";

export type ClipAxis = "x" | "y" | "z";

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Builds a world-space clipping plane perpendicular to `axis`, positioned at
 * a fractional offset across `box`'s extent along that axis: `-1` is the
 * box's min face, `0` its centre, `1` its max face (clamped to `[-1, 1]`).
 *
 * The plane's normal points in the POSITIVE `axis` direction. Three.js
 * clipping keeps geometry on the side the normal faces
 * (`plane.distanceToPoint(point) >= 0`) and clips away the opposite side —
 * so sweeping `offsetFrac` from `-1` toward `1` moves the cut plane from the
 * box's min face toward its max face, progressively clipping away more of
 * the model from the max-axis end (a `0` offset shows exactly the model's
 * negative-axis half).
 */
export function planeForAxis(axis: ClipAxis, offsetFrac: number, box: THREE.Box3): THREE.Plane {
  const t = clamp(offsetFrac, -1, 1);
  const min = box.min[axis];
  const max = box.max[axis];
  const value = (min + max) / 2 + t * ((max - min) / 2);
  const normal = new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
  return new THREE.Plane(normal, -value);
}

/**
 * Where to centre a solid "cap" over `plane`'s cross-section through `box`,
 * and how large to make it — for the stencil-buffer clip-cap technique (see
 * `clipCap.ts`). Projects `box`'s own centre onto the plane, NOT the plane's
 * closest point to the world origin: a model far from the origin would put
 * that point (and therefore the cap) nowhere near the model. Sized to the
 * box's full 3D diagonal, which safely covers any 2D cross-section through
 * it regardless of where along the plane's own axes that cross-section sits.
 */
export function capCenterAndSize(plane: THREE.Plane, box: THREE.Box3): { center: THREE.Vector3; size: number } {
  const boxCenter = box.getCenter(new THREE.Vector3());
  const center = boxCenter.clone().addScaledVector(plane.normal, -plane.distanceToPoint(boxCenter));
  const size = box.getSize(new THREE.Vector3()).length();
  return { center, size };
}
