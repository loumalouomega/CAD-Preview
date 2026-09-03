import { getOcct, readShape, wrapOcctFault } from "./occtService";
import {
  applyEditsBRep,
  collectSolids,
  collectFaces,
  collectEdges,
  collectVertices,
  bboxCenter,
  bboxDiagonal,
  bboxExtent,
  facePlane,
  faceSurfaceInfo,
  combineSolids,
} from "./occtOperations";
import { rebindEntities, remapPartEntityIds, type EntityRebindMatch, type EntitySignature } from "./entityRebind";
import {
  bucketReferenceIds,
  isBindableSelector,
  validateSelectorQuery,
  type SelectorQuery,
} from "./selectorQuery";
import { matchesFacePredicate, rankFaces, type FilterableFace } from "./selectorPredicate";
import type { OpBucket } from "./opBuckets";
import { TOPOLOGY_CHANGING_OPS } from "./editOps";
import { surfacePropertiesAdaptive, volumePropertiesAdaptive } from "./brepGProp";
import type { CadFormat } from "./fileRouter";
import type { EditOp, Vec3 } from "./editOps";
import type { Annotation, Part } from "./protocol";

export type BRepFormat = Extract<CadFormat, "step" | "iges" | "brep">;

/**
 * Human-readable surface classification for a `face-N`, mapped from
 * `GeomAbs_SurfaceType`. **Verified against the live WASM** (brute-force
 * probing, same convention as every other OCCT call in this codebase — see
 * CLAUDE.md): `GeomAbs_Plane=0`, `GeomAbs_Cylinder=1`, `GeomAbs_Cone=2`,
 * `GeomAbs_Sphere=3`, `GeomAbs_Torus=4` (confirmed by building a box,
 * cylinder, cone, sphere, and torus via `BRepPrimAPI_Make*` and reading
 * `BRepAdaptor_Surface_2(face,true).GetType().value` off each). The
 * remaining enum members (`BezierSurface=5`, `BSplineSurface=6`,
 * `SurfaceOfRevolution=7`, `SurfaceOfExtrusion=8`, `OffsetSurface=9`,
 * `OtherSurface=10`) were read directly off the enum object rather than
 * built/probed individually — all collapse to `"other"` here since none of
 * this codebase's feature-modeling ops (extrude/revolve/sweep/loft) produce
 * a face type an agent would need to distinguish beyond "not one of the
 * five primitive surface kinds".
 */
export type SurfaceType = "plane" | "cylinder" | "cone" | "sphere" | "torus" | "other";

/**
 * The analytic parameters of a face's underlying surface — the numbers
 * {@link SurfaceType} previously implied but withheld.
 *
 * **Frame and units.** Every point and direction is in the WORLD coordinates
 * of the shape after op replay — the same frame as `bbox`, `center`,
 * `planeOrigin`, and the points `measure`/`measure_exact` report — and every
 * length is in the source file's own units, unconverted, exactly like `bbox`
 * and `area`. Verified against the live WASM under both translation (with
 * `BRepBuilderAPI_Transform`'s copy and location-only modes) and rotation:
 * `BRepAdaptor_Surface` applies the face's own `TopLoc_Location` inside the
 * accessor, so nothing here needs converting. Directions are unit length by
 * construction (`gp_Dir`), but expect ~1e-16 dirt off the axes after a
 * rotation — compare with a tolerance, never `===`.
 *
 * **`axisLocation` is a point ON the axis and nothing more.** It is not the
 * face's centre, not necessarily inside the face's own extent, and not stable
 * across kernels — for a `BRepPrimAPI` cylinder it happens to be the base
 * circle's centre, while for a filleted box edge it landed on the fillet's
 * own axis. Use `axisLocation` + `axisDirection` as the infinite axis line;
 * use `bbox`/`center` for where the face actually is.
 *
 * **Deliberately NOT reported**: whether a cylinder is a hole or a boss. A
 * `gp_Cylinder` is identical for both — the material side lives in the face's
 * `TopAbs_Orientation`, not in its surface — so no field here implies one.
 */
export type SurfaceParams =
  | { kind: "plane"; origin: Vec3; normal: Vec3 }
  | { kind: "cylinder"; radius: number; axisLocation: Vec3; axisDirection: Vec3 }
  | {
      kind: "cone";
      axisLocation: Vec3;
      axisDirection: Vec3;
      /** The cone's radius measured AT `axisLocation` — meaningless without
       * it, which is why `apex` ships alongside as an absolute anchor. The
       * identity `refRadius === |apex - axisLocation| * tan(|semiAngle|)`
       * holds wherever OCCT chooses to put the location. */
      refRadius: number;
      apex: Vec3;
      /** Half-angle in DEGREES (this codebase's convention everywhere — see
       * `ExactMeasureResult.angleDeg` and every `*Deg` op field), converted
       * from OCCT's radians. **Signed, and the sign is load-bearing**: a
       * positive half-angle means the radius GROWS along `axisDirection`.
       * Verified both ways against the live WASM. */
      semiAngleDeg: number;
    }
  | { kind: "sphere"; center: Vec3; radius: number }
  | {
      kind: "torus";
      axisLocation: Vec3;
      axisDirection: Vec3;
      majorRadius: number;
      minorRadius: number;
    };

/** Analytic curve classification of an edge — the edge-side counterpart of
 * {@link SurfaceType}, which had no analogue before. */
export type CurveType = "line" | "circle" | "ellipse" | "hyperbola" | "parabola" | "bezier" | "bspline" | "other";

/** `GeomAbs_CurveType` ordinals. Read symbolically at runtime (never
 * hardcoded) — see {@link curveTypeOf}; this table only names the ordinals
 * OCCT's own enum defines, in its declared order. */
const CURVE_TYPE_BY_VALUE: Record<number, CurveType> = {
  0: "line",
  1: "circle",
  2: "ellipse",
  3: "hyperbola",
  4: "parabola",
  5: "bezier",
  6: "bspline",
};

export interface EntityFacts {
  entityId: string;
  kind: "solid" | "face" | "edge" | "point";
  bbox: { min: Vec3; max: Vec3; diagonal: number } | null;
  /** Bounding-box centre (via `bboxCenter`) — for an asymmetric shape this is
   * NOT the same point as `get_mass_properties`' area/volume-weighted
   * `centerOfMass`. Use this for "where roughly is X" / as a `measure`
   * anchor; use `get_mass_properties` when the mass-weighted centroid
   * itself is the thing being asked about. */
  center: Vec3;
  /** Solid: boundary (surface) area. Face: the face's own area. Null for
   * edge/point. */
  area: number | null;
  /** Set only for a single edge. */
  length: number | null;
  /** Set only for a planar face; null for non-planar faces and every other kind. */
  normal: Vec3 | null;
  /** Set only for a planar face, beside `normal`: the plane's own origin as
   * OCCT computed it (`gp_Pln.Location()` via `facePlane`) — a point that
   * genuinely lies ON the face's plane, unlike `center` (the bounding-box
   * centre, which is coplanar with a planar face but is not guaranteed to
   * lie on an annular or concave one). Usable directly as `planePoint` for
   * the `section`/`splitByPlane`/`mirror` ops. */
  planeOrigin: Vec3 | null;
  /** Set only for a face. */
  surfaceType: SurfaceType | null;
  /** The analytic parameters behind {@link surfaceType} — radius, axis, cone
   * half-angle, torus radii. Face only, and null for `surfaceType: "other"`
   * (a Bezier/B-spline/swept face has no closed-form parameters to report).
   * When non-null, `surfaceParams.kind === surfaceType` always.
   *
   * `normal`/`planeOrigin` above are projections of the `"plane"` variant,
   * read from the SAME adaptor so they cannot disagree — they predate this
   * field and are kept because Clip ▸ Face and the inspector card consume
   * them directly. Nothing populates them for a curved face: doing so would
   * make Clip ▸ Face silently accept a cylinder and cut on a meaningless
   * plane, in place of the explanatory refusal it gives today. */
  surfaceParams: SurfaceParams | null;
  /** Set only for an edge; null for every other kind. Uses the same
   * `BRepAdaptor_Curve_2(edge).GetType()` call `measureExact`'s `"radius"`
   * kind already exercises against the live WASM, so this needed no new
   * probing — it is a new field on an existing function, not new kernel
   * surface. */
  curveType: CurveType | null;
}

