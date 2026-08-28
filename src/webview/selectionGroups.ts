/**
 * Computed selection groups for the right-click context menu — "select everything
 * like this one".
 *
 * This is the closed query-filter feature given a discoverable entry point, and
 * the reuse is exact: the predicates are `selectFilters.ts`'s own
 * (`applyFaceFilter`/`applyLineFilter`), and **the right-clicked entity supplies
 * the argument** the filter form otherwise makes you type. "Larger than this" is
 * literally `areaGte` with the clicked face's own area — no second predicate
 * vocabulary, as the roadmap requires.
 *
 * Pure (THREE yes, DOM no) and unit-testable, matching `selectFilters.ts`'s own
 * split; `main.ts` owns the menu element.
 */

import * as THREE from "three";
import type { Object3D } from "three";
import type { EntityType } from "../protocol";
import type { SelectedEntity } from "./selection";
import {
  DEFAULT_DIRECTION_TOLERANCE_DEG,
  applyFaceFilter,
  applyLineFilter,
  edgeDirection,
  edgeLength,
  faceArea,
  faceNormal,
} from "./selectFilters";

/** One menu row: a label with its member count, and the selection it would make. */
export interface SelectionGroup {
  id: string;
  label: string;
  entities: SelectedEntity[];
}

const entityOf = (obj: Object3D): SelectedEntity | null => {
  const ud = obj.userData as { entityType?: string; entityId?: string };
  return ud.entityType && ud.entityId
    ? { entityType: ud.entityType as EntityType, entityId: ud.entityId }
    : null;
};

/** The object carrying `entityId`, or null. */
function findByEntityId(targets: Object3D[], entityId: string): Object3D | null {
  for (const obj of targets) {
    if ((obj.userData as { entityId?: string }).entityId === entityId) return obj;
  }
  return null;
}

/**
 * Faces whose normal points the same way as `reference`, within `toleranceDeg`.
 *
 * Composed from `selectFilters.ts`'s own exported `faceNormal` plus its
 * `DEFAULT_DIRECTION_TOLERANCE_DEG`, rather than added to `FACE_FILTERS`:
 * "same as the one under the cursor" takes a REFERENCE ENTITY, which the
 * registry's `argKind: "none" | "value" | "count"` cannot express. Direction
 * is sign-SENSITIVE here (unlike the registry's sign-insensitive axis filters)
 * — the opposite face of a box points the other way and is not "the same".
 */
export function facesWithNormalLike(
  targets: Object3D[],
  reference: THREE.Vector3,
  toleranceDeg = DEFAULT_DIRECTION_TOLERANCE_DEG
): SelectedEntity[] {
  const cosTol = Math.cos((toleranceDeg * Math.PI) / 180);
  const out: SelectedEntity[] = [];
  for (const obj of targets) {
    if (!(obj instanceof THREE.Mesh)) continue;
    const ent = entityOf(obj);
    if (!ent || ent.entityType !== "surface") continue;
    const n = faceNormal(obj);
    if (n && n.dot(reference) >= cosTol) out.push(ent);
  }
  return out;
}

/**
 * Edges whose chord direction is parallel to `reference`, within
 * `toleranceDeg`. Sign-INSENSITIVE — an edge drawn end-to-start is the same
 * direction, matching the registry's own `alongX/Y/Z` convention.
 */
export function edgesParallelTo(
  targets: Object3D[],
  reference: THREE.Vector3,
  toleranceDeg = DEFAULT_DIRECTION_TOLERANCE_DEG
): SelectedEntity[] {
  const cosTol = Math.cos((toleranceDeg * Math.PI) / 180);
  const out: SelectedEntity[] = [];
  for (const obj of targets) {
    if (!(obj instanceof THREE.Line)) continue;
    const ent = entityOf(obj);
    if (!ent || ent.entityType !== "line") continue;
    const d = edgeDirection(obj);
    if (d && Math.abs(d.dot(reference)) >= cosTol) out.push(ent);
  }
  return out;
}

/**
 * The groups offered for the entity under the cursor.
 *
 * Returns `[]` for volume and point modes — the same gate the filter form
 * applies (`filterSupportsMode`), for the same reason: there is no predicate
 * vocabulary for them. An empty result is rendered as an explanatory row rather
 * than an empty menu.
 *
 * A group that would match nothing beyond the clicked entity itself is dropped:
 * a row reading "(1)" offers nothing a click has not already done.
 */
export function selectionGroupsFor(
  targets: Object3D[],
  mode: EntityType,
  entityId: string,
  toleranceDeg = DEFAULT_DIRECTION_TOLERANCE_DEG
): SelectionGroup[] {
  const clicked = findByEntityId(targets, entityId);
  if (!clicked) return [];
  const groups: SelectionGroup[] = [];

  if (mode === "surface" && clicked instanceof THREE.Mesh) {
    const normal = faceNormal(clicked);
    if (normal) {
      groups.push({
        id: "sameNormal",
        label: "Same facing",
        entities: facesWithNormalLike(targets, normal, toleranceDeg),
      });
    }
    groups.push({ id: "planar", label: "Planar faces", entities: applyFaceFilter(targets, "planar", 0, toleranceDeg) });

    // The clicked face's own area IS the threshold — this is the query form's
    // `areaGte`/`areaLte` with the number filled in for you.
    const area = faceArea(clicked);
    if (area > 0) {
      groups.push({ id: "areaGte", label: "Area ≥ this", entities: applyFaceFilter(targets, "areaGte", area, toleranceDeg) });
      groups.push({ id: "areaLte", label: "Area ≤ this", entities: applyFaceFilter(targets, "areaLte", area, toleranceDeg) });
    }
  }

  if (mode === "line" && clicked instanceof THREE.Line) {
    const dir = edgeDirection(clicked);
    if (dir) {
      groups.push({ id: "parallel", label: "Parallel to this", entities: edgesParallelTo(targets, dir, toleranceDeg) });
    }
    const len = edgeLength(clicked);
    if (len > 0) {
      groups.push({ id: "lengthGte", label: "Length ≥ this", entities: applyLineFilter(targets, "lengthGte", len, false, toleranceDeg) });
      groups.push({ id: "lengthLte", label: "Length ≤ this", entities: applyLineFilter(targets, "lengthLte", len, false, toleranceDeg) });
    }
  }

  return groups.filter((g) => g.entities.length > 1);
}
