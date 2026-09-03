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
 *
 * Parametric fields: an op may carry an optional `exprs` annotation mapping a
 * numeric field path (`length`, `size[1]`, `points[2][0]`) to an expression
 * string over the document's named variables. The numeric field itself always
 * holds the last-good evaluated number (a cache), so every consumer of ops —
 * validation invariants, both engines, export — keeps operating on plain
 * numbers; only `resolveEditOps` (src/editVariables.ts) reads `exprs`.
 */

import { parseFieldPath, getNumericField, parseExprSyntax } from "./paramExpr";

export type Vec3 = [number, number, number];

/** Field path → expression string, e.g. `{ "length": "L*2", "size[0]": "W" }`. */
export type ExprMap = Record<string, string>;

/** Translate the target entities along `vec`. */
export interface TranslateOp { op: "translate"; targets: string[]; vec: Vec3; }
/** Rotate the targets `angleDeg` about the axis through `axisPoint` along `axisDir`. */
export interface RotateOp { op: "rotate"; targets: string[]; axisPoint: Vec3; axisDir: Vec3; angleDeg: number; }
/** Scale the targets about `center`; uniform scale is `[s, s, s]`. */
export interface ScaleOp { op: "scale"; targets: string[]; center: Vec3; factors: Vec3; }
/** Mirror the targets across the plane (`planePoint`, `planeNormal`), the saved construction plane `planeId` (`plane-N`), or the midplane of two planar `midplaneFaces` (planar, parallel — three forms, mutually exclusive; `planePoint`/`planeNormal` may ride alongside `planeId` as the resolved cache, overwritten at read time). */
export interface MirrorOp { op: "mirror"; targets: string[]; planePoint?: Vec3; planeNormal?: Vec3; planeId?: string; midplaneFaces?: [string, string]; }
/** Combine solid sets `a` and `b` (union/subtract/intersect). */
export interface BooleanOp { op: "boolean"; kind: "union" | "subtract" | "intersect"; a: string[]; b: string[]; }
/** Round the selected edges with radius `radius`. */
export interface FilletOp { op: "fillet"; edges: string[]; radius: number; }
/** Bevel the selected edges: symmetric `distance`, asymmetric `distance`/`distance2` on two sides of a reference `face`, or distance-angle `distance` at `angleDeg` to `face`. `face` is required when `distance2` or `angleDeg` is set — it chooses which side gets `distance`. */
export interface ChamferOp { op: "chamfer"; edges: string[]; distance: number; distance2?: number; angleDeg?: number; face?: string; }
/**
 * `thin` turns a feature into a thin-walled one: the profile's outline is
 * offset into a band, and the (otherwise unchanged) builder is handed that
 * band instead of the filled profile — so an extrude yields a tube, a revolve
 * a hollow of revolution, and so on.
 *
 * `thin` is the total wall thickness (always positive). `thinOuter` says how
 * much of that wall lies OUTSIDE the profile boundary, in `[0, thin]`:
 * `thinOuter` omitted or `0` grows the wall entirely inward from the boundary
 * (the usual case), `thinOuter === thin` grows it entirely outward, and
 * anything between is the dual-offset band the roadmap names. So the two
 * offsets applied to the profile wire are `+thinOuter` and `-(thin - thinOuter)`.
 *
 * A positive-only thickness plus a split is preferred over one SIGNED number
 * because a dual-offset band needs two values regardless, and unlike
 * {@link ShellOp.thickness} — where the sign genuinely encodes which way an
 * existing solid's walls grow — a feature profile is essentially always
 * thickened inward.
 *
 * Deliberately two FLAT fields rather than one nested `{outer, inner}` object:
 * `paramExpr.ts`'s `parseFieldPath` accepts an identifier plus numeric indices
 * only — it has no dotted-path form — so a nested object would make these the
 * only numeric op fields in the codebase a parametric variable cannot drive.
 *
 * **Open profiles are symmetric, and `thinOuter` is refused for them.** An
 * open wire (see {@link ExtrudeOp.profileEdges}) has no inside or outside, so
 * "how much of the wall sits outside the boundary" names nothing — and the
 * kernel only offers a band centred on the spine anyway (probed: an open
 * wire's offset is symmetric of half-width `thin / 2`, with semicircular end
 * caps). A `thinOuter` that isn't exactly `thin / 2` is therefore skipped at
 * replay with a diagnostic rather than silently ignored.
 */
export interface ThinSpec { thin?: number; thinOuter?: number; }
/**
 * The profile a sweep-family op consumes, in one of two mutually exclusive
 * forms — exactly one must be present, mirroring {@link MirrorOp}'s own
 * three-form XOR:
 *
 * - `profile` — a `face-N`, the original form. A sketch face, or any face of
 *   the model. Its inner wires (holes) are preserved for a plain feature.
 * - `profileEdges` — a set of `edge-N` ids assembled into one wire, so an
 *   OPEN sketch (an `addPolyline` with `closed: false`, whose segments each
 *   get their own `edge-N`) can finally be consumed. The edges may be given
 *   in any order — OCCT's wire builder joins them by shared vertices — and a
 *   genuinely disconnected set is skipped with a diagnostic.
 *
 * A CLOSED edge set behaves exactly like the equivalent face. An OPEN one
 * encloses no area, so it **requires** {@link ThinSpec.thin}: the wall is what
 * gives it a cross-section. See CLAUDE.md's "Open-profile (wire) operand".
 */
