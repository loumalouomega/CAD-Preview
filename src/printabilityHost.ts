/**
 * Printability facts — the kernel half. Reduces any `CompareSource` to a
 * welded triangle mesh (a B-rep through OCCT's `fine` tessellation with its
 * edits baked in; a mesh through the host-side parsers — the caller has
 * already baked pending mesh edits into an STL side, see `meshCompareSource`)
 * and hands it to the pure `analyzePrintability`.
 */
import { getOcct, readShape, wrapOcctFault } from "./occtService";
import { applyEditsBRep } from "./occtOperations";
import { tessellateByGroup } from "./meshExtract";
import { TESSELLATION_PRESETS } from "./tessellationQuality";
import { weldTriangleSoup, type WeldedMesh } from "./meshComponents";
import { parseToWeldedMesh } from "./meshParse";
import type { CompareSource } from "./modelDiffHost";
import { analyzePrintability, overhangFlags, type Axis, type PrintabilityOptions, type PrintabilityReport } from "./printability";

export interface PrintabilityResult {
  report: PrintabilityReport;
  /** Per-corner overlay data for the chosen `overlayUp` (9 floats per triangle + 1 flag per corner), when requested. */
  overlay?: { up: Axis; positions: Float32Array; values: Float32Array };
}

export interface CheckPrintabilityOptions extends PrintabilityOptions {
  /** Also return the overhang overlay for this build direction. */
  overlayUp?: Axis;
}

async function meshOf(extensionPath: string, source: CompareSource): Promise<WeldedMesh> {
  if (source.kind !== "brep") {
    return parseToWeldedMesh(source.bytes, source.kind, source.kind === "gltf" ? source.externalBuffers : undefined);
  }
  const oc = await getOcct(extensionPath);
  const tmp = `/pr.${source.format}`;
  oc.FS.writeFile(tmp, source.bytes);
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const shape = applyEditsBRep(oc, readShape(oc, tmp, source.format, cleanup), source.ops, cleanup);
    const groups = tessellateByGroup(oc, shape, TESSELLATION_PRESETS.fine);
    // Each face has its own index space: flatten to a corner soup, then weld.
    const soup: number[] = [];
    for (const g of groups)
      for (const f of g.faces) {
        const { positions, indices } = f.buffers;
        for (let i = 0; i < indices.length; i++) {
          const v = indices[i] * 3;
          soup.push(positions[v], positions[v + 1], positions[v + 2]);
        }
      }
    return weldTriangleSoup(new Float32Array(soup));
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

export async function checkPrintability(
  extensionPath: string,
  source: CompareSource,
  options: CheckPrintabilityOptions = {}
): Promise<PrintabilityResult> {
  const mesh = await meshOf(extensionPath, source);
  const { overlayUp, ...analysis } = options;
  const report = analyzePrintability(mesh, analysis);
  if (!overlayUp) return { report };
  const flags = overhangFlags(mesh, overlayUp, report.overhangLimitDeg);
  const nTri = Math.floor(mesh.indices.length / 3);
  const positions = new Float32Array(nTri * 9);
  const values = new Float32Array(nTri * 3);
  for (let t = 0; t < nTri; t++)
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k] * 3;
      positions.set([mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]], (t * 3 + k) * 3);
      values[t * 3 + k] = flags[t];
    }
  return { report, overlay: { up: overlayUp, positions, values } };
}
