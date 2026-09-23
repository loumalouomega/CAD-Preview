/**
 * Narrow-gap and passage resolution preflight — the kernel half. Measures
 * every face of the EDITED B-rep (exact analytic surface via
 * `faceSurfaceInfo`, an orientation-aware outward normal from the
 * tessellation's winding, and the tessellation vertices for overlap
 * projections) and hands them to the pure `findPassages`.
 *
 * Why the winding: `TopoDS.Orientation` is unbound in this build, but the
 * tessellation (`meshExtract.ts`) already reverses the triangle winding of a
 * `TopAbs_REVERSED` face, so a triangle's winding normal IS the face's
 * outward normal — the fact that decides void gap vs solid wall.
 */
import { getOcct, readShape, wrapOcctFault } from "./occtService";
import { applyEditsBRep, collectFaces, faceSurfaceInfo } from "./occtOperations";
import { tessellateByGroup } from "./meshExtract";
import { TESSELLATION_PRESETS } from "./tessellationQuality";
import { findPassages, type PassageFace, type PassageReport, type PassageTolerances, type SizeContext, type Vec3 } from "./passageAnalysis";
import type { EditOp } from "./editOps";
import type { Part } from "./protocol";

export interface PassageAnalysisOptions {
  targetCells?: number;
  /** Global target size (mm); null/undefined = unbounded. */
  sizeMax?: number | null;
  parts?: Part[];
  tolerances?: PassageTolerances;
  maxFindings?: number;
}

export interface PassageAnalysisResult extends PassageReport {
  diagonal: number;
}

export async function analyzePassages(
  extensionPath: string,
  bytes: Uint8Array,
  format: "step" | "iges" | "brep" | "csg",
  ops: EditOp[],
  options: PassageAnalysisOptions = {}
): Promise<PassageAnalysisResult> {
  const oc = await getOcct(extensionPath);
  const tmp = `/pa.${format}`;
  oc.FS.writeFile(tmp, bytes);
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const base = readShape(oc, tmp, format, cleanup);
    const shape = applyEditsBRep(oc, base, ops, cleanup);
    const groups = tessellateByGroup(oc, shape, TESSELLATION_PRESETS.draft);
    const liveFaces = collectFaces(oc, shape, cleanup);
    const faces: PassageFace[] = [];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const g of groups) {
      const owner = g.label === "Sketches" ? null : g.id;
      for (const f of g.faces) {
        const { positions, indices } = f.buffers;
        const points: Vec3[] = [];
        for (let i = 0; i + 2 < positions.length; i += 3) {
          const p: Vec3 = [positions[i], positions[i + 1], positions[i + 2]];
          points.push(p);
          for (let a = 0; a < 3; a++) {
            if (p[a] < lo[a]) lo[a] = p[a];
            if (p[a] > hi[a]) hi[a] = p[a];
          }
        }
        const live = liveFaces[Number(f.faceId.slice(5))];
        let surface: PassageFace["surface"] = { kind: "other" };
        if (live) {
          const info = faceSurfaceInfo(oc, live, cleanup);
          if (info.params?.kind === "plane") surface = { kind: "plane", origin: info.params.origin, normal: info.params.normal };
          else if (info.params?.kind === "cylinder")
            surface = { kind: "cylinder", radius: info.params.radius, axisLocation: info.params.axisLocation, axisDirection: info.params.axisDirection };
        }
        faces.push({ faceId: f.faceId, owner, surface, sample: windingSample(positions, indices), points, triangles: indices });
      }
    }
    const diagonal = Number.isFinite(lo[0]) ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 0;
    const report = findPassages(faces, sizeContextOf(options), {
      diagonal: diagonal || 1,
      targetCells: options.targetCells,
      tolerances: options.tolerances,
      maxFindings: options.maxFindings,
    });
    return { ...report, diagonal };
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

/** The largest triangle's centroid and winding normal — the face's outward
 * normal at a representative point (largest, to stay clear of slivers). */
function windingSample(positions: Float32Array, indices: Uint32Array): PassageFace["sample"] {
  let best = -1;
  let out: PassageFace["sample"] = null;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const n: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len > best) {
      best = len;
      out = {
        point: [
          (positions[a] + positions[b] + positions[c]) / 3,
          (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3,
          (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3,
        ],
        normal: [n[0] / len, n[1] / len, n[2] / len],
      };
    }
  }
  return best > 0 ? out : null;
}

/** Local sizes a Part asks for: `meshSize`, or a grading band's `sizeAtWall`
 * (the size AT the part's own faces), per face id and per owning solid. */
function sizeContextOf(options: PassageAnalysisOptions): SizeContext {
  const faceSizes = new Map<string, number>();
  const solidSizes = new Map<string, number>();
  const put = (m: Map<string, number>, k: string, v: number) => m.set(k, Math.min(m.get(k) ?? Infinity, v));
  for (const p of options.parts ?? []) {
    const sizes = [p.meshSize, p.meshGrading?.sizeAtWall].filter((v): v is number => typeof v === "number" && v > 0);
    if (sizes.length === 0) continue;
    const s = Math.min(...sizes);
    for (const f of p.surfaces) put(faceSizes, f, s);
    for (const v of p.volumes) put(solidSizes, v, s);
  }
  const sm = options.sizeMax;
  return { sizeMax: typeof sm === "number" && sm > 0 && sm < 1e20 ? sm : null, faceSizes, solidSizes };
}