export type ExactMeasureKind = "distance" | "edgeLength" | "radius";

export interface ExactMeasureResult {
  kind: ExactMeasureKind;
  value: number;
  /** Set only for `kind: "distance"` — the actual nearest points OCCT found
   * on each shape (not necessarily either entity's centre or an endpoint). */
  fromPoint?: Vec3;
  toPoint?: Vec3;
  /** `kind: "distance"` only — straight-line distance between the two
   * entities' bounding-box centres (the number `measure` reports; included
   * here so one call answers both "how close do they get" and "how far apart
   * are they overall"). */
  centreDistance?: number;
  /** `kind: "distance"` between two PLANAR faces only — the perpendicular
   * distance between their planes, meaningful exactly when the planes are
   * parallel. Absent when either face is non-planar or the planes aren't
   * parallel. */
  parallelDistance?: number;
  /** `kind: "distance"` between two planar faces only — angle between their
   * (outward-oriented) normal vectors in degrees, `[0, 180]`. Two
   * opposite-facing parallel faces of a solid legitimately read 180; use
   * `parallelDistance`'s presence as the parallelism signal, not this value. */
  angleDeg?: number;
  /** `kind: "distance"` only — which reported number most likely answers
   * "how far apart are these": `"parallel"` when `parallelDistance` was
   * computed (two parallel planar faces — the perpendicular gap is almost
   * always the dimension being asked about), else `"min"`. A fact about
   * which quantity fits the pair's geometry, never a judgment of the value. */
  primary?: "min" | "parallel";
}

export interface MeasureResult {
  from: string;
  to: string;
  fromPoint: Vec3;
  toPoint: Vec3;
  /** Straight-line distance between `fromPoint` and `toPoint`. */
  distance: number;
  /** `toPoint - fromPoint`. */
  delta: Vec3;
  /** Echoed back, as given (not normalized). */
  axis?: Vec3;
  /** `delta · normalize(axis)`, only present when `axis` was given. */
  axisComponent?: number;
}

/** Parses a `solid-N`/`face-N`/`edge-N`/`point-N` id into its live OCCT
 * shape handle, using the same regex-dispatch convention as
 * `massProperties.ts`'s `computeMassProperties`. Throws `Unknown entity id`
 * for an out-of-range index and `Unsupported entity id` for anything else. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveEntity(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oc: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shape: any,
  entityId: string,
  cleanup: Array<{ delete(): void }>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { kind: EntityFacts["kind"]; handle: any } {
  const solidMatch = /^solid-(\d+)$/.exec(entityId);
  if (solidMatch) {
    const solids = collectSolids(oc, shape, cleanup);
    const s = solids[Number(solidMatch[1])];
    if (!s) throw new Error(`Unknown entity id: ${entityId}`);
    return { kind: "solid", handle: s.solid };
  }

  const faceMatch = /^face-(\d+)$/.exec(entityId);
  if (faceMatch) {
    const faces = collectFaces(oc, shape, cleanup);
    const f = faces[Number(faceMatch[1])];
    if (!f) throw new Error(`Unknown entity id: ${entityId}`);
    return { kind: "face", handle: f };
  }

  const edgeMatch = /^edge-(\d+)$/.exec(entityId);
  if (edgeMatch) {
    const edges = collectEdges(oc, shape, cleanup);
    const e = edges[Number(edgeMatch[1])];
    if (!e) throw new Error(`Unknown entity id: ${entityId}`);
    return { kind: "edge", handle: e };
  }

  const pointMatch = /^point-(\d+)$/.exec(entityId);
  if (pointMatch) {
    const vertices = collectVertices(oc, shape, cleanup);
    const v = vertices[Number(pointMatch[1])];
    if (!v) throw new Error(`Unknown entity id: ${entityId}`);
    return { kind: "point", handle: v };
  }

  throw new Error(`Unsupported entity id: ${entityId}`);
}

/** `Bnd_Box` corners + diagonal for `handle` (whole shape, a solid, a face,
 * an edge, or a vertex — `BRepBndLib.Add` accepts any `TopoDS_Shape`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function boundsOf(oc: any, handle: any, cleanup: Array<{ delete(): void }>): { min: Vec3; max: Vec3; diagonal: number } {
  const box = new oc.Bnd_Box_1();
  cleanup.push(box);
  oc.BRepBndLib.Add(handle, box, false);
  const mn = box.CornerMin();
  cleanup.push(mn);
  const mx = box.CornerMax();
  cleanup.push(mx);
  const min: Vec3 = [mn.X(), mn.Y(), mn.Z()];
  const max: Vec3 = [mx.X(), mx.Y(), mx.Z()];
  return { min, max, diagonal: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) };
}

/** Pure helpers for `measureExact`'s additive face-pair fields — trivial, but
 * kept named so the parallelism tolerance reads as intent rather than magic. */
