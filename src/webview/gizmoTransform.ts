import * as THREE from "three";

/**
 * Pure delta-application math for the Transform Gizmo (roadmap "Transform
 * gizmo", closed) — mirrors `cameraControls.ts`'s convention of keeping pure
 * Three.js math (no DOM, no `Viewer` dependency) in its own headless-testable
 * module. `THREE.Vector3`/`THREE.Quaternion` are plain data objects with no
 * DOM/canvas dependency, so this unit-tests without jsdom, unlike the
 * DOM-touching `Viewer`/`main.ts` code that calls it.
 *
 * The gizmo's own proxy object is always reset to `position = pivot,
 * quaternion = identity, scale = (1,1,1)` at attach time (see
 * `Viewer.attachTransformGizmo`), so its live transform after any drag
 * directly IS the delta — `GizmoDelta` below is that raw read, and these
 * functions apply it to one target's PRISTINE captured base (never
 * compounding onto an already-dragged frame, the same discipline
 * `explodePreview.ts` already established for the Explode slider).
 */

export interface GizmoDelta {
  /** World-space translation, pivot already subtracted out. */
  positionDelta: THREE.Vector3;
  /** World-space rotation (the proxy's base rotation is always identity, so
   * this needs no subtraction). */
  quaternionDelta: THREE.Quaternion;
  /** Per-axis world-space scale factor (the proxy's base scale is always
   * (1,1,1), so this needs no division). */
  scaleDelta: THREE.Vector3;
  /** The rotation/scale centre — the gizmo's position at attach time. */
  pivot: THREE.Vector3;
}

export interface TransformBase {
  basePosition: THREE.Vector3;
  baseQuaternion: THREE.Quaternion;
  baseScale: THREE.Vector3;
}

/** A pure translation: every target moves by the same world-space vector,
 * orientation/scale untouched. */
export function applyTranslateDelta(base: TransformBase, delta: GizmoDelta): { position: THREE.Vector3 } {
  return { position: base.basePosition.clone().add(delta.positionDelta) };
}

/**
 * Rotates a target about `delta.pivot` (NOT about the target's own
 * position) — a target off-centre from the pivot must also revolve around
 * it, so both its position and orientation change. Verified by construction:
 * a target exactly AT the pivot has `offset = (0,0,0)`, so only its
 * orientation changes, matching single-object rotation-in-place.
 */
export function applyRotateDelta(base: TransformBase, delta: GizmoDelta): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const offset = base.basePosition.clone().sub(delta.pivot).applyQuaternion(delta.quaternionDelta);
  return {
    position: delta.pivot.clone().add(offset),
    quaternion: delta.quaternionDelta.clone().multiply(base.baseQuaternion),
  };
}

/**
 * Scales a target about `delta.pivot`, component-wise — the exact same
 * `x' = pivot + s·(x − pivot)` affine formula `occtOperations.ts`'s
 * non-uniform-scale edit op already uses server-side (`gp_GTrsf`'s
 * `SetValue(1,4, cx - sx*cx)` term is the identical formula, just written
 * per-component instead of as a translate-then-scale composition), so this
 * preview and the eventual real replay agree on what "scale about a centre"
 * means.
 */
export function applyScaleDelta(base: TransformBase, delta: GizmoDelta): { position: THREE.Vector3; scale: THREE.Vector3 } {
  const offset = base.basePosition.clone().sub(delta.pivot).multiply(delta.scaleDelta);
  return {
    position: delta.pivot.clone().add(offset),
    scale: base.baseScale.clone().multiply(delta.scaleDelta),
  };
}

/**
 * Decomposes a quaternion into an axis + angle (radians) — `THREE.Quaternion`
 * has no built-in accessor for this. Degenerates to an arbitrary axis
 * (+Z) at zero rotation (`sin(angle/2) ≈ 0`, axis is genuinely undefined at
 * that point) rather than dividing by zero.
 */
export function quaternionToAxisAngle(q: THREE.Quaternion): { axis: THREE.Vector3; angleRad: number } {
  const w = Math.min(1, Math.max(-1, q.w)); // clamp against float drift past ±1
  const angleRad = 2 * Math.acos(w);
  const s = Math.sqrt(1 - w * w);
  const axis = s < 1e-6 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(q.x, q.y, q.z).divideScalar(s);
  return { axis, angleRad };
}
