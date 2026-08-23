import { getOcct, readShape, wrapOcctFault } from "./occtService";
import { applyEditsBRep, collectSolids, collectFaces, collectEdges } from "./occtOperations";
import { volumePropertiesAdaptive, surfacePropertiesAdaptive } from "./brepGProp";
import type { CadFormat } from "./fileRouter";
import type { EditOp } from "./editOps";

export type BRepFormat = Extract<CadFormat, "step" | "iges" | "brep">;

export interface MomentsOfInertia {
  ixx: number;
  iyy: number;
  izz: number;
  ixy: number;
  ixz: number;
  iyz: number;
}

export interface MassProperties {
  /** Only set for the whole model or a `solid-N` (guaranteed closed by
   * `collectSolids`'s `TopAbs_SOLID` explorer) — `BRepGProp.VolumeProperties`
   * returns a plausible-looking but WRONG number for an open shell/face, so
   * volume is never attempted for `face-N`/`edge-N` (see `occtOperations.ts`'s
   * sewing-verification comment for the same trap). */
  volume: number | null;
  /** Set for the whole model, a `solid-N` (boundary area), or a `face-N`. */
  area: number | null;
  /** Set only for a single `edge-N`. */
  length: number | null;
  centerOfMass: [number, number, number] | null;
  /** About the center of mass (verified against the live WASM on a known box —
   * NOT about the origin, despite `GProp_GProps` taking no explicit reference
   * point). */
  momentsOfInertia: MomentsOfInertia | null;
}

/**
 * Volume/area/length + center-of-mass + moments-of-inertia for the whole
 * model or one entity (`solid-N` / `face-N` / `edge-N`), via OCCT `BRepGProp`.
 * Re-parses `bytes` and replays `ops` fresh on every call, exactly like every
 * other B-rep read path in this codebase (`loadBRep`, `exportBRep`) — there is
 * no shape/session cache anywhere in this extension.
 *
 * **OCCT `BRepGProp` API, verified against the live WASM** (brute-force
 * overload/arg-count probing, same convention as every other OCCT call in
 * this codebase — see CLAUDE.md): `new oc.GProp_GProps_1()` (the *only*
 * accessible constructor — the unsuffixed `GProp_GProps` has none) →
 * volume/surface integration goes through `src/brepGProp.ts`'s ADAPTIVE
 * (`eps`-driven) wrappers — `VolumeProperties2(shape, props, eps,
 * onlyClosed, skipShared)` / `SurfaceProperties2(shape, props, eps,
 * skipShared)`, the embind-renamed variants stock opencascade.js exposes
 * because the plain-overload names collide on `Standard_Real Eps` — NOT the
 * fixed-order `_1` forms, which under-integrate B-spline-trimmed faces (see
 * `brepGProp.ts`'s doc comment for the measured numbers). The 2×3×4 box
 * still integrates to exactly 24 either way. →
 * `oc.BRepGProp.LinearProperties(shape, props, skipShared, ?)`
 * (**unsuffixed**, but still needs exactly 4 args in this binding; verified
 * against a single edge, NOT the whole shape — `LinearProperties` over an
 * entire B-rep shape double-counts every edge shared by two faces, so it must
 * only ever be called on a single already-resolved `TopoDS_Edge`, matching
 * how `collectEdges` is used here). `props.Mass()` is volume/area/length
 * depending which `*Properties` call populated it; `props.CentreOfMass()`
 * returns a `gp_Pnt`-like handle (`.X()/.Y()/.Z()`, needs `.delete()`);
 * `props.MatrixOfInertia()` returns a `gp_Mat`-like handle (`.Value(r, c)`,
 * 1-based, needs `.delete()`) — verified numerically equal to the standard
 * box inertia formula computed about the CENTROID (e.g. `Ixx = 50` for the
 * same 2×3×4 box, matching `(1/12)·24·(3²+4²)`), not about the origin.
 */