function normalizeVec(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Per-entity geometric facts (bbox, bbox-centre, area/length, planar-face
 * normal + surface type) for one `solid-N`/`face-N`/`edge-N`/`point-N`, via
 * OCCT. Re-parses `bytes` and replays `ops` fresh on every call, exactly
 * like `computeMassProperties` and every other B-rep read path in this
 * codebase — there is no shape/session cache. Deliberately does NOT compute
 * volume/mass/inertia (that's `get_mass_properties`'s job) and deliberately
 * uses the bounding-box centre rather than the mass centroid for `center` —
 * see `EntityFacts.center`'s doc comment.
 */
export async function getEntityFacts(
  extensionPath: string,
  bytes: Uint8Array,
  format: BRepFormat,
  ops: EditOp[],
  entityId: string
): Promise<EntityFacts> {
  const oc = await getOcct(extensionPath);
  const tmpName = `/ef.${format}`;
  oc.FS.writeFile(tmpName, bytes);

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const baseShape = readShape(oc, tmpName, format, cleanup);
    const shape = applyEditsBRep(oc, baseShape, ops, cleanup);
    const { kind, handle } = resolveEntity(oc, shape, entityId, cleanup);

    const bbox = boundsOf(oc, handle, cleanup);
    const center = bboxCenter(oc, handle, cleanup);

    let area: number | null = null;
    let length: number | null = null;
    let normal: Vec3 | null = null;
    let planeOrigin: Vec3 | null = null;
    let surfaceType: SurfaceType | null = null;
    let surfaceParams: SurfaceParams | null = null;
    let curveType: CurveType | null = null;

    if (kind === "solid" || kind === "face") {
      const props = new oc.GProp_GProps_1();
      cleanup.push(props);
      surfacePropertiesAdaptive(oc, handle, props);
      area = props.Mass();
    }

    if (kind === "edge") {
      const props = new oc.GProp_GProps_1();
      cleanup.push(props);
      oc.BRepGProp.LinearProperties(handle, props, false, false);
      length = props.Mass();
      const curve = new oc.BRepAdaptor_Curve_2(handle);
      cleanup.push(curve);
      curveType = CURVE_TYPE_BY_VALUE[curve.GetType().value] ?? "other";
    }

    if (kind === "face") {
      // ONE adaptor for both the classification and the parameters — this used
      // to build two (its own, plus `facePlane`'s) on the same face, which also
      // meant a plane's normal had two independent sources that could drift.
      const info = faceSurfaceInfo(oc, handle, cleanup);
      surfaceType = info.type;
      surfaceParams = info.params;
      // Projections of the same read, kept because they are load-bearing for
      // Clip > Face, the inspector card, and existing smoke assertions.
      normal = info.params?.kind === "plane" ? info.params.normal : null;
      planeOrigin = info.params?.kind === "plane" ? info.params.origin : null;
    }

    return {
      entityId,
      kind,
      bbox,
      center,
      area,
      length,
      normal,
      planeOrigin,
      surfaceType,
      surfaceParams,
      curveType,
    };
  } catch (err) {
    throw wrapOcctFault(err);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try {
        cleanup[i].delete();
      } catch {
        /* ignore */
      }
    }
    try {
      oc.FS.unlink(tmpName);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Straight-line distance between two entities' bounding-box centres
 * (`bboxCenter` — same "not the mass centroid" caveat as `getEntityFacts`),
 * plus the signed component of that displacement along an optional `axis`.
 * One parse/replay, both ids resolved against the same live shape.
 */
export async function measureEntities(
  extensionPath: string,
  bytes: Uint8Array,
  format: BRepFormat,
  ops: EditOp[],
  from: string,
  to: string,
  axis?: Vec3
): Promise<MeasureResult> {
  const oc = await getOcct(extensionPath);
  const tmpName = `/ef.${format}`;
  oc.FS.writeFile(tmpName, bytes);

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const baseShape = readShape(oc, tmpName, format, cleanup);
    const shape = applyEditsBRep(oc, baseShape, ops, cleanup);

    const fromEntity = resolveEntity(oc, shape, from, cleanup);
    const toEntity = resolveEntity(oc, shape, to, cleanup);
    const fromPoint = bboxCenter(oc, fromEntity.handle, cleanup);
    const toPoint = bboxCenter(oc, toEntity.handle, cleanup);
    const delta: Vec3 = [toPoint[0] - fromPoint[0], toPoint[1] - fromPoint[1], toPoint[2] - fromPoint[2]];
    const distance = Math.hypot(delta[0], delta[1], delta[2]);

    const result: MeasureResult = { from, to, fromPoint, toPoint, distance, delta };
    if (axis) {
      const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
      const unit: Vec3 = [axis[0] / len, axis[1] / len, axis[2] / len];
      result.axis = axis;
      result.axisComponent = delta[0] * unit[0] + delta[1] * unit[1] + delta[2] * unit[2];
    }
    return result;
  } catch (err) {
    throw wrapOcctFault(err);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try {
        cleanup[i].delete();
      } catch {
        /* ignore */
      }
    }
    try {
      oc.FS.unlink(tmpName);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Exact B-rep-precision measurement — a host round trip an agent (or, via
 * `measureExactRequest`, the interactive webview Measure tool) opts into on
 * top of the always-available, instant client-side triangulated
 * approximation (`src/webview/measurement.ts`, tied to `meshExtract.ts`'s
 * 0.1 tessellation deflection). Reuses `resolveEntity` (this file) for id
 * resolution, so it accepts the same `solid-N`/`face-N`/`edge-N`/`point-N`
 * ids every other entity-facts path does.
 *
 * **`kind: "distance"`** — the true minimum distance between two arbitrary
 * shapes (point/edge/face/solid, any combination), via
 * `BRepExtrema_DistShapeShape`. **Verified against the live WASM** (brute-
 * force probing, the usual convention): only 3 constructor overloads exist
 * in this binding — `_1` (0 args), `_2` (4 args), `_3` (5 args); calling `_1`
 * or `_2`/`_3` directly with `(shape1, shape2)` throws an argument-count
 * error (their real params are `(shape1, shape2, extFlag, extAlgo[,
 * deflection])`, and guessing the `Extrema_ExtFlag`/`Extrema_ExtAlgo` enum
 * values felt riskier than the alternative that's guaranteed to hit the same
 * defaults: construct with `_1()` (0 args) and call `.LoadS1(shape1)` →
 * `.LoadS2(shape2)` → `.Perform()` — confirmed working end-to-end on a real
 * box-vs-cylinder pair, returning a genuine geometric distance (not a bbox
 * approximation) and nearest points that land exactly where hand-computed
 * geometry predicts. `.IsDone()` gates a real, non-degenerate result;
 * `.Value()` is the distance; `.PointOnShape1(1)`/`.PointOnShape2(1)` (1
 * = first solution — `BRepExtrema_DistShapeShape` supports multiple
 * equidistant solutions in general, but this feature only ever wants "a"
 * nearest-point pair) return `gp_Pnt`-like handles for the actual nearest
 * points OCCT found — NOT necessarily either entity's centre, an endpoint,
 * or any point a user could have picked, which is exactly the extra
 * precision a triangulated approximation can't give.
 *
 * **MAX distance (roadmap "Richer exact measurement", closed as
 * probed-and-unavailable)** — the roadmap asked for minimum AND maximum
 * separation. Probed against the live WASM, both candidate kernel paths are
 * genuinely dead in this build, recorded here so neither is re-proposed:
 * (1) `BRepExtrema_DistanceSS` (green in the manifest) — its usable 7-arg
 * constructor `(S1, S2, Bnd_Box, Bnd_Box, dst, Extrema_ExtFlag,
 * Extrema_ExtAlgo)` constructs but NEVER computes (no `Perform` method
 * exists; `IsDone()` stays false and `DistValue()` echoes the `dst`
 * early-exit hint verbatim regardless of filled bounding boxes or flag),
 * and its other overloads need `BRepExtrema_ShapeType`, which is NOT bound;
 * (2) `DistShapeShape_2(S1, S2, extFlag, extAlgo)` accepts the (bound!)
 * `Extrema_ExtFlag_MAX` silently but ignores it — always returns the
 * minimum. So this function reports the minimum exactly, plus the additive
 * context fields below; a caller wanting "how far apart overall" has
 * `centreDistance`.
 *
 * **`kind: "edgeLength"`** — reuses the exact `BRepGProp.LinearProperties`
 * call shape `getEntityFacts` above already verified (single-edge only, per
 * that function's own doc comment — never call it over multiple edges).
 *
 * **`kind: "radius"`** — only valid for an edge whose underlying curve is a
 * true circle: `BRepAdaptor_Curve_2(edge).GetType()` compared symbolically
 * against `oc.GeomAbs_CurveType.GeomAbs_Circle.value` (never a hardcoded
 * literal, so this stays correct regardless of the enum's actual numeric
 * value in a given build) — then `.Circle()` returns a `gp_Circ`-like
 * handle, `.Radius()` the exact radius. **Verified end-to-end against the
 * live WASM**, not just that the calls don't throw: a cylinder primitive
 * added via `addCylinder(radius: 3, ...)` and re-measured through this exact
 * path (`apply_edit_ops` → `measure_exact`) resolved its rim edges' radius
 * as exactly `3`, and an unrelated circular edge already present in
 * `bull.stp` resolved to a plausible `2.5399999999998477`. A non-circular
 * edge (line, B-spline, ellipse, …) throws a clear, actionable error rather
 * than silently returning a meaningless "best-fit" number.
 */
export async function measureExact(
  extensionPath: string,
  bytes: Uint8Array,
  format: BRepFormat,
  ops: EditOp[],
  kind: ExactMeasureKind,
  entityIdA: string,
  entityIdB?: string
): Promise<ExactMeasureResult> {
  const oc = await getOcct(extensionPath);
  const tmpName = `/me.${format}`;
  oc.FS.writeFile(tmpName, bytes);

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const baseShape = readShape(oc, tmpName, format, cleanup);
    const shape = applyEditsBRep(oc, baseShape, ops, cleanup);
    const a = resolveEntity(oc, shape, entityIdA, cleanup);

    if (kind === "distance") {
      if (!entityIdB) throw new Error('"distance" requires entityIdB');
      const b = resolveEntity(oc, shape, entityIdB, cleanup);
      const dist = new oc.BRepExtrema_DistShapeShape_1();
      cleanup.push(dist);
      dist.LoadS1(a.handle);
      dist.LoadS2(b.handle);
      dist.Perform();
      if (!dist.IsDone()) throw new Error("BRepExtrema_DistShapeShape did not converge for these entities");
      const p1 = dist.PointOnShape1(1);
      cleanup.push(p1);
      const p2 = dist.PointOnShape2(1);
      cleanup.push(p2);
      const result: ExactMeasureResult = {
        kind,
        value: dist.Value(),
        fromPoint: [p1.X(), p1.Y(), p1.Z()],
        toPoint: [p2.X(), p2.Y(), p2.Z()],
      };

      // Additive context fields (roadmap "Richer exact measurement", closed).
      // centreDistance is the number `measure` reports — included so one call
      // answers both "how close do they get" and "how far apart overall".
      const c1 = bboxCenter(oc, a.handle, cleanup);
      const c2 = bboxCenter(oc, b.handle, cleanup);
      result.centreDistance = Math.hypot(c2[0] - c1[0], c2[1] - c1[1], c2[2] - c1[2]);

      // Two planar faces additionally get the angle between their normals and
      // — when the planes are parallel — the perpendicular plane-to-plane gap,
      // which becomes the primary answer for that pair. (MAX distance was the
      // roadmap's other ask; probed and genuinely unavailable in this WASM
      // build — see this function's doc comment.)
      if (a.kind === "face" && b.kind === "face") {
        const planeA = facePlane(oc, a.handle, cleanup);
        const planeB = facePlane(oc, b.handle, cleanup);
        if (planeA && planeB) {
          const n1 = normalizeVec(planeA.nl);
          const n2 = normalizeVec(planeB.nl);
          const cosAngle = clamp(n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2], -1, 1);
          result.angleDeg = Math.acos(cosAngle) * (180 / Math.PI);
          // Parallel within ~1e-6 cosine (~8e-5 degrees): report the
          // perpendicular gap |Δorigin·n̂1| and name it the primary value.
          if (Math.abs(cosAngle) >= 1 - 1e-6) {
            const dx = planeB.pt[0] - planeA.pt[0];
            const dy = planeB.pt[1] - planeA.pt[1];
            const dz = planeB.pt[2] - planeA.pt[2];
            result.parallelDistance = Math.abs(dx * n1[0] + dy * n1[1] + dz * n1[2]);
            result.primary = "parallel";
          }
        }
      }
      result.primary ??= "min";
      return result;
    }

    if (kind === "edgeLength") {
      if (a.kind !== "edge") throw new Error('"edgeLength" requires an edge entity');
      const props = new oc.GProp_GProps_1();
      cleanup.push(props);
      oc.BRepGProp.LinearProperties(a.handle, props, false, false);
      return { kind, value: props.Mass() };
    }

    // kind === "radius"
    if (a.kind !== "edge") throw new Error('"radius" requires an edge entity');
    const curve = new oc.BRepAdaptor_Curve_2(a.handle);
    cleanup.push(curve);
    if (curve.GetType().value !== oc.GeomAbs_CurveType.GeomAbs_Circle.value) {
      throw new Error("This edge is not a circular arc — radius is only defined for circular edges");
    }
    const circ = curve.Circle();
    cleanup.push(circ);
    return { kind, value: circ.Radius() };
  } catch (err) {
    throw wrapOcctFault(err);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try {
        cleanup[i].delete();
      } catch {
        /* ignore */
      }
    }
    try {
      oc.FS.unlink(tmpName);
    } catch {
      /* ignore */
    }
  }
}

export interface InterferenceResult {
  hasOverlap: boolean;
  /** 0 when `hasOverlap` is false (either genuinely no overlap, or one/both
   * sides didn't resolve to any real solid — see `unresolvedA`/`unresolvedB`). */
  overlapVolume: number;
  /** Ids in `a`/`b` that didn't resolve to a real `solid-N` in the current
   * (post-edit-replay) shape — same graceful "skip, don't throw" convention
   * every other unresolved-id path in this codebase already follows. */
  unresolvedA: string[];
  unresolvedB: string[];
}

/**
 * Interference / clash detection (roadmap item, closed) — reports the
 * overlap volume (if any) between two solid sets, read-only: never mutates
 * or persists anything, just intersects and measures. A natural sibling to
 * `measureEntities`/`measureExact` above and to `compare_models`, reusing
 * two already-verified call shapes wholesale rather than probing anything
 * new — `occtOperations.ts`'s `booleanSolids`/`combineSolids` (the exact
 * "compound the operand's solids together first" framing this function
 * copies for its own `a`/`b` operands, verified via the live `boolean` edit
 * op) for the intersection itself (`BRepAlgoAPI_Common_3(a, b)` →
 * `.IsDone()` → `.Shape()`), and this file's own `volumeOf` (the same
 * `BRepGProp` volume call shape (via `src/brepGProp.ts`'s adaptive wrapper) that `get_mass_properties` uses) for
 * the resulting volume.
 *
 * `a`/`b` are `solid-N` id arrays — a Part with multiple volumes maps
 * directly onto this (the MCP tool layer resolves a Part NAME to its
 * `volumes` array before calling this function; this function itself stays
 * ignorant of Parts entirely, id-array-in, matching every other
 * `collectSolids`-based function in this codebase). An id that doesn't
 * resolve is dropped (reported in `unresolvedA`/`unresolvedB`), never
 * thrown — if that leaves either side with zero resolved solids, or the
 * `BRepAlgoAPI_Common_3` doesn't complete, the result is a clean
 * `hasOverlap: false` / `overlapVolume: 0`, the same "skip gracefully"
 * convention `booleanSolids` itself already follows on replay.
 */
export async function checkInterference(
  extensionPath: string,
  bytes: Uint8Array,
  format: BRepFormat,
  ops: EditOp[],
  a: string[],
  b: string[]
): Promise<InterferenceResult> {
  const oc = await getOcct(extensionPath);
  const tmpName = `/ci.${format}`;
  oc.FS.writeFile(tmpName, bytes);

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const baseShape = readShape(oc, tmpName, format, cleanup);
    const shape = applyEditsBRep(oc, baseShape, ops, cleanup);

    const solids = collectSolids(oc, shape, cleanup);
    const byId = new Map(solids.map((s) => [s.id, s.solid]));
    const resolvedA = a.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => s != null);
    const resolvedB = b.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => s != null);
    const unresolvedA = a.filter((id) => !byId.has(id));
    const unresolvedB = b.filter((id) => !byId.has(id));

    if (resolvedA.length === 0 || resolvedB.length === 0) {
      return { hasOverlap: false, overlapVolume: 0, unresolvedA, unresolvedB };
    }

    const shapeA = combineSolids(oc, resolvedA, cleanup);
    const shapeB = combineSolids(oc, resolvedB, cleanup);
    const algo = new oc.BRepAlgoAPI_Common_3(shapeA, shapeB);
    cleanup.push(algo);
    if (!algo.IsDone()) {
      return { hasOverlap: false, overlapVolume: 0, unresolvedA, unresolvedB };
    }
    const result = algo.Shape();
    cleanup.push(result);
    const overlapVolume = volumeOf(oc, result, cleanup);

    // A degenerate (zero-volume) intersection — e.g. two solids that only
    // touch at a face/edge/point — is reported as no real overlap.
    return { hasOverlap: overlapVolume > 1e-9, overlapVolume, unresolvedA, unresolvedB };
  } catch (err) {
    throw wrapOcctFault(err);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try {
        cleanup[i].delete();
      } catch {
        /* ignore */
      }
    }
    try {
      oc.FS.unlink(tmpName);
    } catch {
      /* ignore */
    }
  }
}

