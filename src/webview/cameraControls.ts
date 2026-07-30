import * as THREE from "three";

/**
 * Pure camera-manipulation helpers shared by the {@link Viewer} methods and the
 * orientation cube. Each operates on a camera and an orbit `target`, mutating them
 * in place — no DOM, renderer, or OrbitControls needed, so they are unit-testable.
 *
 * `Viewer` keeps two camera objects (a `PerspectiveCamera` and an
 * `OrthographicCamera`) and swaps which one is "active" for the ortho/perspective
 * toggle — see `Viewer.setOrthographic`. `orbit`/`setDirection`/`viewDirection`
 * are pure position math and work unchanged on either camera type; `pan`/`dolly`
 * are NOT — perspective's "how far is one pan/dolly unit" derives from FOV
 * (meaningless for an orthographic projection, which has no FOV), so both branch
 * on `camera instanceof THREE.OrthographicCamera` (also narrows the type, unlike
 * the runtime-only `isOrthographicCamera` flag these classes carry).
 */

export type ViewerCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

const EPS = 1e-4;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Orbits the camera around `target` by the given azimuth/polar degrees. */
export function orbit(
  camera: ViewerCamera,
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

/**
 * Pans the camera and `target` together by fractions of the framed extent.
 * Perspective: the pan unit is derived from FOV + distance-to-target (a
 * larger FOV or distance means each fractional pan covers more world space).
 * Orthographic: FOV doesn't exist — the equivalent "how much world space one
 * pan unit covers" is the frustum's half-height divided by the current zoom.
 */
export function pan(camera: ViewerCamera, target: THREE.Vector3, dxFrac: number, dyFrac: number): void {
  camera.updateMatrix();
  const amount = camera instanceof THREE.OrthographicCamera
    ? (camera.top - camera.bottom) / camera.zoom / 2
    : camera.position.distanceTo(target) * Math.tan(toRad(camera.fov) / 2);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
  const delta = right
    .multiplyScalar(dxFrac * amount)
    .add(up.multiplyScalar(dyFrac * amount));
  camera.position.add(delta);
  target.add(delta);
}

/**
 * Dollies toward (`factor` < 1) or away from (`> 1`) the target. Perspective:
 * moves the camera's position (apparent size changes with distance).
 * Orthographic: moving position has NO visual zoom effect under a parallel
 * projection — the equivalent is scaling `camera.zoom` inversely to `factor`
 * (position is left untouched, matching how three.js's own OrbitControls
 * dollies an orthographic camera on mouse-wheel).
 */
export function dolly(camera: ViewerCamera, target: THREE.Vector3, factor: number): void {
  if (camera instanceof THREE.OrthographicCamera) {
    camera.zoom = Math.max(1e-4, camera.zoom / factor);
    camera.updateProjectionMatrix();
    return;
  }
  const offset = camera.position.clone().sub(target);
  offset.multiplyScalar(factor);
  camera.position.copy(target).add(offset);
}

/** Repositions the camera along `dir`, keeping the current target and distance. */
export function setDirection(camera: ViewerCamera, target: THREE.Vector3, dir: THREE.Vector3): void {
  const distance = camera.position.distanceTo(target);
  camera.position.copy(target).addScaledVector(dir.clone().normalize(), distance);
}

/** Normalized direction from `target` to the camera. */
export function viewDirection(camera: ViewerCamera, target: THREE.Vector3): THREE.Vector3 {
  return camera.position.clone().sub(target).normalize();
}
