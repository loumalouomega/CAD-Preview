import * as THREE from "three";
import type { SelectedEntity } from "./selection";

/**
 * World-space bounds of a transient entity selection — the geometry behind
 * roadmap Tier 1 "Zoom to selection".
 *
 * THREE yes, DOM no (the `selectFilters.ts` precedent), so this is
 * unit-testable headless against hand-built scenes.
 *
 * Matching mirrors `Viewer.renderSelection`'s own key rule exactly: a
 * `volume` entity covers every object carrying its id as `groupId` (faces,
 * edges AND points of that solid), while `surface`/`line`/`point` match
 * their own `entityType` + `entityId`. A second copy of this rule would
 * drift; there is exactly one other place that states it.
 *
 * Hidden subtrees are excluded via `traverseVisible` (the `picking.ts`
 * precedent — `Raycaster` ignores `.visible`, and so does plain
 * `traverse`). A selection whose every object is hidden, or whose ids no
 * longer exist in the model (renumbered by an edit), yields `null` — the
 * caller reports "hidden or no longer in the model" rather than framing
 * an empty box, which `frameBox` would silently ignore (`isEmpty` early
 * return) and leave the user wondering why nothing happened.
 */
export function unionSelectionBounds(
  model: THREE.Object3D,
  entities: SelectedEntity[]
): THREE.Box3 | null {
  if (entities.length === 0) return null;
  const volumes = new Set<string>();
  const surfaces = new Set<string>();
  const lines = new Set<string>();
  const points = new Set<string>();
  for (const e of entities) {
    if (e.entityType === "volume") volumes.add(e.entityId);
    else if (e.entityType === "surface") surfaces.add(e.entityId);
    else if (e.entityType === "line") lines.add(e.entityId);
    else if (e.entityType === "point") points.add(e.entityId);
  }
  if (volumes.size === 0 && surfaces.size === 0 && lines.size === 0 && points.size === 0) return null;
  const box = new THREE.Box3();
  let matched = false;
  model.traverseVisible((o) => {
    const ud = (o.userData ?? {}) as { entityType?: string; entityId?: string; groupId?: string };
    const hit =
      (ud.groupId !== undefined && volumes.has(ud.groupId)) ||
      (ud.entityType === "surface" && ud.entityId !== undefined && surfaces.has(ud.entityId)) ||
      (ud.entityType === "line" && ud.entityId !== undefined && lines.has(ud.entityId)) ||
      (ud.entityType === "point" && ud.entityId !== undefined && points.has(ud.entityId));
    if (!hit) return;
    box.union(new THREE.Box3().setFromObject(o));
    matched = true;
  });
  return matched ? box : null;
}

/**
 * Guarantees a minimum framing size for degenerate selections (a single
 * point, a short edge): without this, `frameBox`'s `radius = maxDim * 0.5`
 * collapses toward zero and the camera dives onto the point itself. The
 * floor is relative to the model (`MIN_SELECTION_FRAC` of its diagonal),
 * never an absolute unit — an absolute epsilon is microscopic on a machine
 * frame and enormous on a millimetre screw. A no-op when the box already
 * meets the floor, so ordinary face/solid selections are never inflated.
 */
export const MIN_SELECTION_FRAC = 0.04;

export function padBoxToMinSize(box: THREE.Box3, modelDiagonal: number): void {
  if (box.isEmpty()) return;
  const minSize = modelDiagonal * MIN_SELECTION_FRAC;
  if (!(minSize > 0)) return;
  const size = box.getSize(new THREE.Vector3());
  const largest = Math.max(size.x, size.y, size.z);
  if (largest >= minSize) return;
  const pad = (minSize - largest) / 2;
  box.expandByVector(new THREE.Vector3(pad, pad, pad));
}
