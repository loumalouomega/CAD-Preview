import * as THREE from "three";

/**
 * Pure camera-manipulation helpers shared by the {@link Viewer} methods and the
 * orientation cube. Each operates on a camera and an orbit `target`, mutating them
 * in place — no DOM, renderer, or OrbitControls needed, so they are unit-testable.
 */

const EPS = 1e-4;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Orbits the camera around `target` by the given azimuth/polar degrees. */
export function orbit(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  azimuthDeg: number,
  polarDeg: number
): void {
  const offset = camera.position.clone().sub(target);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  spherical.theta += toRad(azimuthDeg);
  spherical.phi += toRad(polarDeg);
  spherical.phi = Math.max(EPS, Math.min(Math.PI - EPS, spherical.phi));
  spherical.makeSafe();
  offset.setFromSpherical(spherical);
  camera.position.copy(target).add(offset);
}

/** Pans the camera and `target` together by fractions of the framed extent. */
export function pan(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  dxFrac: number,
  dyFrac: number
): void {
  camera.updateMatrix();
  const distance = camera.position.distanceTo(target);
  const amount = distance * Math.tan(toRad(camera.fov) / 2);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
  const delta = right
    .multiplyScalar(dxFrac * amount)
    .add(up.multiplyScalar(dyFrac * amount));
  camera.position.add(delta);
  target.add(delta);
}

/** Dollies the camera toward (`factor` < 1) or away from (`> 1`) the target. */
export function dolly(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  factor: number
): void {
  const offset = camera.position.clone().sub(target);
  offset.multiplyScalar(factor);
  camera.position.copy(target).add(offset);
}

/** Repositions the camera along `dir`, keeping the current target and distance. */
export function setDirection(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  dir: THREE.Vector3
): void {
  const distance = camera.position.distanceTo(target);
  camera.position.copy(target).addScaledVector(dir.clone().normalize(), distance);
}

/** Normalized direction from `target` to the camera. */
export function viewDirection(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3
): THREE.Vector3 {
  return camera.position.clone().sub(target).normalize();
}
