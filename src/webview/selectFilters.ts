import * as THREE from "three";
import type { Object3D } from "three";
import type { SelectedEntity } from "./selection";

/** Tolerance for normal / edge-direction axis matches (degrees). */
export const DEFAULT_DIRECTION_TOLERANCE_DEG = 5;

export type FilterArgKind = "none" | "value" | "count";

export interface FilterOption {
  id: string;
  label: string;
  argKind: FilterArgKind;
}

export const FACE_FILTERS: readonly FilterOption[] = [
  { id: "normalPx", label: "Normal +X", argKind: "none" },
  { id: "normalNx", label: "Normal −X", argKind: "none" },
  { id: "normalPy", label: "Normal +Y", argKind: "none" },
  { id: "normalNy", label: "Normal −Y", argKind: "none" },
  { id: "normalPz", label: "Normal +Z", argKind: "none" },
  { id: "normalNz", label: "Normal −Z", argKind: "none" },
  { id: "planar", label: "Planar", argKind: "none" },
  { id: "areaGte", label: "Area ≥", argKind: "value" },
  { id: "areaLte", label: "Area ≤", argKind: "value" },
  { id: "largestN", label: "Largest N", argKind: "count" },
  { id: "smallestN", label: "Smallest N", argKind: "count" },
] as const;

export const LINE_FILTERS: readonly FilterOption[] = [
  { id: "alongX", label: "Along X", argKind: "none" },
  { id: "alongY", label: "Along Y", argKind: "none" },
  { id: "alongZ", label: "Along Z", argKind: "none" },
  { id: "lengthGte", label: "Length ≥", argKind: "value" },
  { id: "lengthLte", label: "Length ≤", argKind: "value" },
  { id: "longestN", label: "Longest N", argKind: "count" },
  { id: "shortestN", label: "Shortest N", argKind: "count" },
] as const;

export type FaceFilterId = (typeof FACE_FILTERS)[number]["id"];
export type LineFilterId = (typeof LINE_FILTERS)[number]["id"];

function positionsOf(mesh: THREE.Mesh): Float32Array | null {
  const attr = (mesh.geometry as THREE.BufferGeometry).getAttribute("position") as THREE.BufferAttribute | undefined;
  return attr ? (attr.array as Float32Array) : null;
}

function forEachTriangle(
  mesh: THREE.Mesh,
  cb: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, normal: THREE.Vector3, area: number) => void
): void {
  const pos = positionsOf(mesh);
  if (!pos) return;
  const g = mesh.geometry as THREE.BufferGeometry;
  const idx = g.index ? (g.index.array as ArrayLike<number>) : null;
  const triCount = idx ? idx.length / 3 : pos.length / 9;
  for (let t = 0; t < triCount; t++) {
    let i0: number, i1: number, i2: number;
    if (idx) {
      i0 = (idx as unknown as number[])[t * 3] as number;
      i1 = (idx as unknown as number[])[t * 3 + 1] as number;
      i2 = (idx as unknown as number[])[t * 3 + 2] as number;
    } else {
      i0 = t * 3;
      i1 = t * 3 + 1;
      i2 = t * 3 + 2;
    }
    const ax = pos[i0 * 3], ay = pos[i0 * 3 + 1], az = pos[i0 * 3 + 2];
    const bx = pos[i1 * 3], by = pos[i1 * 3 + 1], bz = pos[i1 * 3 + 2];
    const cx = pos[i2 * 3], cy = pos[i2 * 3 + 1], cz = pos[i2 * 3 + 2];
    const ab = new THREE.Vector3(bx - ax, by - ay, bz - az);
    const ac = new THREE.Vector3(cx - ax, cy - ay, cz - az);
    const cr = new THREE.Vector3().crossVectors(ab, ac);
    const area = cr.length() * 0.5;
    if (area < 1e-12) continue;
    const n = cr.normalize();
    cb(new THREE.Vector3(ax, ay, az), new THREE.Vector3(bx, by, bz), new THREE.Vector3(cx, cy, cz), n, area);
  }
}

