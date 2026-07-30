import { getOcct, readShape } from "./occtService";
import { applyEditsBRep, collectSolids, bboxCenter, bboxDiagonal } from "./occtOperations";
import type { BRepFormat } from "./massProperties";
import type { EditOp } from "./editOps";
import { diffSolids, type ModelDiff, type SolidSignature } from "./modelDiff";
import { extractStlSolidSignatures } from "./stlSolidSignatures";

/** One side of a `compareModels()` call — B-rep (baked through the live
 * OCCT shape, edits included) or raw STL bytes (edits NOT baked — STL/mesh
 * documents have no host-side edit engine, same accepted limitation
 * `generate_mesh`'s STL path already documents). */
export type CompareSource =
  | { kind: "brep"; bytes: Uint8Array; format: BRepFormat; ops: EditOp[] }
  | { kind: "stl"; bytes: Uint8Array };

/**
 * OCCT-side half of "Compare Models" — resolves each solid's `bboxCenter`/
 * `bboxDiagonal` (both already shared with `explodeSolids`/`gmshPartsMap.ts`)
 * and volume (the same `BRepGProp.VolumeProperties_1` call shape
 * `massProperties.ts`'s `solidProperties` uses) into a `SolidSignature[]` for
 * `src/modelDiff.ts`'s pure matcher. Both files are read independently via
 * the existing `readShape()`, so this needs no webview involvement and works
 * identically from the extension host and the MCP server.
 */
async function extractBrepSolidSignatures(
  extensionPath: string,
  bytes: Uint8Array,
  format: BRepFormat,
  ops: EditOp[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ signatures: SolidSignature[]; diagonal: number }> {
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
    return { signatures, diagonal };
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try { cleanup[i].delete(); } catch { /* ignore */ }
    }
    try { oc.FS.unlink(tmpName); } catch { /* ignore */ }
  }
}

/** Dispatches a `CompareSource` to its matching signature extractor — the
 * STL path (`stlSolidSignatures.ts`) is pure/synchronous with no WASM
 * handles to clean up, unlike the B-rep path. */
async function extractSignatures(
  extensionPath: string,
  source: CompareSource
): Promise<{ signatures: SolidSignature[]; diagonal: number }> {
  if (source.kind === "stl") return extractStlSolidSignatures(source.bytes);
  return extractBrepSolidSignatures(extensionPath, source.bytes, source.format, source.ops);
}

/**
 * Compares two models solid-by-solid — B-rep (STEP/IGES/BREP, edits baked
 * in) or STL (raw file bytes, edits NOT baked in) on either side, in any
 * combination. `toleranceFrac` (default `1e-3`, matching `gmshPartsMap.ts`'s
 * existing tolerance-fraction convention) is multiplied by the LARGER of the
 * two models' whole-shape bounding-box diagonals to get the absolute
 * centroid-distance tolerance `diffSolids` matches within.
 */
export async function compareModels(
  extensionPath: string,
  a: CompareSource,
  b: CompareSource,
  toleranceFrac = 1e-3
): Promise<ModelDiff> {
  const ra = await extractSignatures(extensionPath, a);
  const rb = await extractSignatures(extensionPath, b);
  const toleranceAbs = toleranceFrac * Math.max(ra.diagonal, rb.diagonal);
  return diffSolids(ra.signatures, rb.signatures, toleranceAbs);
}
