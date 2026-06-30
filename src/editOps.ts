/**
 * The shared, kernel-agnostic edit-operation model. Pure and vscode-free so it
 * unit-tests headless and is imported by both the host (OCCT) and webview
 * (Three.js) engines. Operands are referenced by the same stable entity ids the
 * read pipeline assigns (`solid-N`, `face-N`, `edge-N`, `node-N/…`); numeric
 * params are plain tuples so an op serializes losslessly to the edits sidecar.
 *
 * Ops form an ordered, replayable list: the displayed model is the base shape
 * with every op folded over it in order. {@link validateEditOp} is the single
 * tolerant gate — both the sidecar parser and any incoming message run through
 * it, so a malformed op is dropped rather than corrupting the list.
 */

export type Vec3 = [number, number, number];

/** Translate the target entities along `vec`. */
export interface TranslateOp { op: "translate"; targets: string[]; vec: Vec3; }
/** Rotate the targets `angleDeg` about the axis through `axisPoint` along `axisDir`. */
export interface RotateOp { op: "rotate"; targets: string[]; axisPoint: Vec3; axisDir: Vec3; angleDeg: number; }
/** Scale the targets about `center`; uniform scale is `[s, s, s]`. */
export interface ScaleOp { op: "scale"; targets: string[]; center: Vec3; factors: Vec3; }
/** Mirror the targets across the plane (`planePoint`, `planeNormal`). */
export interface MirrorOp { op: "mirror"; targets: string[]; planePoint: Vec3; planeNormal: Vec3; }
/** Combine solid sets `a` and `b` (union/subtract/intersect). */
export interface BooleanOp { op: "boolean"; kind: "union" | "subtract" | "intersect"; a: string[]; b: string[]; }
/** Round the selected edges with radius `radius`. */
export interface FilletOp { op: "fillet"; edges: string[]; radius: number; }
/** Bevel the selected edges with setback `distance`. */
export interface ChamferOp { op: "chamfer"; edges: string[]; distance: number; }
/** Extrude a selected planar face/wire `profile` along `dir` by `length`. */
export interface ExtrudeOp { op: "extrude"; profile: string; dir: Vec3; length: number; }
/** Revolve a selected profile `angleDeg` about the axis (`axisPoint`, `axisDir`). */
export interface RevolveOp { op: "revolve"; profile: string; axisPoint: Vec3; axisDir: Vec3; angleDeg: number; }
/** Sweep a selected profile face/wire along a selected path edge. */
export interface SweepOp { op: "sweep"; profile: string; path: string; }
/** Loft through 2+ selected profile faces/wires. */
export interface LoftOp { op: "loft"; profiles: string[]; }
/** Spread every solid radially from the model centre by `factor`. */
export interface ExplodeOp { op: "explode"; factor: number; }
/** Align face `faceA` onto face `faceB` (basic single-constraint mate). */
export interface MateOp { op: "mate"; faceA: string; faceB: string; }

export type EditOp =
  | TranslateOp | RotateOp | ScaleOp | MirrorOp
  | BooleanOp | FilletOp | ChamferOp
  | ExtrudeOp | RevolveOp | SweepOp | LoftOp
  | ExplodeOp | MateOp;

export type EditOpKind = EditOp["op"];

/** Ops that change topology and therefore reassign `face-N`/`edge-N` ids on reload. */
export const TOPOLOGY_CHANGING_OPS: ReadonlySet<EditOpKind> = new Set([
  "boolean", "fillet", "chamfer", "extrude", "revolve", "sweep", "loft",
]);

/** Ops only available for B-rep sources (meshes have no sketch/exact topology). */
export const BREP_ONLY_OPS: ReadonlySet<EditOpKind> = new Set([
  "fillet", "chamfer", "extrude", "revolve", "sweep", "loft", "mate",
]);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function asVec3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  if (!v.every(isFiniteNumber)) return null;
  return [v[0], v[1], v[2]];
}

function asIdArray(v: unknown, min = 1): string[] | null {
  if (!Array.isArray(v)) return null;
  const ids = v.filter((x): x is string => typeof x === "string");
  return ids.length >= min ? ids : null;
}

/**
 * Validates one raw object into a clean {@link EditOp}, or `null` if it is
 * malformed. This is the single tolerance gate for the whole feature — keep all
 * structural checks here so callers never have to re-validate.
 */
export function validateEditOp(raw: unknown): EditOp | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  switch (o.op) {
    case "translate": {
      const targets = asIdArray(o.targets);
      const vec = asVec3(o.vec);
      return targets && vec ? { op: "translate", targets, vec } : null;
    }
    case "rotate": {
      const targets = asIdArray(o.targets);
      const axisPoint = asVec3(o.axisPoint);
      const axisDir = asVec3(o.axisDir);
      return targets && axisPoint && axisDir && isFiniteNumber(o.angleDeg)
        ? { op: "rotate", targets, axisPoint, axisDir, angleDeg: o.angleDeg }
        : null;
    }
    case "scale": {
      const targets = asIdArray(o.targets);
      const center = asVec3(o.center);
      const factors = asVec3(o.factors);
      return targets && center && factors
        ? { op: "scale", targets, center, factors }
        : null;
    }
    case "mirror": {
      const targets = asIdArray(o.targets);
      const planePoint = asVec3(o.planePoint);
      const planeNormal = asVec3(o.planeNormal);
      return targets && planePoint && planeNormal
        ? { op: "mirror", targets, planePoint, planeNormal }
        : null;
    }
    case "boolean": {
      const a = asIdArray(o.a);
      const b = asIdArray(o.b);
      const kind = o.kind;
      const ok = kind === "union" || kind === "subtract" || kind === "intersect";
      return a && b && ok ? { op: "boolean", kind, a, b } : null;
    }
    case "fillet": {
      const edges = asIdArray(o.edges);
      return edges && isFiniteNumber(o.radius) ? { op: "fillet", edges, radius: o.radius } : null;
    }
    case "chamfer": {
      const edges = asIdArray(o.edges);
      return edges && isFiniteNumber(o.distance) ? { op: "chamfer", edges, distance: o.distance } : null;
    }
    case "extrude": {
      const dir = asVec3(o.dir);
      return typeof o.profile === "string" && dir && isFiniteNumber(o.length)
        ? { op: "extrude", profile: o.profile, dir, length: o.length }
        : null;
    }
    case "revolve": {
      const axisPoint = asVec3(o.axisPoint);
      const axisDir = asVec3(o.axisDir);
      return typeof o.profile === "string" && axisPoint && axisDir && isFiniteNumber(o.angleDeg)
        ? { op: "revolve", profile: o.profile, axisPoint, axisDir, angleDeg: o.angleDeg }
        : null;
    }
    case "sweep": {
      return typeof o.profile === "string" && typeof o.path === "string"
        ? { op: "sweep", profile: o.profile, path: o.path }
        : null;
    }
    case "loft": {
      const profiles = asIdArray(o.profiles, 2);
      return profiles ? { op: "loft", profiles } : null;
    }
    case "explode": {
      return isFiniteNumber(o.factor) ? { op: "explode", factor: o.factor } : null;
    }
    case "mate": {
      return typeof o.faceA === "string" && typeof o.faceB === "string"
        ? { op: "mate", faceA: o.faceA, faceB: o.faceB }
        : null;
    }
    default:
      return null;
  }
}