/** Total triangulated area of a face mesh. */
export function faceArea(mesh: THREE.Mesh): number {
  let sum = 0;
  forEachTriangle(mesh, (_a, _b, _c, _n, area) => {
    sum += area;
  });
  return sum;
}

/** Area-weighted mean normal of a face mesh, or null if degenerate. */
export function faceNormal(mesh: THREE.Mesh): THREE.Vector3 | null {
  const acc = new THREE.Vector3(0, 0, 0);
  let totalArea = 0;
  forEachTriangle(mesh, (_a, _b, _c, n, area) => {
    acc.addScaledVector(n, area);
    totalArea += area;
  });
  if (totalArea < 1e-12 || acc.lengthSq() < 1e-12) return null;
  return acc.normalize();
}

/** True when every triangle normal lies within `toleranceDeg` of the face's area-weighted mean normal. */
export function faceIsPlanar(mesh: THREE.Mesh, toleranceDeg = DEFAULT_DIRECTION_TOLERANCE_DEG): boolean {
  const mean = faceNormal(mesh);
  if (!mean) return false;
  const cosTol = Math.cos((toleranceDeg * Math.PI) / 180);
  let ok = true;
  forEachTriangle(mesh, (_a, _b, _c, n, _area) => {
    if (n.dot(mean) < cosTol - 1e-9) ok = false;
  });
  return ok;
}

function edgePolylinePositions(line: THREE.Line): Float32Array | null {
  const attr = (line.geometry as THREE.BufferGeometry).getAttribute("position") as THREE.BufferAttribute | undefined;
  return attr ? (attr.array as Float32Array) : null;
}

/** Polyline length of an edge line (sum of segment lengths). */
export function edgeLength(line: THREE.Line): number {
  const pos = edgePolylinePositions(line);
  if (!pos || pos.length < 6) return 0;
  let sum = 0;
  for (let i = 3; i < pos.length; i += 3) {
    const dx = pos[i] - pos[i - 3];
    const dy = pos[i + 1] - pos[i - 2];
    const dz = pos[i + 2] - pos[i - 1];
    sum += Math.hypot(dx, dy, dz);
  }
  return sum;
}

/** Chord direction (first to last point) of an edge line, normalized, or null if degenerate. */
export function edgeDirection(line: THREE.Line): THREE.Vector3 | null {
  const pos = edgePolylinePositions(line);
  if (!pos || pos.length < 6) return null;
  const ax = pos[0], ay = pos[1], az = pos[2];
  const bx = pos[pos.length - 3], by = pos[pos.length - 2], bz = pos[pos.length - 1];
  const d = new THREE.Vector3(bx - ax, by - ay, bz - az);
  if (d.lengthSq() < 1e-12) return null;
  return d.normalize();
}

function faceEntityOf(obj: Object3D): SelectedEntity | null {
  const ud = obj.userData as { entityType?: string; entityId?: string };
  if (ud.entityType === "surface" && ud.entityId) return { entityType: "surface", entityId: ud.entityId };
  return null;
}

function lineEntityOf(obj: Object3D): SelectedEntity | null {
  const ud = obj.userData as { entityType?: string; entityId?: string };
  if (ud.entityType === "line" && ud.entityId) return { entityType: "line", entityId: ud.entityId };
  return null;
}

const FACE_NORMAL_DIRS: Record<string, THREE.Vector3> = {
  normalPx: new THREE.Vector3(1, 0, 0),
  normalNx: new THREE.Vector3(-1, 0, 0),
  normalPy: new THREE.Vector3(0, 1, 0),
  normalNy: new THREE.Vector3(0, -1, 0),
  normalPz: new THREE.Vector3(0, 0, 1),
  normalNz: new THREE.Vector3(0, 0, -1),
};

const LINE_AXIS_DIRS: Record<string, THREE.Vector3> = {
  alongX: new THREE.Vector3(1, 0, 0),
  alongY: new THREE.Vector3(0, 1, 0),
  alongZ: new THREE.Vector3(0, 0, 1),
};