export interface ProfileOperand { profile?: string; profileEdges?: string[]; }
/** Extrude a selected planar face, or a wire of selected edges, along `dir` by `length`. */
export interface ExtrudeOp extends ThinSpec, ProfileOperand { op: "extrude"; dir: Vec3; length: number; }
/** Revolve a selected profile `angleDeg` about the axis (`axisPoint`, `axisDir`). */
export interface RevolveOp extends ThinSpec, ProfileOperand { op: "revolve"; axisPoint: Vec3; axisDir: Vec3; angleDeg: number; }
/** Sweep a selected profile along a selected path edge. */
export interface SweepOp extends ThinSpec, ProfileOperand { op: "sweep"; path: string; }
/**
 * Loft through 2+ selected profile sections. `profiles` (face ids) and
 * `profileEdgeSets` (one `edge-N` set per section) are mutually exclusive —
 * the same XOR {@link ProfileOperand} applies to the single-profile ops, with
 * a distinct field name because the arity differs. Every section must agree
 * on closedness; a mixed list is skipped with a diagnostic.
 */
export interface LoftOp extends ThinSpec { op: "loft"; profiles?: string[]; profileEdgeSets?: string[][]; }
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
/** Add a regular `sides`-gon prism of circumradius `radius`/`height` with base at `center` along `axis`. When `circumscribed` is true, `radius` is the apothem (distance to each flat side). */
export interface AddPrismOp { op: "addPrism"; center: Vec3; axis: Vec3; radius: number; sides: number; height: number; circumscribed?: boolean; }
/** Add a right-angular wedge (OCCT `MakeWedge` semantics): base rectangle `dx`×`dy` centred at `center` in the plane ⟂ `axis`, extruded `dz` along `axis`; the far edge (at local y=dy) narrows to `ltx` along local x. `up` orients local x in the base plane. B-rep only. */
export interface AddWedgeOp { op: "addWedge"; center: Vec3; axis: Vec3; up: Vec3; dx: number; dy: number; dz: number; ltx: number; }
/** Cut a cylindrical hole into the target solids: mouth at `position`, drilled `depth` along `axis` (which points INTO the material), radius `radius`. */
export interface AddHoleOp { op: "addHole"; targets: string[]; position: Vec3; axis: Vec3; radius: number; depth: number; }
/** Cut a counterbored hole: the plain hole plus a coaxial wider bore (`cbRadius` > radius) of depth `cbDepth` (< depth) at the mouth. */
export interface AddCounterboreHoleOp { op: "addCounterboreHole"; targets: string[]; position: Vec3; axis: Vec3; radius: number; depth: number; cbRadius: number; cbDepth: number; }
/** Cut a countersunk hole: the plain hole plus a conical mouth from `csRadius` (> radius) tapering at included angle `csAngleDeg` (0 < angle < 180) down to `radius`. */
export interface AddCountersinkHoleOp { op: "addCountersinkHole"; targets: string[]; position: Vec3; axis: Vec3; radius: number; depth: number; csRadius: number; csAngleDeg: number; }
/** Add a standalone flat circular profile face (no thickness), for later use as an extrude/revolve/sweep/loft profile. */
export interface AddCircleProfileOp { op: "addCircleProfile"; center: Vec3; normal: Vec3; radius: number; guide?: boolean; }
/** Add a standalone flat rectangular profile face. `up` (with `normal`) fixes its in-plane orientation. */
export interface AddRectangleProfileOp { op: "addRectangleProfile"; center: Vec3; normal: Vec3; up: Vec3; width: number; height: number; guide?: boolean; }
/** Add a standalone flat regular `sides`-gon profile face of circumradius `radius`. When `circumscribed` is true, `radius` is the apothem. */
export interface AddPolygonProfileOp { op: "addPolygonProfile"; center: Vec3; normal: Vec3; up: Vec3; radius: number; sides: number; circumscribed?: boolean; guide?: boolean; }
/** Add a standalone flat elliptical profile face: `radiusX` along the in-plane `up` axis, `radiusY` perpendicular to it. */
export interface AddEllipseProfileOp { op: "addEllipseProfile"; center: Vec3; normal: Vec3; up: Vec3; radiusX: number; radiusY: number; guide?: boolean; }
/** Add a standalone flat rectangle profile face with all four corners rounded to `cornerRadius` (0 < 2·cornerRadius < min(width, height) — the stadium limit case is what `addSlotProfile` is for). */
export interface AddRoundedRectangleProfileOp { op: "addRoundedRectangleProfile"; center: Vec3; normal: Vec3; up: Vec3; width: number; height: number; cornerRadius: number; guide?: boolean; }
/** Add a standalone flat stadium/slot profile face: overall `length` (including the semicircular end caps) along the in-plane `up` axis, `width` across (length > width > 0). */
export interface AddSlotProfileOp { op: "addSlotProfile"; center: Vec3; normal: Vec3; up: Vec3; length: number; width: number; guide?: boolean; }
/** Add a standalone flat isosceles-trapezoid profile face: `bottomWidth` along the in-plane `up` axis at the bottom, `topWidth` at the top, `height` between them. */
export interface AddTrapezoidProfileOp { op: "addTrapezoidProfile"; center: Vec3; normal: Vec3; up: Vec3; bottomWidth: number; topWidth: number; height: number; guide?: boolean; }
/** Add a standalone point (vertex) at `position`. Never resolved as an operand by any other op — display-only. */
export interface AddPointOp { op: "addPoint"; position: Vec3; guide?: boolean; }
/** Add a standalone straight-line edge from `start` to `end`. */
export interface AddLineOp { op: "addLine"; start: Vec3; end: Vec3; guide?: boolean; }
/** Add a standalone circular-arc edge: the circle at (`center`,`normal`,`radius`), trimmed from `startAngleDeg` to `endAngleDeg` (sweeping counterclockwise about `normal`, wrapping through 0° if `endAngleDeg < startAngleDeg`). */
export interface AddArcOp { op: "addArc"; center: Vec3; normal: Vec3; radius: number; startAngleDeg: number; endAngleDeg: number; guide?: boolean; }
/** Add a standalone polyline: straight edges through `points` in order (≥ 2; ≥ 3 when `closed`, which adds the last→first edge). */
export interface AddPolylineOp { op: "addPolyline"; points: Vec3[]; closed: boolean; guide?: boolean; }
/** Add a standalone circular-arc edge through three points (must not be collinear — a collinear triple is skipped by the engine). */
export interface AddThreePointArcOp { op: "addThreePointArc"; p1: Vec3; p2: Vec3; p3: Vec3; guide?: boolean; }
/** Add a standalone smooth B-spline curve through `points` (approximating fit, endpoint-exact — this OCCT build has no exact interpolator bound). */
export interface AddSplineOp { op: "addSpline"; points: Vec3[]; guide?: boolean; }
/** Add a standalone Bézier curve with the given control points (curve passes through the first and last only). */
export interface AddBezierOp { op: "addBezier"; controlPoints: Vec3[]; guide?: boolean; }
/** Add a standalone elliptical-arc edge: `radiusX` along the in-plane `up` axis, `radiusY` perpendicular, trimmed from `startAngleDeg` to `endAngleDeg` (counterclockwise about `normal`). 0→360 is the full ellipse. */
export interface AddEllipseArcOp { op: "addEllipseArc"; center: Vec3; normal: Vec3; up: Vec3; radiusX: number; radiusY: number; startAngleDeg: number; endAngleDeg: number; guide?: boolean; }
/** Add a standalone helical edge: `turns` revolutions of `pitch` height each around the `axis` through `center` (the helix starts at the base), on a cylinder of `radius`. */
export interface AddHelixOp { op: "addHelix"; center: Vec3; axis: Vec3; radius: number; pitch: number; turns: number; guide?: boolean; }
/** Hollow out the solid(s) owning `openingFaces`, removing those faces and leaving walls of `|thickness|` (negative = walls grow inward — the usual hollow; positive = outward). `join` chooses the corner style — arc (default, rounded), intersection (sharp), or tangent. At least one opening face is required: this OCCT build's ThickSolid with an empty closing list yields a plain offset solid, not a hollow (verified). */
export interface ShellOp { op: "shell"; thickness: number; openingFaces: string[]; join?: "arc" | "intersection" | "tangent"; }
/** Taper the selected faces by `angleDeg` around a neutral plane through `planePoint` with direction `planeNormal` (neutral plane = point+normal, pull = normal) or the saved construction plane `planeId` (`plane-N`); `planePoint`/`planeNormal` may ride alongside `planeId` as the resolved cache. Omitted = each face's own plane. */
export interface DraftOp { op: "draft"; faces: string[]; angleDeg: number; planePoint?: Vec3; planeNormal?: Vec3; planeId?: string; }
/** Stadium slot around an existing edge: width across, length = edge length + width. */
export interface AddEdgeSlotOp { op: "addEdgeSlot"; edge: string; width: number; }
/** Split the target solids by the plane (`planePoint`, `planeNormal`), the saved construction plane `planeId` (`plane-N`), or the midplane of two planar `midplaneFaces`, keeping the half on the normal side ("positive"), the other half ("negative"), or both pieces. `planePoint`/`planeNormal` may ride alongside `planeId` as the resolved cache. */
export interface SplitByPlaneOp { op: "splitByPlane"; targets: string[]; planePoint?: Vec3; planeNormal?: Vec3; planeId?: string; midplaneFaces?: [string, string]; keep: "both" | "positive" | "negative"; }
/** Append the planar cross-section of the target solids with the plane (`planePoint`, `planeNormal`), the saved construction plane `planeId` (`plane-N`), or the midplane of `midplaneFaces` as a standalone face (under "Sketches"), leaving the solids untouched. `planePoint`/`planeNormal` may ride alongside `planeId` as the resolved cache. */
export interface SectionOp { op: "section"; targets: string[]; planePoint?: Vec3; planeNormal?: Vec3; planeId?: string; midplaneFaces?: [string, string]; }
/** Build a standalone flat face from the wire formed by the selected edges — they must connect into a closed loop. */
export interface AddSurfaceFromLinesOp { op: "addSurfaceFromLines"; edges: string[]; }
/** Build a new solid by sewing the selected faces into a closed shell. */
export interface AddVolumeFromSurfacesOp { op: "addVolumeFromSurfaces"; faces: string[]; }
/** Translate the targets along `axis` so their bbox `extent` (min/center/max) lands at the absolute coordinate `to`. A no-op for a target already there. */
export interface AlignOp { op: "align"; targets: string[]; axis: "x" | "y" | "z"; extent: "min" | "center" | "max"; to: number; }
/** Linear array: `count` total instances of the targets (the original plus `count - 1` new copies), each `spacing` apart along `direction`. */
export interface PatternLinearOp { op: "patternLinear"; targets: string[]; direction: Vec3; spacing: number; count: number; }
/** Circular array: `count` total instances of the targets (the original plus `count - 1` new copies), `angleDeg` apart about the axis through `axisPoint` along `axisDir`, or the mid-axis of `midaxisOf` (two cylindrical faces or two parallel line edges — both required, mutually exclusive with the inline pair). */
export interface PatternCircularOp { op: "patternCircular"; targets: string[]; axisPoint?: Vec3; axisDir?: Vec3; midaxisOf?: [string, string]; angleDeg: number; count: number; }

