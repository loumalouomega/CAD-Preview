import { getOcct, readShape } from "./occtService";
import { applyEditsBRep, collectSolids, collectFaces, collectEdges, collectVertices, bboxCenter, facePlane } from "./occtOperations";
import type { CadFormat } from "./fileRouter";
import type { EditOp, Vec3 } from "./editOps";

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
  /** Set only for a face. */
  surfaceType: SurfaceType | null;
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
    let surfaceType: SurfaceType | null = null;

    if (kind === "solid" || kind === "face") {
      const props = new oc.GProp_GProps_1();
      cleanup.push(props);
      oc.BRepGProp.SurfaceProperties_1(handle, props, false, false);
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
      const surf = new oc.BRepAdaptor_Surface_2(handle, true);
      cleanup.push(surf);
      surfaceType = SURFACE_TYPE_BY_VALUE[surf.GetType().value] ?? "other";
    }

    return { entityId, kind, bbox, center, area, length, normal, surfaceType };
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