export async function computeMassProperties(
  extensionPath: string,
  bytes: Uint8Array,
  format: BRepFormat,
  ops: EditOp[],
  entityId: string | null
): Promise<MassProperties> {
  const oc = await getOcct(extensionPath);
  const tmpName = `/mp.${format}`;
  oc.FS.writeFile(tmpName, bytes);

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const baseShape = readShape(oc, tmpName, format, cleanup);
    const shape = applyEditsBRep(oc, baseShape, ops, cleanup);

    if (entityId === null) {
      return solidProperties(oc, shape, cleanup);
    }

    const solidMatch = /^solid-(\d+)$/.exec(entityId);
    if (solidMatch) {
      const solids = collectSolids(oc, shape, cleanup);
      const s = solids[Number(solidMatch[1])];
      if (!s) throw new Error(`Unknown entity id: ${entityId}`);
      return solidProperties(oc, s.solid, cleanup);
    }

    const faceMatch = /^face-(\d+)$/.exec(entityId);
    if (faceMatch) {
      const faces = collectFaces(oc, shape, cleanup);
      const f = faces[Number(faceMatch[1])];
      if (!f) throw new Error(`Unknown entity id: ${entityId}`);
      return surfaceProperties(oc, f, cleanup);
    }

    const edgeMatch = /^edge-(\d+)$/.exec(entityId);
    if (edgeMatch) {
      const edges = collectEdges(oc, shape, cleanup);
      const e = edges[Number(edgeMatch[1])];
      if (!e) throw new Error(`Unknown entity id: ${entityId}`);
      return linearPropertiesOf(oc, e, cleanup);
    }

    if (/^point-\d+$/.test(entityId)) {
      throw new Error("Points have no mass properties.");
    }
    throw new Error(`Unsupported entity id for mass properties: ${entityId}`);
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

/** Reads `CentreOfMass()`/`MatrixOfInertia()` off an already-computed `GProp_GProps`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readCenterAndInertia(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: any,
  cleanup: Array<{ delete(): void }>
): { centerOfMass: [number, number, number]; momentsOfInertia: MomentsOfInertia } {
  const com = props.CentreOfMass();
  cleanup.push(com);
  const centerOfMass: [number, number, number] = [com.X(), com.Y(), com.Z()];

  const mat = props.MatrixOfInertia();
  cleanup.push(mat);
  const momentsOfInertia: MomentsOfInertia = {
    ixx: mat.Value(1, 1),
    iyy: mat.Value(2, 2),
    izz: mat.Value(3, 3),
    ixy: mat.Value(1, 2),
    ixz: mat.Value(1, 3),
    iyz: mat.Value(2, 3),
  };
  return { centerOfMass, momentsOfInertia };
}

/** Volume + boundary area (a solid always has both) + mass-based CoG/inertia. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function solidProperties(oc: any, shape: any, cleanup: Array<{ delete(): void }>): MassProperties {
  const vprops = new oc.GProp_GProps_1();
  cleanup.push(vprops);
  volumePropertiesAdaptive(oc, shape, vprops);
  const volume = vprops.Mass();
  const { centerOfMass, momentsOfInertia } = readCenterAndInertia(vprops, cleanup);

  const sprops = new oc.GProp_GProps_1();
  cleanup.push(sprops);
  surfacePropertiesAdaptive(oc, shape, sprops);
  const area = sprops.Mass();

  return { volume, area, length: null, centerOfMass, momentsOfInertia };
}

/** Area + area-based CoG/inertia for a single face. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function surfaceProperties(oc: any, face: any, cleanup: Array<{ delete(): void }>): MassProperties {
  const props = new oc.GProp_GProps_1();
  cleanup.push(props);
  surfacePropertiesAdaptive(oc, face, props);
  const area = props.Mass();
  const { centerOfMass, momentsOfInertia } = readCenterAndInertia(props, cleanup);
  return { volume: null, area, length: null, centerOfMass, momentsOfInertia };
}

/** Length + line-based CoG/inertia for a single edge. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function linearPropertiesOf(oc: any, edge: any, cleanup: Array<{ delete(): void }>): MassProperties {
  const props = new oc.GProp_GProps_1();
  cleanup.push(props);
  oc.BRepGProp.LinearProperties(edge, props, false, false);
  const length = props.Mass();
  const { centerOfMass, momentsOfInertia } = readCenterAndInertia(props, cleanup);
  return { volume: null, area: null, length, centerOfMass, momentsOfInertia };
}