export type EditOp = (
  | TranslateOp | RotateOp | ScaleOp | MirrorOp
  | BooleanOp | FilletOp | ChamferOp
  | ExtrudeOp | RevolveOp | SweepOp | LoftOp
  | ExplodeOp | MateOp
  | ShellOp | DraftOp | SplitByPlaneOp | SectionOp
  | AddBoxOp | AddSphereOp | AddCylinderOp | AddConeOp | AddTorusOp | AddPrismOp
  | AddWedgeOp | AddHoleOp | AddCounterboreHoleOp | AddCountersinkHoleOp
  | AddCircleProfileOp | AddRectangleProfileOp | AddPolygonProfileOp
  | AddEllipseProfileOp | AddRoundedRectangleProfileOp | AddSlotProfileOp | AddTrapezoidProfileOp
  | AddPointOp | AddLineOp | AddArcOp
  | AddPolylineOp | AddThreePointArcOp | AddSplineOp | AddBezierOp | AddEllipseArcOp | AddHelixOp
  | AddEdgeSlotOp
  | AddSurfaceFromLinesOp | AddVolumeFromSurfacesOp
  | AlignOp | PatternLinearOp | PatternCircularOp
) & { exprs?: ExprMap };

export type EditOpKind = EditOp["op"];

/**
 * Per-op replay outcome, reported by BOTH engines (roadmap "A failed edit op
 * is indistinguishable from one that did nothing", closed): the graceful-skip
 * rule stays — a sidecar authored against a different build must never hard-
 * fail a replay — but a skipped op is no longer silent. `applied: false` with
 * a `diagnostic` (what happened) and an optional `hint` (what to try) is what
 * turns "the model just didn't change" into an actionable report, both in the
 * MCP tools' responses and as per-row markers in the webview's Edits history.
 *
 * Pure data — plain JSON all the way down, so it crosses kernel-worker IPC
 * (`kernelIpc.ts`'s generic marshalling) and postMessage untouched.
 */
