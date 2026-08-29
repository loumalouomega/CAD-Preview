/**
 * Per-solid primitive recognition report (roadmap item 8 Phase 2).
 *
 * **Facts only — this emits no ops and reclassifies nothing.** Per solid it
 * reports the face inventory by surface type, a candidate primitive when the
 * inventory matches a signature exactly, and the **fit residual**: how far the
 * solid's own boundary actually strays from that idealized primitive. The
 * residual is what keeps a candidate a hypothesis rather than a verdict — the
 * same discipline `checkMeshHealth` applies with `requiredTolerance` and
 * `compare_models` with `centreDistance`/`volumeDeltaPct`, and for the same
 * reason: a mis-recognized primitive that silently replaced real geometry
 * would feed `get_mass_properties`/`measure_exact` confidently-wrong numbers.
 *
 * **Why the residual is sampled here rather than asked of OCCT.** This build
 * has no maximum-distance query at all (`BRepExtrema_DistanceSS` constructs but
 * never computes; `Extrema_ExtFlag_MAX` is accepted then ignored — both
 * recorded in `entityFacts.ts`). And a per-FACE residual would be worthless
 * even if it existed: a face that genuinely is a `Geom_CylindricalSurface` has
 * its tessellation nodes on that cylinder by construction, so it would read ~0
 * always. Measuring the whole boundary against the idealized primitive is what
 * catches "a cylinder, but with a chamfered rim".
 */

import { getOcct, readShape } from "./occtService";
import { applyEditsBRep, collectSolids, bboxDiagonal, faceSurfaceInfo } from "./occtOperations";
import { tessellateByGroup } from "./meshExtract";
import type { BRepFormat, SurfaceType } from "./entityFacts";
import type { EditOp } from "./editOps";
import { recognizePrimitive, inventoryOf, type FaceEntry } from "./primitiveRecognition";
import { maxDeviation, type Primitive, type Vec3 } from "./primitiveSdf";

export interface SolidRecognition {
  solidId: string;
  faceCount: number;
  /** Face counts by surface type. Useful on its own even with no candidate. */
  inventory: Record<SurfaceType, number>;
  /** `null` when no signature matched exactly — never a guess. */
  candidate: Primitive | null;
  /**
   * Largest deviation between the solid's tessellated boundary and
   * `candidate`, in the file's own units. `null` when there is no candidate,
   * or when the deviation could not be computed — never `0`, which would read
   * as a perfect fit.
   *
   * **It has a noise floor, and a caller comparing residuals needs to know
   * why.** The sampled points come from the tessellation's `Float32Array`
   * buffers, whose precision is relative to COORDINATE MAGNITUDE, not to the
   * solid's size — so a genuinely exact primitive sitting far from the origin
   * still reports a small non-zero residual (measured: ~1.2e-5 for an exact
   * box about 1000 units out). Compare `fitResidualFrac`, or compare against
   * the size of the feature you care about, rather than against zero.
   */
  fitResidual: number | null;
  /**
   * `fitResidual` as a fraction of the solid's bbox diagonal — scale-free, so
   * one threshold reads the same on a 2 mm bracket and a 40 m assembly.
   */
  fitResidualFrac: number | null;
}

export interface PrimitiveReport {
  solidCount: number;
  solids: SolidRecognition[];
}

/**
 * Reads every solid's faces, classifies each, and measures the fit.
 *
 * One parse/replay for the whole model, like every other read-side entry point
 * here (`computeBom`, `getEntityFacts`, `checkInterference`).
 */
export async function recognizePrimitives(
  extensionPath: string,
  bytes: Uint8Array,
  format: BRepFormat,
  ops: EditOp[]
): Promise<PrimitiveReport> {
  const oc = await getOcct(extensionPath);
  const tmpName = `/rec.${format}`;
  oc.FS.writeFile(tmpName, bytes);

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const baseShape = readShape(oc, tmpName, format, cleanup);
    const shape = applyEditsBRep(oc, baseShape, ops, cleanup);
    const solids = collectSolids(oc, shape, cleanup);

    // Boundary points per solid, for the residual. `tessellateByGroup` already
    // produces exactly this grouping (one entry per solid, faces within), and
    // is the same tessellation the viewer and `loadBRep` use — so the sampled
    // points are the real displayed boundary, not a second approximation.
    //
    // NOTE its trailing free-face group is labelled `solid-N` for an N that
    // `collectSolids` never produces (those faces belong to no solid), so this
    // is keyed by INDEX over the real solids only and the extra group is
    // simply never looked up.
    const groups = tessellateByGroup(oc, shape);

    const out: SolidRecognition[] = [];
    for (let i = 0; i < solids.length; i++) {
      const { id, solid } = solids[i];
      const faces = facesOfSolid(oc, solid, cleanup);
      const inventory = inventoryOf(faces);
      const candidate = recognizePrimitive(faces);

      let fitResidual: number | null = null;
      let fitResidualFrac: number | null = null;
      if (candidate) {
        const points = pointsOfGroup(groups[i]);
        fitResidual = maxDeviation(points, candidate);
        if (fitResidual !== null) {
          const diag = bboxDiagonal(oc, solid, cleanup);
          fitResidualFrac = diag > 1e-12 ? fitResidual / diag : null;
        }
      }

      out.push({ solidId: id, faceCount: faces.length, inventory, candidate, fitResidual, fitResidualFrac });
    }
    return { solidCount: out.length, solids: out };
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try {
        cleanup[i].delete();
      } catch {
        /* already freed */
      }
    }
    try {
      oc.FS.unlink(tmpName);
    } catch {
      /* best effort */
    }
  }
}

/**
 * This solid's OWN faces, classified.
 *
 * Explores the solid handle directly rather than indexing the global
 * `collectFaces` list: that list is contiguous per solid but discards which
 * solid contributed which, and re-deriving the split by index arithmetic would
 * silently break the first time a free face appeared. The face ids here are
 * therefore LOCAL (`local-N`) — the report keys on the solid, and a caller
 * wanting a global `face-N` uses `inspect`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function facesOfSolid(oc: any, solid: any, cleanup: Array<{ delete(): void }>): FaceEntry[] {
  const out: FaceEntry[] = [];
  const exp = new oc.TopExp_Explorer_2(solid, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  cleanup.push(exp);
  let i = 0;
  while (exp.More()) {
    const face = oc.TopoDS.Face_1(exp.Current());
    cleanup.push(face);
    const info = faceSurfaceInfo(oc, face, cleanup);
    out.push({ faceId: `local-${i}`, surfaceType: info.type, params: info.params });
    i += 1;
    exp.Next();
  }
  return out;
}

/** Every tessellation vertex of one solid group, as world-space points. */
function pointsOfGroup(group: { faces: { buffers: { positions: Float32Array } }[] } | undefined): Vec3[] {
  if (!group) return [];
  const out: Vec3[] = [];
  for (const f of group.faces) {
    const p = f.buffers.positions;
    for (let i = 0; i + 2 < p.length; i += 3) out.push([p[i], p[i + 1], p[i + 2]]);
  }
  return out;
}
