import * as THREE from "three";

/** One top-level group's pristine position plus its precomputed offset direction. */
export interface ExplodeBase {
  object: THREE.Object3D;
  basePosition: THREE.Vector3;
  /** `groupCentre - modelCentre` at capture time — the direction/magnitude the
   * group spreads along; scaled by the live factor on every preview tick. */
  offsetFromCentre: THREE.Vector3;
}

/**
 * Snapshots every solid/volume top-level group's pristine position for a live
 * exploded-view preview — the same math `applyMeshExplode`
 * (`src/webview/meshEdits.ts`) already uses for the *committed* mesh-format
 * explode op (`Box3` of the whole root → centre; per top-level child `Box3` →
 * its centre; offset = `(childCentre - modelCentre)`), lifted into a
 * format-agnostic function usable on `viewer.getModel()`'s root directly —
 * B-rep roots (`buildGroupFromEncoded`) and mesh-loaded roots share the same
 * "root → per-solid/volume `THREE.Group` tagged `userData.groupId`" shape.
 *
 * Only `userData.groupId`-tagged children are captured/moved. For a B-rep
 * root this deliberately EXCLUDES the top-level "edges"/"points" groups
 * (which carry no `groupId` of their own) — they stay in place during the
 * live preview, a known, acceptable limitation since this is a preview only;
 * the *committed* op still round-trips through the host, which re-tessellates
 * edges/points correctly along with everything else.
 *
 * Must be called fresh every time a preview session starts (slider
 * focus/mousedown) — never reused across a stale model reference, and never
 * reused across two different preview sessions.
 */
export function captureExplodeBase(root: THREE.Object3D): ExplodeBase[] {
  const whole = new THREE.Box3().setFromObject(root);
  if (whole.isEmpty()) return [];
  const centre = whole.getCenter(new THREE.Vector3());
  const bases: ExplodeBase[] = [];
  for (const child of root.children) {
    if (!child.userData.groupId) continue;
    const box = new THREE.Box3().setFromObject(child);
    if (box.isEmpty()) continue;
    const childCentre = box.getCenter(new THREE.Vector3());
    bases.push({
      object: child,
      basePosition: child.position.clone(),
      offsetFromCentre: childCentre.clone().sub(centre),
    });
  }
  return bases;
}

/**
 * Applies `factor` to every captured group, computed from the CACHED base
 * position every call — never compounding onto whatever the previous call
 * left behind. Safe to call on every slider `input` event.
 */
export function applyExplodePreview(bases: ExplodeBase[], factor: number): void {
  const offset = new THREE.Vector3();
  for (const b of bases) {
    offset.copy(b.offsetFromCentre).multiplyScalar(factor);
    b.object.position.copy(b.basePosition).add(offset);
  }
}

/** Restores every captured group to its pristine position — call both when a
 * preview session ends without committing, and immediately before the real
 * op-stack commit (which rebuilds everything from the authoritative op-list
 * anyway, so the preview transform must never be left stacked on top of it). */
export function resetExplodePreview(bases: ExplodeBase[]): void {
  for (const b of bases) b.object.position.copy(b.basePosition);
}