export interface OpOutcome {
  /** Position of the op in the list being applied (0-based). */
  index: number;
  kind: EditOpKind;
  applied: boolean;
  /** Set when `applied` is false — what went wrong, in one sentence. */
  diagnostic?: string;
  /** Optional actionable suggestion accompanying `diagnostic`. */
  hint?: string;
}

/** Called by an op helper at each of its skip sites, immediately before
 * returning the unmodified shape/model — first call wins for that op. */
export type OutcomeFail = (diagnostic: string, hint?: string) => void;

/** Ops that change topology and therefore reassign `face-N`/`edge-N` ids on reload. */
export const TOPOLOGY_CHANGING_OPS: ReadonlySet<EditOpKind> = new Set([
  "boolean", "fillet", "chamfer", "extrude", "revolve", "sweep", "loft",
  "shell", "draft", "splitByPlane", "section",
  "addBox", "addSphere", "addCylinder", "addCone", "addTorus", "addPrism",
  "addWedge", "addHole", "addCounterboreHole", "addCountersinkHole",
  "addCircleProfile", "addRectangleProfile", "addPolygonProfile",
  "addEllipseProfile", "addRoundedRectangleProfile", "addSlotProfile", "addTrapezoidProfile",
  "addPoint", "addLine", "addArc",
  "addPolyline", "addThreePointArc", "addSpline", "addBezier", "addEllipseArc", "addHelix",
  "addSurfaceFromLines", "addVolumeFromSurfaces", "addEdgeSlot",
  "patternLinear", "patternCircular",
]);

/** Ops only available for B-rep sources (meshes have no sketch/exact topology).
 * The hole family is deliberately NOT here — the mesh engine cuts holes via CSG. */
export const BREP_ONLY_OPS: ReadonlySet<EditOpKind> = new Set([
  "fillet", "chamfer", "extrude", "revolve", "sweep", "loft", "mate",
  "shell", "draft", "splitByPlane", "section",
  "addWedge",
  "addCircleProfile", "addRectangleProfile", "addPolygonProfile",
  "addEllipseProfile", "addRoundedRectangleProfile", "addSlotProfile", "addTrapezoidProfile",
  "addPoint", "addLine", "addArc",
  "addPolyline", "addThreePointArc", "addSpline", "addBezier", "addEllipseArc", "addHelix",
  "addSurfaceFromLines", "addVolumeFromSurfaces", "addEdgeSlot",
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

/** An integer count of at least `min` — for pattern instance counts, where a fractional or sub-`min` value is meaningless (`min` is 2: "1 instance" isn't a pattern). */
function isCountAtLeast(v: unknown, min: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min;
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

/** An array of ≥ `min` Vec3s; consecutive duplicates rejected when `distinctConsecutive`
 * (a zero-length polyline/spline segment is degenerate; Bézier control points may repeat). */
function asVec3Array(v: unknown, min: number, distinctConsecutive = true): Vec3[] | null {
  if (!Array.isArray(v) || v.length < min) return null;
  const out: Vec3[] = [];
  for (const item of v) {
    const p = asVec3(item);
    if (!p) return null;
    if (distinctConsecutive && out.length > 0 && vecEqual(out[out.length - 1], p)) return null;
    out.push(p);
  }
  return out;
}

/** True when `a` and `b` are not (anti-)parallel — i.e. their cross product is non-zero. */
function notParallel(a: Vec3, b: Vec3): boolean {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return cx * cx + cy * cy + cz * cz > 0;
}

export const GUIDE_KINDS: ReadonlySet<EditOpKind> = new Set([
  "addCircleProfile","addRectangleProfile","addPolygonProfile","addEllipseProfile","addRoundedRectangleProfile","addSlotProfile","addTrapezoidProfile",
  "addPoint","addLine","addArc","addPolyline","addThreePointArc","addSpline","addBezier","addEllipseArc","addHelix",
]);

function asFaceIdPair(v: unknown): [string, string] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  if (typeof v[0] !== "string" || typeof v[1] !== "string") return null;
  if (!/^face-\d+$/.test(v[0]) || !/^face-\d+$/.test(v[1])) return null;
  return [v[0], v[1]];
}

/** Both ids must name the SAME kind — two cylindrical faces, or two parallel
 * line edges. A mixed `["face-0", "edge-1"]` pair has no coherent mid-axis
 * (`resolveMidaxis` reads a face via its cylinder axis and an edge via
 * its chord), so it is refused here rather than skipped at replay. */
function asMidaxisPair(v: unknown): [string, string] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  if (typeof v[0] !== "string" || typeof v[1] !== "string") return null;
  const a = /^(face|edge)-\d+$/.exec(v[0]);
  const b = /^(face|edge)-\d+$/.exec(v[1]);
  if (!a || !b || a[1] !== b[1]) return null;
  return [v[0], v[1]];
}

/**
 * A non-empty array of `edge-N` ids for a {@link ProfileOperand}'s wire form.
 *
 * Unlike {@link asIdArray} — which only checks "array of strings", so an
 * unresolvable id is a replay-time skip — the id SHAPE is what distinguishes
 * this operand form from the face form, so a `face-N` smuggled in here would
 * be a silently-wrong operand rather than a miss. Refused up front, matching
 * {@link asMidaxisPair}'s reasoning.
 */
function asEdgeIdArray(v: unknown, min = 1): string[] | null {
  if (!Array.isArray(v) || v.length < min) return null;
  if (!v.every((x) => typeof x === "string" && /^edge-\d+$/.test(x))) return null;
  return v as string[];
}

/** `loft`'s per-section form: ≥ `min` non-empty {@link asEdgeIdArray}s. */
function asEdgeIdArrayList(v: unknown, min = 2): string[][] | null {
  if (!Array.isArray(v) || v.length < min) return null;
  const out: string[][] = [];
  for (const item of v) {
    const ids = asEdgeIdArray(item);
    if (!ids) return null;
    out.push(ids);
  }
  return out;
}

/**
 * Resolves a single-profile op's mutually exclusive {@link ProfileOperand}:
 * exactly one of `profile` / `profileEdges`, never both and never neither.
 */
function asProfileOperand(o: Record<string, unknown>): ProfileOperand | null {
  const hasFace = o.profile !== undefined;
  const hasEdges = o.profileEdges !== undefined;
  if (hasFace === hasEdges) return null; // neither form, or both at once
  if (hasFace) return typeof o.profile === "string" ? { profile: o.profile } : null;
  const edges = asEdgeIdArray(o.profileEdges);
  return edges ? { profileEdges: edges } : null;
}

function asPlaneId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (!/^plane-\d+$/.test(v)) return null;
  return v;
}