export interface InterferencePairResult {
  a: string[];
  b: string[];
  hasOverlap: boolean;
  overlapVolume: number;
  unresolvedA: string[];
  unresolvedB: string[];
  /** True when the pair was rejected by the cheap AABB pre-filter without
   * paying for a real boolean — a fact about HOW the result was derived,
   * not a different answer: two strictly-disjoint bounding boxes can never
   * produce a Common_3 volume. Pairs whose boxes merely touch are NOT
   * screened (they go to the real boolean, which resolves a touching-only
   * pair to `hasOverlap: false` exactly like single-pair
   * {@link checkInterference} does). */
  screenedByBbox?: boolean;
}

/**
 * Assembly-wide sibling of {@link checkInterference} (roadmap item, closed):
 * runs the same exact-boolean-volume test over EVERY pair of the caller's
 * solid-id groups in one call — one parse/replay total, not C(n,2) re-parses.
 *
 * Two independent external projects converged on the same shape this
 * implements, so it is built-in from the start rather than deferred as an
 * optimization: HCAD's assembly-wide clash pass, and SindriCAD's own
 * `interference` op, both run a cheap bounding-box reject before any expensive
 * boolean. Each group's extent is the union of its member solids'
 * `bboxExtent`s (`occtOperations.ts`, exported here for exactly this caller),
 * computed once per solid and cached across groups; a pair whose extents are
 * STRICTLY separated on any axis is reported without a boolean
 * (`screenedByBbox: true`). Touching AABBs are deliberately NOT screened —
 * they go to the real boolean so the touching-vs-overlapping distinction
 * stays exactly as authoritative as the single-pair path.
 *
 * The kernel surface is otherwise byte-identical to {@link checkInterference}:
 * `combineSolids` per operand, `BRepAlgoAPI_Common_3(a, b)` → `.IsDone()` →
 * `.Shape()`, adaptive-volume measurement, the `>1e-9` gate against a
 * degenerate touching intersection, and graceful skip on unresolved ids or a
 * non-converging boolean (never thrown). Cost scales O(n²) booleans worst-case;
 * the pre-filter cuts the real cost to only the geometrically-plausible pairs.
 */
