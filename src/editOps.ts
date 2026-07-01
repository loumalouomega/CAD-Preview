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
/** Add a box centred at `center` with full extents `size`. A cube is a box with equal `size` components. */
export interface AddBoxOp { op: "addBox"; center: Vec3; size: Vec3; }
/** Add a sphere of `radius` centred at `center`. */
export interface AddSphereOp { op: "addSphere"; center: Vec3; radius: number; }
/** Add a cylinder of `radius`/`height` with its base centred at `center`, extruded along `axis`. */
export interface AddCylinderOp { op: "addCylinder"; center: Vec3; axis: Vec3; radius: number; height: number; }
/** Add a cone/frustum (`radius1` base, `radius2` top — 0 for a sharp apex) with base at `center` along `axis`. */
export interface AddConeOp { op: "addCone"; center: Vec3; axis: Vec3; radius1: number; radius2: number; height: number; }
/** Add a torus of `majorRadius`/`minorRadius` centred at `center`, ring normal `axis`. */
export interface AddTorusOp { op: "addTorus"; center: Vec3; axis: Vec3; majorRadius: number; minorRadius: number; }
/** Add a regular `sides`-gon prism of circumradius `radius`/`height` with base at `center` along `axis`. */
export interface AddPrismOp { op: "addPrism"; center: Vec3; axis: Vec3; radius: number; sides: number; height: number; }
/** Add a standalone flat circular profile face (no thickness), for later use as an extrude/revolve/sweep/loft profile. */
export interface AddCircleProfileOp { op: "addCircleProfile"; center: Vec3; normal: Vec3; radius: number; }
/** Add a standalone flat rectangular profile face. `up` (with `normal`) fixes its in-plane orientation. */
export interface AddRectangleProfileOp { op: "addRectangleProfile"; center: Vec3; normal: Vec3; up: Vec3; width: number; height: number; }
/** Add a standalone flat regular `sides`-gon profile face of circumradius `radius`. */
export interface AddPolygonProfileOp { op: "addPolygonProfile"; center: Vec3; normal: Vec3; up: Vec3; radius: number; sides: number; }
/** Add a standalone point (vertex) at `position`. Never resolved as an operand by any other op — display-only. */
export interface AddPointOp { op: "addPoint"; position: Vec3; }
/** Add a standalone straight-line edge from `start` to `end`. */
export interface AddLineOp { op: "addLine"; start: Vec3; end: Vec3; }
/** Add a standalone circular-arc edge: the circle at (`center`,`normal`,`radius`), trimmed from `startAngleDeg` to `endAngleDeg` (sweeping counterclockwise about `normal`, wrapping through 0° if `endAngleDeg < startAngleDeg`). */
export interface AddArcOp { op: "addArc"; center: Vec3; normal: Vec3; radius: number; startAngleDeg: number; endAngleDeg: number; }
/** Build a standalone flat face from the wire formed by the selected edges — they must connect into a closed loop. */
export interface AddSurfaceFromLinesOp { op: "addSurfaceFromLines"; edges: string[]; }
/** Build a new solid by sewing the selected faces into a closed shell. */
export interface AddVolumeFromSurfacesOp { op: "addVolumeFromSurfaces"; faces: string[]; }

export type EditOp =
  | TranslateOp | RotateOp | ScaleOp | MirrorOp
  | BooleanOp | FilletOp | ChamferOp
  | ExtrudeOp | RevolveOp | SweepOp | LoftOp
  | ExplodeOp | MateOp
  | AddBoxOp | AddSphereOp | AddCylinderOp | AddConeOp | AddTorusOp | AddPrismOp
  | AddCircleProfileOp | AddRectangleProfileOp | AddPolygonProfileOp
  | AddPointOp | AddLineOp | AddArcOp | AddSurfaceFromLinesOp | AddVolumeFromSurfacesOp;

export type EditOpKind = EditOp["op"];

/** Ops that change topology and therefore reassign `face-N`/`edge-N` ids on reload. */
export const TOPOLOGY_CHANGING_OPS: ReadonlySet<EditOpKind> = new Set([
  "boolean", "fillet", "chamfer", "extrude", "revolve", "sweep", "loft",
  "addBox", "addSphere", "addCylinder", "addCone", "addTorus", "addPrism",
  "addCircleProfile", "addRectangleProfile", "addPolygonProfile",
  "addPoint", "addLine", "addArc", "addSurfaceFromLines", "addVolumeFromSurfaces",
]);