/**
 * Validates the optional {@link ThinSpec} annotation shared by the four
 * sweep-family ops, returning the fields to attach (possibly empty) or `null`
 * to reject the whole op. Mirrors `chamfer`'s optional-numeric shape: presence
 * checks, then structural checks, then range checks.
 *
 * Rejects a non-positive `thin` (a zero- or negative-thickness wall is not a
 * wall), `thinOuter` without `thin` (a split of nothing), and a `thinOuter`
 * outside `[0, thin]` (more wall outside the boundary than there is wall).
 */
function asThinSpec(o: Record<string, unknown>): ThinSpec | null {
  const hasThin = o.thin !== undefined;
  const hasOuter = o.thinOuter !== undefined;
  if (!hasThin && !hasOuter) return {};
  if (hasOuter && !hasThin) return null;
  if (!isPositive(o.thin)) return null;
  const out: ThinSpec = { thin: o.thin };
  if (hasOuter) {
    if (!isFiniteNumber(o.thinOuter) || o.thinOuter < 0 || o.thinOuter > o.thin) return null;
    out.thinOuter = o.thinOuter;
  }
  return out;
}

/** Cap on `exprs` entries per op / expression length — a hand-edited sidecar can't balloon memory. */
const MAX_EXPRS_PER_OP = 64;
const MAX_EXPR_LENGTH = 256;

/**
 * Sanitize a raw `exprs` annotation against the already-validated op: keep only
 * entries whose key addresses a finite numeric slot of `clean` (this rejects
 * structural fields like `targets[0]` and out-of-range point indices — so an
 * expr for a removed point row self-heals on the next validate) and whose value
 * is a syntactically valid expression (unknown identifiers allowed — the
 * variable may be defined later). Bad entries are dropped silently, same
 * tolerance-gate style as the op fields themselves.
 */
function sanitizeExprs(raw: unknown, clean: EditOp): ExprMap | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: ExprMap = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_EXPRS_PER_OP) break;
    const path = parseFieldPath(key);
    if (!path || getNumericField(clean, path) === null) continue;
    if (typeof value !== "string" || value.length > MAX_EXPR_LENGTH || !parseExprSyntax(value)) continue;
    out[key] = value;
    count++;
  }
  return count > 0 ? out : null;
}

/**
 * Validates one raw object into a clean {@link EditOp}, or `null` if it is
 * malformed. This is the single tolerance gate for the whole feature — keep all
 * structural checks here so callers never have to re-validate. A valid `exprs`
 * annotation (see {@link sanitizeExprs}) is carried onto the clean op.
 */
export function validateEditOp(raw: unknown): EditOp | null {
  const clean = validateEditOpCore(raw);
  if (!clean) return null;
  const rawGuide = (raw as Record<string, unknown>).guide;
  if (rawGuide !== undefined) {
    if (typeof rawGuide !== "boolean") return null;
    if (!GUIDE_KINDS.has(clean.op as EditOpKind)) return null;
    (clean as unknown as Record<string, unknown>).guide = rawGuide;
  }
  const exprs = sanitizeExprs((raw as Record<string, unknown>).exprs, clean);
  if (exprs) clean.exprs = exprs;
  return clean;
}

