import type { Object3D } from "three";
import type { EntityType } from "../protocol";

export interface PickResult {
  entityType: EntityType;
  entityId: string;
}

interface EntityUserData {
  entityType?: string;
  entityId?: string;
  groupId?: string;
}

/**
 * Maps a raycast-hit object's `userData` plus the active selection `mode` to the
 * entity that should be selected. In `volume` and `surface` modes the hit object
 * is a face mesh; `volume` resolves up to the parent solid (`groupId`), `surface`
 * keeps the face. In `line` mode the hit object is an edge line. In `point` mode
 * the hit object is a point sprite — a leaf entity, never "resolved up".
 */
export function resolvePick(userData: EntityUserData, mode: EntityType): PickResult | null {
  if (mode === "point") {
    if (userData.entityType === "point" && userData.entityId) {
      return { entityType: "point", entityId: userData.entityId };
    }
    return null;
  }
  if (mode === "line") {
    if (userData.entityType === "line" && userData.entityId) {
      return { entityType: "line", entityId: userData.entityId };
    }
    return null;
  }
  if (userData.entityType !== "surface") return null;
  if (mode === "surface" && userData.entityId) {
    return { entityType: "surface", entityId: userData.entityId };
  }
  if (mode === "volume" && userData.groupId) {
    return { entityType: "volume", entityId: userData.groupId };
  }
  return null;
}

/**
 * Collects the raycast target objects for a selection `mode`: point sprites for
 * `point`, edge lines for `line`, face meshes otherwise (a `volume` pick starts
 * from a face and resolves to its solid via {@link resolvePick}).
 */
export function collectTargets(root: Object3D, mode: EntityType): Object3D[] {
  const wantPoint = mode === "point";
  const wantLine = mode === "line";
  const out: Object3D[] = [];
  root.traverse((o) => {
    const t = (o.userData as EntityUserData)?.entityType;
    if (wantPoint ? t === "point" : wantLine ? t === "line" : t === "surface") out.push(o);
  });
  return out;
}

/**
 * Measurement's raycast target set — unlike {@link collectTargets}, this is
 * NOT mode-gated: every pickable surface/line/point is a candidate at once,
 * since a measurement (distance, angle) may combine picks of different kinds
 * in a single session. Deliberately excludes anything tagged `"mesh"` (the FE
 * overlay) — same exclusion `collectTargets` gets implicitly by only matching
 * `"surface"|"line"|"point"`.
 */
export function collectMeasureTargets(root: Object3D): Object3D[] {
  const out: Object3D[] = [];
  root.traverse((o) => {
    const t = (o.userData as EntityUserData)?.entityType;
    if (t === "surface" || t === "line" || t === "point") out.push(o);
  });
  return out;
}

/**
 * Resolves a raycast hit's `userData` to a measurement target — unlike
 * {@link resolvePick}, never "resolves up" to a parent solid (a `surface` hit
 * stays a `surface`); measurement always operates on the leaf entity actually
 * clicked.
 */
export function resolveMeasurePick(userData: EntityUserData): PickResult | null {
  if (userData.entityType === "surface" && userData.entityId) {
    return { entityType: "surface", entityId: userData.entityId };
  }
  if (userData.entityType === "line" && userData.entityId) {
    return { entityType: "line", entityId: userData.entityId };
  }
  if (userData.entityType === "point" && userData.entityId) {
    return { entityType: "point", entityId: userData.entityId };
  }
  return null;
}