/**
 * Filter face meshes by a face predicate. `arg` is used for threshold/count
 * predicates; ignored for others. Returns deduped entity refs (one per mesh).
 */
export function applyFaceFilter(
  targets: Object3D[],
  filterId: FaceFilterId,
  arg: number,
  toleranceDeg = DEFAULT_DIRECTION_TOLERANCE_DEG
): SelectedEntity[] {
  if (filterId === "largestN" || filterId === "smallestN") {
    const n = Math.max(0, Math.floor(arg));
    if (n <= 0) return [];
    const scored = targets
      .map((obj) => {
        const ent = faceEntityOf(obj);
        if (!ent) return null;
        const mesh = obj as THREE.Mesh;
        return { ent, area: faceArea(mesh) };
      })
      .filter((x): x is { ent: SelectedEntity; area: number } => x !== null);
    scored.sort((a, b) => (filterId === "largestN" ? b.area - a.area : a.area - b.area));
    return scored.slice(0, n).map((s) => s.ent);
  }

  const out: SelectedEntity[] = [];
  const cosTol = Math.cos((toleranceDeg * Math.PI) / 180);
  for (const obj of targets) {
    const ent = faceEntityOf(obj);
    if (!ent) continue;
    const mesh = obj as THREE.Mesh;
    let keep = false;
    if (filterId in FACE_NORMAL_DIRS) {
      const n = faceNormal(mesh);
      const dir = FACE_NORMAL_DIRS[filterId];
      keep = n !== null && n.dot(dir) >= cosTol - 1e-9;
    } else if (filterId === "planar") {
      keep = faceIsPlanar(mesh, toleranceDeg);
    } else if (filterId === "areaGte") {
      keep = faceArea(mesh) >= arg - 1e-9;
    } else if (filterId === "areaLte") {
      keep = faceArea(mesh) <= arg + 1e-9;
    }
    if (keep) out.push(ent);
  }
  return out;
}

/**
 * Filter edge lines by a line predicate. When `excludeSmooth` is true, lines
 * with `userData.smooth === true` are dropped before any other test.
 */
export function applyLineFilter(
  targets: Object3D[],
  filterId: LineFilterId,
  arg: number,
  excludeSmooth: boolean,
  toleranceDeg = DEFAULT_DIRECTION_TOLERANCE_DEG
): SelectedEntity[] {
  const cosTol = Math.cos((toleranceDeg * Math.PI) / 180);
  if (filterId === "longestN" || filterId === "shortestN") {
    const n = Math.max(0, Math.floor(arg));
    if (n <= 0) return [];
    const scored = targets
      .map((obj) => {
        if (excludeSmooth && (obj.userData as { smooth?: boolean }).smooth === true) return null;
        const ent = lineEntityOf(obj);
        if (!ent) return null;
        const line = obj as THREE.Line;
        return { ent, len: edgeLength(line) };
      })
      .filter((x): x is { ent: SelectedEntity; len: number } => x !== null);
    scored.sort((a, b) => (filterId === "longestN" ? b.len - a.len : a.len - b.len));
    return scored.slice(0, n).map((s) => s.ent);
  }

  const out: SelectedEntity[] = [];
  for (const obj of targets) {
    if (excludeSmooth && (obj.userData as { smooth?: boolean }).smooth === true) continue;
    const ent = lineEntityOf(obj);
    if (!ent) continue;
    const line = obj as THREE.Line;
    let keep = false;
    if (filterId in LINE_AXIS_DIRS) {
      const d = edgeDirection(line);
      const axis = LINE_AXIS_DIRS[filterId];
      keep = d !== null && Math.abs(d.dot(axis)) >= cosTol - 1e-9;
    } else if (filterId === "lengthGte") {
      keep = edgeLength(line) >= arg - 1e-9;
    } else if (filterId === "lengthLte") {
      keep = edgeLength(line) <= arg + 1e-9;
    }
    if (keep) out.push(ent);
  }
  return out;
}