function validateEditOpCore(raw: unknown): EditOp | null {
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
      if (!targets) return null;
      const hasMidplane = o.midplaneFaces !== undefined;
      const hasPlaneId = o.planeId !== undefined;
      if (hasMidplane && hasPlaneId) return null;
      if (hasMidplane) {
        const midplaneFaces = asFaceIdPair(o.midplaneFaces);
        if (!midplaneFaces) return null;
        if (o.planePoint !== undefined || o.planeNormal !== undefined || o.planeId !== undefined) return null;
        return { op: "mirror", targets, midplaneFaces } as MirrorOp;
      }
      if (hasPlaneId) {
        const planeId = asPlaneId(o.planeId);
        if (!planeId) return null;
        if (o.midplaneFaces !== undefined) return null;
        if (o.planePoint !== undefined || o.planeNormal !== undefined) {
          if (o.planePoint === undefined || o.planeNormal === undefined) return null;
          const planePoint = asVec3(o.planePoint);
          const planeNormal = asNonZeroVec3(o.planeNormal);
          if (!planePoint || !planeNormal) return null;
          return { op: "mirror", targets, planeId, planePoint, planeNormal } as MirrorOp;
        }
        return { op: "mirror", targets, planeId } as MirrorOp;
      }
      const planePoint = asVec3(o.planePoint);
      const planeNormal = asNonZeroVec3(o.planeNormal);
      return planePoint && planeNormal ? { op: "mirror", targets, planePoint, planeNormal } : null;
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
      if (!edges || !isPositive(o.distance)) return null;
      const hasD2 = o.distance2 !== undefined;
      const hasAngle = o.angleDeg !== undefined;
      const hasFace = o.face !== undefined;
      if (hasD2 && hasAngle) return null;
      if ((hasD2 || hasAngle) && !hasFace) return null;
      if (hasFace && !hasD2 && !hasAngle) return null;
      if (hasFace && (typeof o.face !== "string" || !o.face)) return null;
      if (hasD2 && !isPositive(o.distance2)) return null;
      if (hasAngle && (!isFiniteNumber(o.angleDeg) || o.angleDeg <= 0 || o.angleDeg >= 90)) return null;
      const out: ChamferOp = { op: "chamfer", edges, distance: o.distance as number };
      if (hasD2) out.distance2 = o.distance2 as number;
      if (hasAngle) out.angleDeg = o.angleDeg as number;
      if (hasFace) out.face = o.face as string;
      return out;
    }
    case "extrude": {
      const dir = asVec3(o.dir);
      const thin = asThinSpec(o);
      const profile = asProfileOperand(o);
      return profile && dir && isFiniteNumber(o.length) && thin
        ? { op: "extrude", ...profile, dir, length: o.length, ...thin }
        : null;
    }
    case "revolve": {
      const axisPoint = asVec3(o.axisPoint);
      const axisDir = asVec3(o.axisDir);
      const thin = asThinSpec(o);
      const profile = asProfileOperand(o);
      return profile && axisPoint && axisDir && isFiniteNumber(o.angleDeg) && thin
        ? { op: "revolve", ...profile, axisPoint, axisDir, angleDeg: o.angleDeg, ...thin }
        : null;
    }
    case "sweep": {
      const thin = asThinSpec(o);
      const profile = asProfileOperand(o);
      return profile && typeof o.path === "string" && thin
        ? { op: "sweep", ...profile, path: o.path, ...thin }
        : null;
    }
    case "loft": {
      const hasFaces = o.profiles !== undefined;
      const hasEdgeSets = o.profileEdgeSets !== undefined;
      if (hasFaces === hasEdgeSets) return null; // neither form, or both at once
      const thin = asThinSpec(o);
      if (!thin) return null;
      if (hasFaces) {
        const profiles = asIdArray(o.profiles, 2);
        return profiles ? { op: "loft", profiles, ...thin } : null;
      }
      const profileEdgeSets = asEdgeIdArrayList(o.profileEdgeSets, 2);
      return profileEdgeSets ? { op: "loft", profileEdgeSets, ...thin } : null;
    }
    case "explode": {
      return isFiniteNumber(o.factor) ? { op: "explode", factor: o.factor } : null;
    }
    case "mate": {
      return typeof o.faceA === "string" && typeof o.faceB === "string"
        ? { op: "mate", faceA: o.faceA, faceB: o.faceB }
        : null;
    }
    case "shell": {
      const openingFaces = asIdArray(o.openingFaces);
      if (!openingFaces || !isFiniteNumber(o.thickness) || o.thickness === 0) return null;
      if (o.join !== undefined && o.join !== "arc" && o.join !== "intersection" && o.join !== "tangent") return null;
      const out: ShellOp = { op: "shell", thickness: o.thickness, openingFaces };
      if (o.join !== undefined) out.join = o.join;
      return out;
    }
    case "draft": {
      const faces = asIdArray(o.faces);
      if (!faces || !isFiniteNumber(o.angleDeg) || o.angleDeg <= 0 || o.angleDeg >= 90) return null;
      const hasPlaneId = o.planeId !== undefined;
      if (hasPlaneId) {
        const planeId = asPlaneId(o.planeId);
        if (!planeId) return null;
        if (o.planePoint !== undefined || o.planeNormal !== undefined) {
          if (o.planePoint === undefined || o.planeNormal === undefined) return null;
          const planePoint = asVec3(o.planePoint);
          const planeNormal = asNonZeroVec3(o.planeNormal);
          if (!planePoint || !planeNormal) return null;
          return { op: "draft", faces, angleDeg: o.angleDeg as number, planeId, planePoint, planeNormal } as DraftOp;
        }
        return { op: "draft", faces, angleDeg: o.angleDeg as number, planeId } as DraftOp;
      }
      if (o.planePoint !== undefined && !asVec3(o.planePoint)) return null;
      if (o.planeNormal !== undefined && !asNonZeroVec3(o.planeNormal)) return null;
      if ((o.planePoint === undefined) !== (o.planeNormal === undefined)) return null;
      const out: DraftOp = { op: "draft", faces, angleDeg: o.angleDeg as number };
      if (o.planePoint) { out.planePoint = asVec3(o.planePoint)!; out.planeNormal = asNonZeroVec3(o.planeNormal!)!; }
      return out;
    }
    case "addEdgeSlot": {
      if (typeof o.edge !== "string" || !o.edge || !isPositive(o.width)) return null;
      return { op: "addEdgeSlot", edge: o.edge, width: o.width as number };
    }
    case "splitByPlane": {
      const targets = asIdArray(o.targets);
      if (!targets) return null;
      const keep = o.keep;
      const ok = keep === "both" || keep === "positive" || keep === "negative";
      if (!ok) return null;
      const hasMidplane = o.midplaneFaces !== undefined;
      const hasPlaneId = o.planeId !== undefined;
      if (hasMidplane && hasPlaneId) return null;
      if (hasMidplane) {
        const midplaneFaces = asFaceIdPair(o.midplaneFaces);
        if (!midplaneFaces) return null;
        if (o.planePoint !== undefined || o.planeNormal !== undefined || o.planeId !== undefined) return null;
        return { op: "splitByPlane", targets, midplaneFaces, keep } as SplitByPlaneOp;
      }
      if (hasPlaneId) {
        const planeId = asPlaneId(o.planeId);
        if (!planeId) return null;
        if (o.planePoint !== undefined || o.planeNormal !== undefined) {
          if (o.planePoint === undefined || o.planeNormal === undefined) return null;
          const planePoint = asVec3(o.planePoint);
          const planeNormal = asNonZeroVec3(o.planeNormal);
          if (!planePoint || !planeNormal) return null;
          return { op: "splitByPlane", targets, planeId, planePoint, planeNormal, keep } as SplitByPlaneOp;
        }
        return { op: "splitByPlane", targets, planeId, keep } as SplitByPlaneOp;
      }
      const planePoint = asVec3(o.planePoint);
      const planeNormal = asNonZeroVec3(o.planeNormal);
      return planePoint && planeNormal ? { op: "splitByPlane", targets, planePoint, planeNormal, keep } : null;
    }
    case "section": {
      const targets = asIdArray(o.targets);
      if (!targets) return null;
      const hasMidplane = o.midplaneFaces !== undefined;
      const hasPlaneId = o.planeId !== undefined;
      if (hasMidplane && hasPlaneId) return null;
      if (hasMidplane) {
        const midplaneFaces = asFaceIdPair(o.midplaneFaces);
        if (!midplaneFaces) return null;
        if (o.planePoint !== undefined || o.planeNormal !== undefined || o.planeId !== undefined) return null;
        return { op: "section", targets, midplaneFaces } as SectionOp;
      }
      if (hasPlaneId) {
        const planeId = asPlaneId(o.planeId);
        if (!planeId) return null;
        if (o.planePoint !== undefined || o.planeNormal !== undefined) {
          if (o.planePoint === undefined || o.planeNormal === undefined) return null;
          const planePoint = asVec3(o.planePoint);
          const planeNormal = asNonZeroVec3(o.planeNormal);
          if (!planePoint || !planeNormal) return null;
          return { op: "section", targets, planeId, planePoint, planeNormal } as SectionOp;
        }
        return { op: "section", targets, planeId } as SectionOp;
      }
      const planePoint = asVec3(o.planePoint);
      const planeNormal = asNonZeroVec3(o.planeNormal);
      return planePoint && planeNormal ? { op: "section", targets, planePoint, planeNormal } : null;
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
      if (!center || !axis || !isPositive(o.radius) || !isPositive(o.height) || !isFiniteNumber(o.sides) || !Number.isInteger(o.sides) || o.sides < 3) return null;
      if (o.circumscribed !== undefined && typeof o.circumscribed !== "boolean") return null;
      const out: AddPrismOp = { op: "addPrism", center, axis, radius: o.radius, sides: o.sides, height: o.height };
      if (o.circumscribed !== undefined) out.circumscribed = o.circumscribed;
      return out;
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
      if (!center || !normal || !up || !notParallel(normal, up) || !isPositive(o.radius) || !isFiniteNumber(o.sides) || !Number.isInteger(o.sides) || o.sides < 3) return null;
      if (o.circumscribed !== undefined && typeof o.circumscribed !== "boolean") return null;
      const out: AddPolygonProfileOp = { op: "addPolygonProfile", center, normal, up, radius: o.radius, sides: o.sides };
      if (o.circumscribed !== undefined) out.circumscribed = o.circumscribed;
      return out;
    }
    case "addWedge": {
      const center = asVec3(o.center);
      const axis = asNonZeroVec3(o.axis);
      const up = asNonZeroVec3(o.up);
      return center && axis && up && notParallel(axis, up)
        && isPositive(o.dx) && isPositive(o.dy) && isPositive(o.dz)
        && isFiniteNumber(o.ltx) && o.ltx >= 0
        ? { op: "addWedge", center, axis, up, dx: o.dx, dy: o.dy, dz: o.dz, ltx: o.ltx }
        : null;
    }
    case "addHole": {
      const targets = asIdArray(o.targets);
      const position = asVec3(o.position);
      const axis = asNonZeroVec3(o.axis);
      return targets && position && axis && isPositive(o.radius) && isPositive(o.depth)
        ? { op: "addHole", targets, position, axis, radius: o.radius, depth: o.depth }
        : null;
    }
    case "addCounterboreHole": {
      const targets = asIdArray(o.targets);
      const position = asVec3(o.position);
      const axis = asNonZeroVec3(o.axis);
      return targets && position && axis && isPositive(o.radius) && isPositive(o.depth)
        && isPositive(o.cbRadius) && o.cbRadius > o.radius
        && isPositive(o.cbDepth) && o.cbDepth < o.depth
        ? { op: "addCounterboreHole", targets, position, axis, radius: o.radius, depth: o.depth, cbRadius: o.cbRadius, cbDepth: o.cbDepth }
        : null;
    }
    case "addCountersinkHole": {
      const targets = asIdArray(o.targets);
      const position = asVec3(o.position);
      const axis = asNonZeroVec3(o.axis);
      return targets && position && axis && isPositive(o.radius) && isPositive(o.depth)
        && isPositive(o.csRadius) && o.csRadius > o.radius
        && isFiniteNumber(o.csAngleDeg) && o.csAngleDeg > 0 && o.csAngleDeg < 180
        ? { op: "addCountersinkHole", targets, position, axis, radius: o.radius, depth: o.depth, csRadius: o.csRadius, csAngleDeg: o.csAngleDeg }
        : null;
    }
    case "addEllipseProfile": {
      const center = asVec3(o.center);
      const normal = asNonZeroVec3(o.normal);
      const up = asNonZeroVec3(o.up);
      return center && normal && up && notParallel(normal, up)
        && isPositive(o.radiusX) && isPositive(o.radiusY)
        ? { op: "addEllipseProfile", center, normal, up, radiusX: o.radiusX, radiusY: o.radiusY }
        : null;
    }
    case "addRoundedRectangleProfile": {
      const center = asVec3(o.center);
      const normal = asNonZeroVec3(o.normal);
      const up = asNonZeroVec3(o.up);
      return center && normal && up && notParallel(normal, up)
        && isPositive(o.width) && isPositive(o.height) && isPositive(o.cornerRadius)
        && 2 * o.cornerRadius < Math.min(o.width, o.height)
        ? { op: "addRoundedRectangleProfile", center, normal, up, width: o.width, height: o.height, cornerRadius: o.cornerRadius }
        : null;
    }
    case "addSlotProfile": {
      const center = asVec3(o.center);
      const normal = asNonZeroVec3(o.normal);
      const up = asNonZeroVec3(o.up);
      return center && normal && up && notParallel(normal, up)
        && isPositive(o.length) && isPositive(o.width) && o.length > o.width
        ? { op: "addSlotProfile", center, normal, up, length: o.length, width: o.width }
        : null;
    }
    case "addTrapezoidProfile": {
      const center = asVec3(o.center);
      const normal = asNonZeroVec3(o.normal);
      const up = asNonZeroVec3(o.up);
      return center && normal && up && notParallel(normal, up)
        && isPositive(o.bottomWidth) && isPositive(o.topWidth) && isPositive(o.height)
        ? { op: "addTrapezoidProfile", center, normal, up, bottomWidth: o.bottomWidth, topWidth: o.topWidth, height: o.height }
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
    case "addPolyline": {
      const closed = o.closed === true;
      const points = asVec3Array(o.points, closed ? 3 : 2);
      // A closed polyline also needs distinct first/last (the closing edge is implicit).
      return points && (!closed || !vecEqual(points[0], points[points.length - 1]))
        ? { op: "addPolyline", points, closed }
        : null;
    }
    case "addThreePointArc": {
      const p1 = asVec3(o.p1);
      const p2 = asVec3(o.p2);
      const p3 = asVec3(o.p3);
      return p1 && p2 && p3 && !vecEqual(p1, p2) && !vecEqual(p2, p3) && !vecEqual(p1, p3)
        ? { op: "addThreePointArc", p1, p2, p3 }
        : null;
    }
    case "addSpline": {
      const points = asVec3Array(o.points, 2);
      return points ? { op: "addSpline", points } : null;
    }
    case "addBezier": {
      const controlPoints = asVec3Array(o.controlPoints, 2, false);
      return controlPoints ? { op: "addBezier", controlPoints } : null;
    }
    case "addEllipseArc": {
      const center = asVec3(o.center);
      const normal = asNonZeroVec3(o.normal);
      const up = asNonZeroVec3(o.up);
      return center && normal && up && notParallel(normal, up)
        && isPositive(o.radiusX) && isPositive(o.radiusY)
        && isFiniteNumber(o.startAngleDeg) && isFiniteNumber(o.endAngleDeg)
        && o.startAngleDeg !== o.endAngleDeg
        ? { op: "addEllipseArc", center, normal, up, radiusX: o.radiusX, radiusY: o.radiusY, startAngleDeg: o.startAngleDeg, endAngleDeg: o.endAngleDeg }
        : null;
    }
    case "addHelix": {
      const center = asVec3(o.center);
      const axis = asNonZeroVec3(o.axis);
      return center && axis && isPositive(o.radius) && isPositive(o.pitch) && isPositive(o.turns)
        ? { op: "addHelix", center, axis, radius: o.radius, pitch: o.pitch, turns: o.turns }
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
    case "align": {
      const targets = asIdArray(o.targets);
      const axis = o.axis;
      const extent = o.extent;
      return targets &&
        (axis === "x" || axis === "y" || axis === "z") &&
        (extent === "min" || extent === "center" || extent === "max") &&
        isFiniteNumber(o.to)
        ? { op: "align", targets, axis, extent, to: o.to }
        : null;
    }
    case "patternLinear": {
      const targets = asIdArray(o.targets);
      const direction = asNonZeroVec3(o.direction);
      return targets && direction && isFiniteNumber(o.spacing) && o.spacing !== 0 && isCountAtLeast(o.count, 2)
        ? { op: "patternLinear", targets, direction, spacing: o.spacing, count: o.count }
        : null;
    }
    case "patternCircular": {
      const targets = asIdArray(o.targets);
      if (!targets) return null;
      if (!isFiniteNumber(o.angleDeg) || !isCountAtLeast(o.count, 2)) return null;
      const hasMidaxis = o.midaxisOf !== undefined;
      if (hasMidaxis) {
        const midaxisOf = asMidaxisPair(o.midaxisOf);
        if (!midaxisOf) return null;
        if (o.axisPoint !== undefined || o.axisDir !== undefined) return null;
        return { op: "patternCircular", targets, midaxisOf, angleDeg: o.angleDeg as number, count: o.count as number } as PatternCircularOp;
      }
      const axisPoint = asVec3(o.axisPoint);
      const axisDir = asNonZeroVec3(o.axisDir);
      return axisPoint && axisDir ? { op: "patternCircular", targets, axisPoint, axisDir, angleDeg: o.angleDeg as number, count: o.count as number } : null;
    }
    default:
      return null;
  }
}
