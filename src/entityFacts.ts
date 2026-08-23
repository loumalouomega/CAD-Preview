import { getOcct, readShape, wrapOcctFault } from "./occtService";
import {
  applyEditsBRep,
  collectSolids,
  collectFaces,
  collectEdges,
  collectVertices,
  bboxCenter,
  bboxDiagonal,
  facePlane,
  combineSolids,
} from "./occtOperations";
import { rebindEntities, remapPartEntityIds, type EntitySignature } from "./entityRebind";
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

const SURFACE_TYPE_BY_VALUE: Record<number, SurfaceType> = {
  0: "plane",
  1: "cylinder",
  2: "cone",
  3: "sphere",
  4: "torus",
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
}

export type ExactMeasureKind = "distance" | "edgeLength" | "radius";

export interface ExactMeasureResult {
  kind: ExactMeasureKind;
  value: number;
  /** Set only for `kind: "distance"` — the actual nearest points OCCT found
   * on each shape (not necessarily either entity's centre or an endpoint). */
  fromPoint?: Vec3;
  toPoint?: Vec3;
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
    }

    if (kind === "face") {
      const plane = facePlane(oc, handle, cleanup);
      normal = plane?.nl ?? null;
      planeOrigin = plane?.pt ?? null;
      const surf = new oc.BRepAdaptor_Surface_2(handle, true);
      cleanup.push(surf);
      surfaceType = SURFACE_TYPE_BY_VALUE[surf.GetType().value] ?? "other";
    }

    return { entityId, kind, bbox, center, area, length, normal, planeOrigin, surfaceType };
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
      return {
        kind,
        value: dist.Value(),
        fromPoint: [p1.X(), p1.Y(), p1.Z()],
        toPoint: [p2.X(), p2.Y(), p2.Z()],
      };
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
