/**
 * Draft / undercut facts — the kernel half. Reduces any `CompareSource` to a
 * welded triangle mesh (a B-rep through OCCT's `fine` tessellation with its
 * edits baked in AND per-triangle `face-N` ids, so a finding names a real
 * face; a mesh through the host-side parsers) and hands it to the pure
 * `analyzeDraft`.
 */
import { getOcct, readShape, wrapOcctFault } from "./occtService";
import { applyEditsBRep } from "./occtOperations";
import { weldedMeshFromTessellation } from "./svgSilhouetteHost";
import { parseToWeldedMesh } from "./meshParse";
import type { WeldedMesh } from "./meshComponents";
import type { CompareSource } from "./modelDiffHost";
import { analyzeDraft, type DraftOptions, type DraftReport } from "./draftAnalysis";

export interface DraftResult {
  report: DraftReport;
  /** Per-corner draft angle in degrees (9 position floats + 3 values per triangle), when requested. */
  overlay?: { positions: Float32Array; values: Float32Array };
}

export interface CheckDraftOptions extends Omit<DraftOptions, "faceIds"> {
  /** Also return the per-corner draft overlay. */
  overlay?: boolean;
}

async function meshOf(extensionPath: string, source: CompareSource): Promise<{ mesh: WeldedMesh; faceIds?: string[] }> {
  if (source.kind !== "brep") {
    return { mesh: await parseToWeldedMesh(source.bytes, source.kind, source.kind === "gltf" ? source.externalBuffers : undefined) };
  }
  const oc = await getOcct(extensionPath);
  const tmp = `/dr.${source.format}`;
  oc.FS.writeFile(tmp, source.bytes);
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const shape = applyEditsBRep(oc, readShape(oc, tmp, source.format, cleanup), source.ops, cleanup);
    const { mesh, triangleFaceId } = weldedMeshFromTessellation(oc, shape, "fine");
    return { mesh, faceIds: triangleFaceId };
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

export async function checkDraft(extensionPath: string, source: CompareSource, options: CheckDraftOptions = {}): Promise<DraftResult> {
  const { mesh, faceIds } = await meshOf(extensionPath, source);
  const { overlay, ...analysis } = options;
  const report = analyzeDraft(mesh, { ...analysis, ...(faceIds ? { faceIds } : {}) });
  if (!overlay) return { report };
  const nTri = Math.floor(mesh.indices.length / 3);
  const positions = new Float32Array(nTri * 9);
  const values = new Float32Array(nTri * 3);
  const p = report.pull;
  for (let t = 0; t < nTri; t++) {
    const ia = mesh.indices[t * 3] * 3, ib = mesh.indices[t * 3 + 1] * 3, ic = mesh.indices[t * 3 + 2] * 3;
    const P = mesh.positions;
    const ux = P[ib] - P[ia], uy = P[ib + 1] - P[ia + 1], uz = P[ib + 2] - P[ia + 2];
    const vx = P[ic] - P[ia], vy = P[ic + 1] - P[ia + 1], vz = P[ic + 2] - P[ia + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    // Stored winding: the overlay is a display aid, so no per-body fix (a flipped body reads mirrored).
    const s = Math.max(-1, Math.min(1, (nx * p[0] + ny * p[1] + nz * p[2]) / len));
    const draft = (Math.asin(report.twoSided ? Math.abs(s) : s) * 180) / Math.PI;
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k] * 3;
      positions.set([P[v], P[v + 1], P[v + 2]], (t * 3 + k) * 3);
      values[t * 3 + k] = draft;
    }
  }
  return { report, overlay: { positions, values } };
}