export async function checkInterferenceAll(
  extensionPath: string,
  bytes: Uint8Array,
  format: BRepFormat,
  ops: EditOp[],
  groups: string[][]
): Promise<{ pairs: InterferencePairResult[]; warnings: string[] }> {
  const oc = await getOcct(extensionPath);
  const tmpName = `/cia.${format}`;
  oc.FS.writeFile(tmpName, bytes);

  const cleanup: Array<{ delete(): void }> = [];
  const warnings: string[] = [];
  const pairs: InterferencePairResult[] = [];
  try {
    const baseShape = readShape(oc, tmpName, format, cleanup);
    const shape = applyEditsBRep(oc, baseShape, ops, cleanup);
    const solids = collectSolids(oc, shape, cleanup);
    // NOTE: byId maps id → the RAW solid handle (s.solid), exactly like
    // checkInterference above — `solid` here IS the TopoDS_Shape.
    const byId = new Map(solids.map((s) => [s.id, s.solid]));

    // Resolve every group's ids once; cache each solid's extent so a solid
    // shared by several groups costs one bbox computation total.
    const extentCache = new Map<string, { min: Vec3; max: Vec3 }>();
    const extentOf = (id: string): { min: Vec3; max: Vec3 } | undefined => {
      let ext = extentCache.get(id);
      if (!ext) {
        const solid = byId.get(id);
        if (solid === undefined) return undefined;
        ext = bboxExtent(oc, solid, cleanup);
        extentCache.set(id, ext);
      }
      return ext;
    };

    interface ResolvedGroup {
      ids: string[];
      handles: unknown[];
      unresolved: string[];
      extent: { min: Vec3; max: Vec3 } | null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolved: ResolvedGroup[] = groups.map((group) => {
      const handles: any[] = [];
      const unresolved: string[] = [];
      let min: Vec3 | null = null;
      let max: Vec3 | null = null;
      for (const id of group) {
        const solid = byId.get(id);
        if (solid === undefined) {
          unresolved.push(id);
          continue;
        }
        handles.push(solid);
        const ext = extentOf(id)!;
        if (min === null || max === null) {
          min = [...ext.min];
          max = [...ext.max];
        } else {
          for (let a = 0; a < 3; a++) {
            if (ext.min[a] < min[a]) min[a] = ext.min[a];
            if (ext.max[a] > max[a]) max[a] = ext.max[a];
          }
        }
      }
      if (unresolved.length > 0) {
        warnings.push(`Group [${group.join(", ")}]: unresolved id(s) ${unresolved.join(", ")}.`);
      }
      if (handles.length === 0) {
        warnings.push(
          `Group [${group.join(", ")}] resolved to no solids — all of its pairs report no overlap (same graceful convention as single-pair check_interference).`
        );
        return { ids: [...group], handles, unresolved, extent: null };
      }
      return { ids: [...group], handles, unresolved, extent: { min: min!, max: max! } };
    });

    const strictlyDisjoint = (
      a: { min: Vec3; max: Vec3 },
      b: { min: Vec3; max: Vec3 }
    ): boolean =>
      a.max[0] < b.min[0] || b.max[0] < a.min[0] ||
      a.max[1] < b.min[1] || b.max[1] < a.min[1] ||
      a.max[2] < b.min[2] || b.max[2] < a.min[2];

    for (let i = 0; i < resolved.length; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
        const gi = resolved[i];
        const gj = resolved[j];
        const base = { unresolvedA: gi.unresolved, unresolvedB: gj.unresolved };
        if (gi.extent === null || gj.extent === null) {
          pairs.push({ a: gi.ids, b: gj.ids, hasOverlap: false, overlapVolume: 0, ...base });
          continue;
        }
        if (strictlyDisjoint(gi.extent, gj.extent)) {
          pairs.push({ a: gi.ids, b: gj.ids, hasOverlap: false, overlapVolume: 0, screenedByBbox: true, ...base });
          continue;
        }
        const shapeA = combineSolids(oc, gi.handles, cleanup);
        const shapeB = combineSolids(oc, gj.handles, cleanup);
        const algo = new oc.BRepAlgoAPI_Common_3(shapeA, shapeB);
        cleanup.push(algo);
        if (!algo.IsDone()) {
          pairs.push({ a: gi.ids, b: gj.ids, hasOverlap: false, overlapVolume: 0, ...base });
          continue;
        }
        const resultShape = algo.Shape();
        cleanup.push(resultShape);
        const overlapVolume = volumeOf(oc, resultShape, cleanup);
        pairs.push({
          a: gi.ids,
          b: gj.ids,
          // Same degenerate-touching gate as checkInterference above.
          hasOverlap: overlapVolume > 1e-9,
          overlapVolume,
          ...base,
        });
      }
    }

    return { pairs, warnings };
  } catch (err) {
    throw wrapOcctFault(err);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try {
        cleanup[i].delete();
      } catch {
        /* ignore */
      }
    }
    try {
      oc.FS.unlink(tmpName);
    } catch {
      /* ignore */
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function areaOf(oc: any, handle: any, cleanup: Array<{ delete(): void }>): number {
  const props = new oc.GProp_GProps_1();
  cleanup.push(props);
  surfacePropertiesAdaptive(oc, handle, props);
  return props.Mass();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lengthOf(oc: any, handle: any, cleanup: Array<{ delete(): void }>): number {
  const props = new oc.GProp_GProps_1();
  cleanup.push(props);
  oc.BRepGProp.LinearProperties(handle, props, false, false);
  return props.Mass();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function volumeOf(oc: any, handle: any, cleanup: Array<{ delete(): void }>): number {
  const props = new oc.GProp_GProps_1();
  cleanup.push(props);
  volumePropertiesAdaptive(oc, handle, props);
  return props.Mass();
}

/**
 * Bulk sibling of `resolveEntity` above — instead of resolving ONE caller-
 * given id, enumerates EVERY solid/face/edge/point in `shape` and returns a
 * geometric fingerprint (`EntitySignature`, `entityRebind.ts`) for each, in
 * the SAME deterministic order (`collectSolids`/`collectFaces`/
 * `collectEdges`/`collectVertices`, `occtOperations.ts`) that assigns
 * `solid-N`/`face-N`/`edge-N`/`point-N` ids elsewhere in this codebase — so
 * an index `i` here IS the entity's real id. Feeds `rebindEntities()`
 * (`entityRebind.ts`) for `rebindPartsAcrossOps` below; exported for that
 * function's own unit-free (WASM-required) verification via `npm run
 * mcp:smoke` only, same as every other exported OCCT-touching helper in this
 * file.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectAllEntitySignatures(oc: any, shape: any, cleanup: Array<{ delete(): void }>): EntitySignature[] {
  const out: EntitySignature[] = [];
  for (const { id, solid } of collectSolids(oc, shape, cleanup)) {
    out.push({ id, kind: "solid", centre: bboxCenter(oc, solid, cleanup), measure: volumeOf(oc, solid, cleanup) });
  }
  collectFaces(oc, shape, cleanup).forEach((face, i) => {
    out.push({ id: `face-${i}`, kind: "face", centre: bboxCenter(oc, face, cleanup), measure: areaOf(oc, face, cleanup) });
  });
  collectEdges(oc, shape, cleanup).forEach((edge, i) => {
    out.push({ id: `edge-${i}`, kind: "edge", centre: bboxCenter(oc, edge, cleanup), measure: lengthOf(oc, edge, cleanup) });
  });
  collectVertices(oc, shape, cleanup).forEach((vertex, i) => {
    const pnt = oc.BRep_Tool.Pnt(vertex);
    cleanup.push(pnt);
    out.push({ id: `point-${i}`, kind: "point", centre: [pnt.X(), pnt.Y(), pnt.Z()], measure: 0 });
  });
  return out;
}

export interface RebindStats {
  /** Ops in `newOps` that were actually topology-changing (the only ones this
   * pass runs a shape-diff for — see `TOPOLOGY_CHANGING_OPS`). */
  considered: number;
  /** Part-entity ids that resolved to a DIFFERENT id after an op (a real
   * rebind, not merely "kept the same string"). */
  rebound: number;
  /** Part-entity ids with no confident geometric match after an op — dropped,
   * the same graceful degradation the tolerant sidecar parser already
   * applies to a genuinely-unresolvable id. */
  dropped: number;
}

/**
 * Best-effort entity-id rebinding across an ARBITRARY op-list change —
 * append, `remove_edit_op` at any index, undo, redo, or Clear — closes the
 * "entity-id drift" gap CLAUDE.md documents: a topology-changing op
 * re-tessellates into fresh ids, so a `Part` referencing the old ones used to
 * just lose them. Originally append-only (roadmap "Entity-id drift", first
 * closed); generalized here (roadmap "Extend entity-id rebinding to
 * `remove_edit_op` (and undo/redo)", closed) to handle ANY `oldOps -> newOps`
 * transition, not just a strict-prefix append.
 *
 * **Two strategies, chosen by shape of the change — NOT one uniform
 * algorithm, after a genuine correctness bug was found the hard way against
 * the live WASM.** `oldOps`/`newOps` share a longest common prefix
 * (everything before the first differing op — identical content, nothing to
 * rebind there).
 *
 * - **Pure append** (`oldOps` a strict prefix of `newOps`) or **pure
 *   truncation** (`newOps` a strict prefix of `oldOps` — undo, or Clear
 *   dropping to `[]`): incremental PER-OP stepping, one shape-diff per
 *   topology-changing op, walking forward (append) or backward (truncate)
 *   one op at a time from the common prefix. This is the original
 *   append-only algorithm (and its exact mirror for truncation) — small,
 *   precise geometric deltas at every step, since only ops genuinely being
 *   added or removed from the END of the list are ever involved.
 * - **General change** (anything else — most notably `remove_edit_op`
 *   splicing out of the MIDDLE of the stack, which is neither a pure append
 *   nor a pure truncation): ONE direct whole-shape fingerprint-and-match
 *   between `shape(oldOps)` and `shape(newOps)`, no intermediate steps.
 *   **This is deliberately NOT decomposed into per-op incremental steps —
 *   verified the hard way that doing so is actively WRONG, not just less
 *   precise.** An earlier version tried "unwind `oldOps` down to the common
 *   prefix by popping from the end, then rewind up to `newOps`" (the natural
 *   generalization of the two safe cases above) and it corrupted a real
 *   scenario end-to-end (`npm run mcp:smoke`): removing an EARLIER op
 *   (`addBox`) from `[addBox, addSphere]` while a Part was assigned to the
 *   LATER, entirely-unrelated `addSphere`'s own face. Since `addSphere` sits
 *   at the raw END of `oldOps`, "pop from the end" pops it FIRST — which
 *   means, from the algorithm's narrow per-step view, the sphere doesn't
 *   just move, it **disappears entirely** for the two intermediate steps in
 *   between, and a geometric nearest-neighbor match correctly (from that
 *   narrow view) finds no match for it in a shape where it genuinely isn't
 *   present yet — dropping a Part reference that should never have been
 *   touched at all, since the sphere is identical, unmoved geometry in both
 *   the real `oldOps` and `newOps` shapes. A single direct match between the
 *   two FINAL shapes has no such blind spot: every entity that's actually
 *   unchanged (the common case for anything not near the edit) keeps an
 *   identical fingerprint in both, so nearest-neighbor matches it correctly
 *   regardless of where in the op list the actual change happened to be.
 *   The trade-off accepted for this case: a larger geometric "jump" between
 *   the two shapes than the incremental steps give the safe cases, which
 *   could in principle produce a less confident match right at the entities
 *   the actual change *did* affect — judged the right trade for a
 *   correctness-first MVP over a fancier (and still not obviously complete —
 *   a later op can depend on an earlier removed one's output) common-prefix
 *   *and*-suffix decomposition.
 *
 * Both strategies reuse `collectAllEntitySignatures`/`rebindEntities`/
 * `remapPartEntityIds`; a cheap pre-check (no WASM touched at all) skips the
 * whole function when neither `oldOps` nor `newOps`, from the first
 * differing op onward, contains anything in `TOPOLOGY_CHANGING_OPS` — ids
 * are already stable in that case, so paying for even one shape-diff would
 * be pure waste. Returns the ORIGINAL `parts`/`annotations` arrays (same
 * references) in that case, or when `oldOps`/`newOps` are identical or both
 * `parts` and `annotations` are empty — so callers can cheaply check
 * `result.parts === parts` (and `result.annotations === annotations`) to
 * skip a sidecar write.
 *
 * The match tolerance is `1e-3 * bboxDiagonal(shapeAfter)`, the same
 * tolerance-fraction convention `gmshPartsMap.ts`'s geometric bbox-centre
 * matching and `modelDiff.ts`'s solid matching already established.
 *
 * `annotations` (roadmap "Persisted, topology-anchored annotations", closed)
 * is an OPTIONAL 7th parameter, defaulting to `[]` — it rebinds a persisted
 * `Annotation[]` list through the EXACT SAME shape-diff pass already run for
 * `parts`, reusing the same computed `idMap` at zero extra OCCT cost (an
 * `Annotation` is structurally an `EntityIdBag` too, see its doc comment in
 * `protocol.ts`), rather than requiring a second, independent
 * `readShape`+`applyEditsBRep`+`collectAllEntitySignatures` round trip. Every
 * pre-existing call site is unaffected: omitting the parameter defaults it to
 * `[]`, and `remapPartEntityIds([], idMap)` is a no-op.
 */
export async function rebindPartsAcrossOps(
  extensionPath: string,
  bytes: Uint8Array,
  format: BRepFormat,
  oldOps: EditOp[],
  newOps: EditOp[],
  parts: Part[],
  annotations: Annotation[] = []
): Promise<{ parts: Part[]; annotations: Annotation[]; stats: RebindStats; annotationStats: RebindStats }> {
  const EMPTY_STATS: RebindStats = { considered: 0, rebound: 0, dropped: 0 };
  if (parts.length === 0 && annotations.length === 0) {
    return { parts, annotations, stats: EMPTY_STATS, annotationStats: EMPTY_STATS };
  }

  let prefixLen = 0;
  const minLen = Math.min(oldOps.length, newOps.length);
  while (prefixLen < minLen && JSON.stringify(oldOps[prefixLen]) === JSON.stringify(newOps[prefixLen])) prefixLen++;
  if (prefixLen === oldOps.length && prefixLen === newOps.length) {
    return { parts, annotations, stats: EMPTY_STATS, annotationStats: EMPTY_STATS }; // identical — nothing changed
  }
  const hasTopologyChange = (ops: EditOp[]) => ops.some((op) => TOPOLOGY_CHANGING_OPS.has(op.op));
  if (!hasTopologyChange(oldOps.slice(prefixLen)) && !hasTopologyChange(newOps.slice(prefixLen))) {
    return { parts, annotations, stats: EMPTY_STATS, annotationStats: EMPTY_STATS }; // nothing topology-relevant differs
  }

  const oc = await getOcct(extensionPath);
  const tmpName = `/rb.${format}`;
  oc.FS.writeFile(tmpName, bytes);

  let currentParts = parts;
  let currentAnnotations = annotations;
  const stats: RebindStats = { considered: 0, rebound: 0, dropped: 0 };
  const annotationStats: RebindStats = { considered: 0, rebound: 0, dropped: 0 };

  /** One diff-and-remap step between two shapes' full op-lists — `from`
   * is where `currentParts` is currently valid, `to` is where they should
   * end up. Fingerprints both fully via `collectAllEntitySignatures` and
   * does one `rebindEntities` match; the caller decides when this is safe
   * to call (see the strategy split in the doc comment above). */
  const diffAndRemap = async (from: EditOp[], to: EditOp[]): Promise<void> => {
    const cleanupFrom: Array<{ delete(): void }> = [];
    const cleanupTo: Array<{ delete(): void }> = [];
    try {
      const shapeFrom = applyEditsBRep(oc, readShape(oc, tmpName, format, cleanupFrom), from, cleanupFrom);
      const oldSigs = collectAllEntitySignatures(oc, shapeFrom, cleanupFrom);

      const shapeTo = applyEditsBRep(oc, readShape(oc, tmpName, format, cleanupTo), to, cleanupTo);
      const newSigs = collectAllEntitySignatures(oc, shapeTo, cleanupTo);

      const toleranceAbs = Math.max(1e-3 * bboxDiagonal(oc, shapeTo, cleanupTo), 1e-6);
      const idMap = new Map(rebindEntities(oldSigs, newSigs, toleranceAbs).map((m) => [m.oldId, m.newId]));

      // Skip an empty list entirely rather than calling remapPartEntityIds([],
      // idMap) — `[].map()` always returns a NEW array, which would flip the
      // caller-visible reference-equality check (`result.parts === parts`)
      // to "changed" even though there was truly nothing to remap, causing a
      // spurious empty-sidecar write.
      if (currentParts.length > 0) {
        const result = remapPartEntityIds(currentParts, idMap);
        currentParts = result.parts;
        stats.rebound += result.reboundCount;
        stats.dropped += result.droppedCount;
      }
      stats.considered++;

      if (currentAnnotations.length > 0) {
        const annResult = remapPartEntityIds(currentAnnotations, idMap);
        currentAnnotations = annResult.parts;
        annotationStats.rebound += annResult.reboundCount;
        annotationStats.dropped += annResult.droppedCount;
      }
      annotationStats.considered++;
    } finally {
      for (let i = cleanupTo.length - 1; i >= 0; i--) {
        try {
          cleanupTo[i].delete();
        } catch {
          /* ignore */
        }
      }
      for (let i = cleanupFrom.length - 1; i >= 0; i--) {
        try {
          cleanupFrom[i].delete();
        } catch {
          /* ignore */
        }
      }
    }
  };

  /** Per-op-boundary version of `diffAndRemap`, for the incremental
   * strategies below — skips the expensive work entirely when the ONE op
   * that differs between `from`/`to` isn't topology-changing. */
  const step = async (from: EditOp[], to: EditOp[]): Promise<void> => {
    const changedOp = from.length > to.length ? from[from.length - 1] : to[to.length - 1];
    if (!TOPOLOGY_CHANGING_OPS.has(changedOp.op)) return;
    await diffAndRemap(from, to);
  };

  try {
    if (prefixLen === oldOps.length) {
      // Pure append: oldOps is a strict prefix of newOps.
      let cumulative = oldOps;
      for (let i = prefixLen; i < newOps.length; i++) {
        const longer = newOps.slice(0, i + 1);
        await step(cumulative, longer);
        cumulative = longer;
      }
    } else if (prefixLen === newOps.length) {
      // Pure truncation (undo, or Clear): newOps is a strict prefix of oldOps.
      let cumulative = oldOps;
      for (let i = oldOps.length; i > prefixLen; i--) {
        const shorter = oldOps.slice(0, i - 1);
        await step(cumulative, shorter);
        cumulative = shorter;
      }
    } else {
      // General change (e.g. remove_edit_op from the middle) — see doc
      // comment for why this is a single direct match, not incremental steps.
      await diffAndRemap(oldOps, newOps);
    }
  } catch (err) {
    throw wrapOcctFault(err);
  } finally {
    try {
      oc.FS.unlink(tmpName);
    } catch {
      /* ignore */
    }
  }

  return { parts: currentParts, annotations: currentAnnotations, stats, annotationStats };
}

export interface BucketSelectorResult {
  /** Current-model `face-N` ids the bucket query resolves to (may be empty —
   * after the rung-2 induced layer narrows the set, or when nothing matched). */
  ids: string[];
  /** Reference (step-local) ids with no confident match in the current shape. */
  unresolved: string[];
  /** Geometric matches behind `ids` — centre distance + measure delta per pair,
   * the same oracle shape `rebindPartsAcrossOps` already reports. A resolved id
   * is trustworthy only with a ~0 `centreDistance`, exactly as the closed
   * entity-rebinding work verifies itself in `npm run mcp:smoke`. Filtered to
   * the surviving ids when the rung-2 induced layer narrows the set, so the
   * oracle always describes exactly what `ids` holds. */
  matches: EntityRebindMatch[];
  /** `false` when rung 1 cannot name the pick (pattern-instance producer) —
   * routed to a future scene-wide predicate rung, never a guessed instance. */
  bindable: boolean;
  reason?: string;
}

/**
 * Bulk exact face facts for the rung-2 induced layer — one `collectFaces`
 * pass plus a `faceSurfaceInfo` + adaptive-area read per requested id, inside
 * the caller's own cleanup arrays (same discipline as every other reader in
 * this file). Only the ids the bucket match already resolved are ever read,
 * so this adds per-candidate adaptor reads to the two replays rung 1 already
 * pays — never a new replay. An id that no longer indexes a live face is
 * skipped (the match already reported it via `unresolved` when it never
 * matched at all; a face lost between the match and this read degrades to
 * absence, never a fabricated fact).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function faceFilterableFacts(
  oc: any,
  shape: any,
  ids: string[],
  cleanup: Array<{ delete(): void }>
): FilterableFace[] {
  const faces = collectFaces(oc, shape, cleanup);
  const out: FilterableFace[] = [];
  for (const id of ids) {
    const m = /^face-(\d+)$/.exec(id);
    if (!m) continue;
    const face = faces[parseInt(m[1], 10)];
    if (!face) continue;
    const info = faceSurfaceInfo(oc, face, cleanup);
    const props = new oc.GProp_GProps_1();
    cleanup.push(props);
    surfacePropertiesAdaptive(oc, face, props);
    out.push({
      id,
      area: props.Mass(),
      surfaceType: info.type,
      normal: info.params?.kind === "plane" ? info.params.normal : null,
    });
  }
  return out;
}

/**
 * Re-executable whole-bucket selector — roadmap item 1 ("Selector synthesis"),
 * ladder rungs 1–2. Resolves `{version: 1, source: {kind: "bucket", op, role}}`
 * ("the faces op N produced in role R") against the CURRENT `ops` list, so a
 * recorded `OpBucket`'s step-local ids never need to be trusted against a
 * newer shape; an optional rung-2 `filter`/`rank` narrows that set by exact
 * current-shape facts ("op 3's `endCap` face with the largest area").
 *
 * Mechanism: replay the prefix `ops[0..op]` with an `opBuckets` collector to
 * re-derive the reference ids (never trusting caller-supplied ids), fingerprint
 * that prefix shape, replay the full list, and match the reference subset via
 * `rebindEntities` at the shared `1e-3 * bboxDiagonal` tolerance — the same
 * match `rebindPartsAcrossOps` uses, at zero new matching code. The returned
 * `matches` ARE the oracle: each carries `centreDistance`/`measureDeltaPct`,
 * so a caller verifies "the SAME entity" by comparing geometry, not by
 * trusting the resolution.
 *
 * Ordering is load-bearing: the induced layer filters on CURRENT-shape facts
 * read AFTER the match (rank after resolve), never on prefix-shape facts —
 * the cheaper filter-then-match order would let a dimension edit between the
 * prefix and current states silently promote a face that only matched the old
 * geometry. An induced selection of zero is an honest `ids: []` (the
 * skip-producer precedent), never a fallback to the whole bucket.
 *
 * A producing op that gracefully skipped records no bucket (honest empty,
 * never a fabricated match); a pattern-instance producer is refused via
 * `bindable: false` (the roadmap's bindability gate — a name would be
 * ambiguous across instances). Malformed queries and out-of-range op indices
 * throw (caller-input-shape misuse, failing fast like every other tool).
 */
export async function resolveBucketSelector(
  extensionPath: string,
  bytes: Uint8Array,
  format: BRepFormat,
  ops: EditOp[],
  queryRaw: unknown
): Promise<BucketSelectorResult> {
  const query: SelectorQuery | null = validateSelectorQuery(queryRaw);
  if (!query) {
    throw new Error(
      'Invalid selector query — expected {version: 1, source: {kind: "bucket", op: <op index>, role: <role>}}.'
    );
  }
  const opIndex = query.source.op;
  if (opIndex >= ops.length) {
    throw new Error(`Selector query op ${opIndex} is out of range (op list has ${ops.length} ops).`);
  }
  if (!isBindableSelector(ops, query)) {
    return {
      ids: [],
      unresolved: [],
      matches: [],
      bindable: false,
      reason: `Producing op ${opIndex} (${ops[opIndex].op}) is a pattern instance — ambiguous across instances, routed to a future scene-wide predicate rung.`,
    };
  }

  const oc = await getOcct(extensionPath);
  const tmpName = `/bs.${format}`;
  oc.FS.writeFile(tmpName, bytes);

  const cleanupPrefix: Array<{ delete(): void }> = [];
  const cleanupFull: Array<{ delete(): void }> = [];
  try {
    const prefixOps = ops.slice(0, opIndex + 1);
    const prefixBuckets: OpBucket[] = [];
    const prefixShape = applyEditsBRep(
      oc,
      readShape(oc, tmpName, format, cleanupPrefix),
      prefixOps,
      cleanupPrefix,
      undefined,
      undefined,
      prefixBuckets
    );
    const prefixSigs = collectAllEntitySignatures(oc, prefixShape, cleanupPrefix).filter((s) => s.kind === "face");
    const refIds = bucketReferenceIds(prefixBuckets, query);
    if (refIds.length === 0) {
      return { ids: [], unresolved: [], matches: [], bindable: true };
    }
    const refSet = new Set(refIds);
    const refSigs = prefixSigs.filter((s) => refSet.has(s.id));

    const fullShape = applyEditsBRep(oc, readShape(oc, tmpName, format, cleanupFull), ops, cleanupFull);
    const fullSigs = collectAllEntitySignatures(oc, fullShape, cleanupFull).filter((s) => s.kind === "face");

    const toleranceAbs = Math.max(1e-3 * bboxDiagonal(oc, fullShape, cleanupFull), 1e-6);
    const matches = rebindEntities(refSigs, fullSigs, toleranceAbs);
    const matchedOld = new Set(matches.map((m) => m.oldId));
    const unresolved = refIds.filter((id) => !matchedOld.has(id));

    // Rung-2 induced layer (resolve-then-filter — see the doc comment above
    // for why the cheaper reverse order would be wrong). No layer present is
    // the rung-1 path exactly: every matched id survives with its oracle.
    const { filter, rank } = query.source;
    if (filter === undefined && rank === undefined) {
      return { ids: matches.map((m) => m.newId), unresolved, matches, bindable: true };
    }
    const facts = faceFilterableFacts(
      oc,
      fullShape,
      matches.map((m) => m.newId),
      cleanupFull
    );
    const byId = new Map(facts.map((f) => [f.id, f]));
    // A resolved id with no readable fact (lost between match and read)
    // degrades to absence — the same direction as every other graceful skip
    // in this file, never a fabricated predicate evaluation.
    let survivors = matches.filter((m) => byId.has(m.newId));
    if (filter !== undefined) {
      survivors = survivors.filter((m) => {
        const f = byId.get(m.newId);
        return f !== undefined && matchesFacePredicate(f, filter);
      });
    }
    if (rank !== undefined) {
      const ranked = rankFaces(
        survivors.map((m) => byId.get(m.newId)).filter((f): f is FilterableFace => f !== undefined),
        rank
      );
      const kept = new Set(ranked.map((f) => f.id));
      survivors = survivors.filter((m) => kept.has(m.newId));
    }
    return {
      ids: survivors.map((m) => m.newId),
      unresolved,
      matches: survivors,
      bindable: true,
    };
  } catch (err) {
    throw wrapOcctFault(err);
  } finally {
    for (let i = cleanupFull.length - 1; i >= 0; i--) {
      try {
        cleanupFull[i].delete();
      } catch {
        /* ignore */
      }
    }
    for (let i = cleanupPrefix.length - 1; i >= 0; i--) {
      try {
        cleanupPrefix[i].delete();
      } catch {
        /* ignore */
      }
    }
    try {
      oc.FS.unlink(tmpName);
    } catch {
      /* ignore */
    }
  }
}
