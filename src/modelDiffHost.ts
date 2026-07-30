import { getOcct, readShape } from "./occtService";
import { applyEditsBRep, collectSolids, bboxCenter, bboxDiagonal } from "./occtOperations";
import type { BRepFormat } from "./massProperties";
import type { EditOp } from "./editOps";
import { diffSolids, type ModelDiff, type SolidSignature } from "./modelDiff";

/**
 * OCCT-side half of "Compare Models" — resolves each solid's `bboxCenter`/
 * `bboxDiagonal` (both already shared with `explodeSolids`/`gmshPartsMap.ts`)
 * and volume (the same `BRepGProp.VolumeProperties_1` call shape
 * `massProperties.ts`'s `solidProperties` uses) into a `SolidSignature[]` for
 * `src/modelDiff.ts`'s pure matcher. B-rep only — both files are read
 * independently via the existing `readShape()`, so this needs no webview
 * involvement and works identically from the extension host and the MCP
 * server.
 */
async function extractSolidSignatures(
  extensionPath: string,
  bytes: Uint8Array,
  format: BRepFormat,
  ops: EditOp[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ signatures: SolidSignature[]; diagonal: number; shape: any; oc: any; cleanup: Array<{ delete(): void }> }> {
  const oc = await getOcct(extensionPath);
  const tmpName = `/cm.${format}`;
  oc.FS.writeFile(tmpName, bytes);
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const baseShape = readShape(oc, tmpName, format, cleanup);
    const shape = applyEditsBRep(oc, baseShape, ops, cleanup);
    const diagonal = bboxDiagonal(oc, shape, cleanup);
    const solids = collectSolids(oc, shape, cleanup);
    const signatures = solids.map(({ id, solid }) => {
      const centre = bboxCenter(oc, solid, cleanup);
      const props = new oc.GProp_GProps_1();
      cleanup.push(props);
      oc.BRepGProp.VolumeProperties_1(solid, props, false, false, false);
      return { id, centre, diagonal: bboxDiagonal(oc, solid, cleanup), volume: props.Mass() };
    });
    return { signatures, diagonal, shape, oc, cleanup };
  } finally {
    oc.FS.unlink(tmpName);
  }
}

/**
 * Compares two B-rep models solid-by-solid. `toleranceFrac` (default `1e-3`,
 * matching `gmshPartsMap.ts`'s existing tolerance-fraction convention) is
 * multiplied by the LARGER of the two models' whole-shape bounding-box
 * diagonals to get the absolute centroid-distance tolerance `diffSolids`
 * matches within.
 */
export async function compareModels(
  extensionPath: string,
  bytesA: Uint8Array,
  formatA: BRepFormat,
  opsA: EditOp[],
  bytesB: Uint8Array,
  formatB: BRepFormat,
  opsB: EditOp[],
  toleranceFrac = 1e-3
): Promise<ModelDiff> {
  const ra = await extractSolidSignatures(extensionPath, bytesA, formatA, opsA);
  try {
    const rb = await extractSolidSignatures(extensionPath, bytesB, formatB, opsB);
    try {
      const toleranceAbs = toleranceFrac * Math.max(ra.diagonal, rb.diagonal);
      return diffSolids(ra.signatures, rb.signatures, toleranceAbs);
    } finally {
      for (let i = rb.cleanup.length - 1; i >= 0; i--) {
        try { rb.cleanup[i].delete(); } catch { /* ignore */ }
      }
    }
  } finally {
    for (let i = ra.cleanup.length - 1; i >= 0; i--) {
      try { ra.cleanup[i].delete(); } catch { /* ignore */ }
    }
  }
}
