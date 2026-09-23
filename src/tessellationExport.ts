/**
 * Mesh-aware surface tessellation export — the kernel half (roadmap
 * "Mesh-aware surface tessellation export"). Tessellates the EDITED B-rep at
 * a chordal tolerance derived from the downstream cell size
 * (`tessellationTolerance.ts`), writes a binary STL, and MEASURES the
 * achieved chordal error by sampling the tessellation against the exact
 * OCCT faces.
 *
 * What the measurement is, stated plainly: points on sampled triangles
 * (centroid and edge midpoints — where a chord deviates most from a curved
 * surface) → `BRepExtrema_DistShapeShape` to the triangle's OWN face. It is
 * a sampled estimate, not a certified maximum: an unsampled triangle can
 * deviate more. The sample budget and the sampled triangle count are
 * reported beside the numbers so a reader can judge coverage.
 *
 * The viewport's own tessellation is never touched — this re-meshes a
 * private copy of the shape per call (the stateless-per-call discipline
 * every export here follows).
 */
import { getOcct, readShape, wrapOcctFault } from "./occtService";
import { applyEditsBRep, collectFaces } from "./occtOperations";
import { tessellateByGroup } from "./meshExtract";
import { weldTriangleSoup } from "./meshComponents";
import {
  DEFAULT_MAX_TRIANGLES,
  deriveTessellation,
  percentile,
  weldedMeshToBinaryStl,
  type TessellationExportRequest,
} from "./tessellationTolerance";
import type { EditOp } from "./editOps";
import type { DisplayUnit } from "./lengthUnits";

export interface TessellationExportOptions extends TessellationExportRequest {
  /** Refuse (throw) above this many triangles, before writing anything. */
  maxTriangles?: number;
  /** Maximum chordal-error sample points (0 disables measurement). Default 1200. */
  sampleBudget?: number;
  /** Count triangles only: no STL bytes, no measurement. */
  dryRun?: boolean;
}

export interface TessellationExportResult {
  /** Binary STL bytes (null for a dry run). */
  stl: Uint8Array | null;
  triangleCount: number;
  unit: DisplayUnit;
  /** The requested chordal tolerance in `unit`. */
  requestedChordal: number;
  linearDeflectionMm: number;
  angularDeg: number;
  /** Sampled chordal error in `unit`; null when not measured. */
  measured: {
    max: number;
    p95: number;
    mean: number;
    samples: number;
    sampledTriangles: number;
    exceedingRequested: number;
  } | null;
  warnings: string[];
}

export async function exportTessellatedStl(
  extensionPath: string,
  bytes: Uint8Array,
  format: "step" | "iges" | "brep" | "csg",
  ops: EditOp[],
  options: TessellationExportOptions
): Promise<TessellationExportResult> {
  const derived = deriveTessellation(options);
  const maxTriangles = options.maxTriangles ?? DEFAULT_MAX_TRIANGLES;
  const budget = Math.max(0, Math.floor(options.sampleBudget ?? 1200));
  const warnings: string[] = [];
  const oc = await getOcct(extensionPath);
  // Short MEMFS path — this OCCT build silently corrupts at ~11+ characters.
  const tmp = `/te.${format}`;
  oc.FS.writeFile(tmp, bytes);
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const base = readShape(oc, tmp, format, cleanup);
    const shape = applyEditsBRep(oc, base, ops, cleanup);
    const groups = tessellateByGroup(oc, shape, {
      linearDeflection: derived.linearDeflectionMm,
      angularDeflectionRad: derived.angularDeflectionRad,
    });
    let triangleCount = 0;
    for (const g of groups) for (const f of g.faces) triangleCount += Math.floor(f.buffers.indices.length / 3);
    if (triangleCount > maxTriangles) {
      throw new Error(
        `The requested tolerance produces ${triangleCount.toLocaleString("en-US")} triangles, above the ${maxTriangles.toLocaleString("en-US")} limit — raise targetCellSize or chordalFraction (or maxTriangles).`
      );
    }
    if (triangleCount === 0) warnings.push("The model has no faces to tessellate — the STL is empty.");
    const base2 = {
      triangleCount,
      unit: derived.unit,
      requestedChordal: derived.requestedChordal,
      linearDeflectionMm: derived.linearDeflectionMm,
      angularDeg: (derived.angularDeflectionRad * 180) / Math.PI,
    };
    if (options.dryRun) return { ...base2, stl: null, measured: null, warnings };

    const soup = new Float32Array(triangleCount * 9);
    let o = 0;
    for (const g of groups)
      for (const f of g.faces) {
        const { positions, indices } = f.buffers;
        for (let i = 0; i < indices.length; i++) {
          const v = indices[i] * 3;
          soup[o++] = positions[v];
          soup[o++] = positions[v + 1];
          soup[o++] = positions[v + 2];
        }
      }
    const stl = weldedMeshToBinaryStl(weldTriangleSoup(soup), derived.scale);

    let measured: TessellationExportResult["measured"] = null;
    if (budget > 0 && triangleCount > 0) {
      measured = sampleChordalError(oc, shape, groups, budget, derived.scale, derived.requestedChordal, cleanup);
      if (measured.exceedingRequested > 0) {
        warnings.push(
          `${measured.exceedingRequested} of ${measured.samples} sample point(s) deviate more than the requested ${derived.requestedChordal.toPrecision(3)} ${derived.unit} — OCCT's mesher treats the deflection as a target, not a guarantee.`
        );
      }
    }
    return { ...base2, stl, measured, warnings };
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
      oc.FS.unlink(tmp);
    } catch {
      /* ignore */
    }
  }
}

