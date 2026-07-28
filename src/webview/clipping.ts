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