/** Ops only available for B-rep sources (meshes have no sketch/exact topology). */
export const BREP_ONLY_OPS: ReadonlySet<EditOpKind> = new Set([
  "fillet", "chamfer", "extrude", "revolve", "sweep", "loft", "mate",
  "addCircleProfile", "addRectangleProfile", "addPolygonProfile",
  "addPoint", "addLine", "addArc", "addSurfaceFromLines", "addVolumeFromSurfaces",
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

function isPositive(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0;
}

/** A `Vec3` with non-zero length (for axis directions, which can't collapse to a point). */
function asNonZeroVec3(v: unknown): Vec3 | null {
  const vec = asVec3(v);
  if (!vec) return null;
  const [x, y, z] = vec;
  return x * x + y * y + z * z > 0 ? vec : null;
}

/** True when `a` and `b` are exactly equal component-wise (for rejecting degenerate zero-length lines). */
function vecEqual(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** True when `a` and `b` are not (anti-)parallel — i.e. their cross product is non-zero. */
function notParallel(a: Vec3, b: Vec3): boolean {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return cx * cx + cy * cy + cz * cz > 0;
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
    case "addBox": {
      const center = asVec3(o.center);
      const size = asVec3(o.size);
      return center && size && size.every((s) => s > 0)
        ? { op: "addBox", center, size }
        : null;
    }
    case "addSphere": {
      const center = asVec3(o.center);
      return center && isPositive(o.radius) ? { op: "addSphere", center, radius: o.radius } : null;
    }
    case "addCylinder": {
      const center = asVec3(o.center);
      const axis = asNonZeroVec3(o.axis);
      return center && axis && isPositive(o.radius) && isPositive(o.height)
        ? { op: "addCylinder", center, axis, radius: o.radius, height: o.height }
        : null;
    }
    case "addCone": {
      const center = asVec3(o.center);
      const axis = asNonZeroVec3(o.axis);
      return center && axis && isFiniteNumber(o.radius1) && o.radius1 >= 0
        && isFiniteNumber(o.radius2) && o.radius2 >= 0 && (o.radius1 > 0 || o.radius2 > 0)
        && isPositive(o.height)
        ? { op: "addCone", center, axis, radius1: o.radius1, radius2: o.radius2, height: o.height }
        : null;
    }
    case "addTorus": {
      const center = asVec3(o.center);
      const axis = asNonZeroVec3(o.axis);
      return center && axis && isPositive(o.majorRadius) && isPositive(o.minorRadius)
        && o.minorRadius < o.majorRadius
        ? { op: "addTorus", center, axis, majorRadius: o.majorRadius, minorRadius: o.minorRadius }
        : null;
    }
    case "addPrism": {
      const center = asVec3(o.center);
      const axis = asNonZeroVec3(o.axis);
      return center && axis && isPositive(o.radius) && isPositive(o.height)
        && isFiniteNumber(o.sides) && Number.isInteger(o.sides) && o.sides >= 3
        ? { op: "addPrism", center, axis, radius: o.radius, sides: o.sides, height: o.height }
        : null;
    }
    case "addCircleProfile": {
      const center = asVec3(o.center);
      const normal = asNonZeroVec3(o.normal);
      return center && normal && isPositive(o.radius)
        ? { op: "addCircleProfile", center, normal, radius: o.radius }
        : null;
    }
    case "addRectangleProfile": {
      const center = asVec3(o.center);
      const normal = asNonZeroVec3(o.normal);
      const up = asNonZeroVec3(o.up);
      return center && normal && up && notParallel(normal, up)
        && isPositive(o.width) && isPositive(o.height)
        ? { op: "addRectangleProfile", center, normal, up, width: o.width, height: o.height }
        : null;
    }
    case "addPolygonProfile": {
      const center = asVec3(o.center);
      const normal = asNonZeroVec3(o.normal);
      const up = asNonZeroVec3(o.up);
      return center && normal && up && notParallel(normal, up) && isPositive(o.radius)
        && isFiniteNumber(o.sides) && Number.isInteger(o.sides) && o.sides >= 3
        ? { op: "addPolygonProfile", center, normal, up, radius: o.radius, sides: o.sides }
        : null;
    }
    case "addPoint": {
      const position = asVec3(o.position);
      return position ? { op: "addPoint", position } : null;
    }
    case "addLine": {
      const start = asVec3(o.start);
      const end = asVec3(o.end);
      return start && end && !vecEqual(start, end) ? { op: "addLine", start, end } : null;
    }
    case "addArc": {
      const center = asVec3(o.center);
      const normal = asNonZeroVec3(o.normal);
      return center && normal && isPositive(o.radius)
        && isFiniteNumber(o.startAngleDeg) && isFiniteNumber(o.endAngleDeg)
        && o.startAngleDeg !== o.endAngleDeg
        ? { op: "addArc", center, normal, radius: o.radius, startAngleDeg: o.startAngleDeg, endAngleDeg: o.endAngleDeg }
        : null;
    }
    case "addSurfaceFromLines": {
      const edges = asIdArray(o.edges, 3); // a closed loop needs at least 3 edges
      return edges ? { op: "addSurfaceFromLines", edges } : null;
    }
    case "addVolumeFromSurfaces": {
      const faces = asIdArray(o.faces, 4); // a closed volume needs at least 4 faces
      return faces ? { op: "addVolumeFromSurfaces", faces } : null;
    }
    default:
      return null;
  }
}