function sampleChordalError(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oc: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shape: any,
  groups: ReturnType<typeof tessellateByGroup>,
  budget: number,
  scale: number,
  requested: number,
  cleanup: Array<{ delete(): void }>
): NonNullable<TessellationExportResult["measured"]> {
  // `face-N` numbering in tessellateByGroup and collectFaces is the same
  // global order (the invariant every face-N operand depends on).
  const faces = collectFaces(oc, shape, cleanup);
  const faceTris: Array<{ face: number; positions: Float32Array; indices: Uint32Array; tri: number }> = [];
  for (const g of groups)
    for (const f of g.faces) {
      const n = Number(f.faceId.slice(5));
      const tris = Math.floor(f.buffers.indices.length / 3);
      for (let t = 0; t < tris; t++) faceTris.push({ face: n, positions: f.buffers.positions, indices: f.buffers.indices, tri: t });
    }
  // 4 sample points per triangle (centroid + 3 edge midpoints); stride over
  // triangles deterministically so the whole model is covered evenly.
  const triBudget = Math.max(1, Math.floor(budget / 4));
  const stride = Math.max(1, Math.ceil(faceTris.length / triBudget));
  const errors: number[] = [];
  let sampledTriangles = 0;
  for (let k = 0; k < faceTris.length; k += stride) {
    const { face, positions, indices, tri } = faceTris[k];
    const faceHandle = faces[face];
    if (!faceHandle) continue;
    sampledTriangles++;
    const v = (i: number) => {
      const j = indices[tri * 3 + i] * 3;
      return [positions[j], positions[j + 1], positions[j + 2]];
    };
    const [a, b, c] = [v(0), v(1), v(2)];
    const pts = [
      [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3],
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
      [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2, (b[2] + c[2]) / 2],
      [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2],
    ];
    for (const p of pts) {
      const local: Array<{ delete(): void }> = [];
      try {
        const pnt = new oc.gp_Pnt_3(p[0], p[1], p[2]);
        local.push(pnt);
        const mv = new oc.BRepBuilderAPI_MakeVertex(pnt);
        local.push(mv);
        const dist = new oc.BRepExtrema_DistShapeShape_1();
        local.push(dist);
        dist.LoadS1(faceHandle);
        dist.LoadS2(mv.Vertex());
        dist.Perform();
        if (dist.IsDone()) errors.push(dist.Value() * scale);
      } finally {
        for (let i = local.length - 1; i >= 0; i--) {
          try {
            local[i].delete();
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  const tol = requested * (1 + 1e-9);
  return {
    max: errors.length ? Math.max(...errors) : 0,
    p95: errors.length ? percentile(errors, 95) : 0,
    mean: errors.length ? errors.reduce((s, e) => s + e, 0) / errors.length : 0,
    samples: errors.length,
    sampledTriangles,
    exceedingRequested: errors.filter((e) => e > tol).length,
  };
}
