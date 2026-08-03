import * as fs from "fs";
import * as path from "path";
// Use the raw emscripten factory directly (NOT the initOpenCascade wrapper from
// index.js, which takes no arguments and ignores wasmBinary). Passing wasmBinary
// bypasses Node 18's built-in fetch(), which fails to parse filesystem paths.
import openCascadeFactory from "opencascade.js/dist/opencascade.wasm.js";
import { tessellateByGroup, extractEdges, extractVertices, type SolidGroup, type EdgeLine, type PointEntity } from "./meshExtract";
import { applyEditsBRep, scaleShapeForExport } from "./occtOperations";
import type { TreeNode } from "./protocol";
import type { CadFormat } from "./fileRouter";
import type { EditOp } from "./editOps";
import { type DisplayUnit, unitScaleFactor, igesUnitName } from "./lengthUnits";
import { patchStepUnitDeclaration } from "./stepUnitPatch";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ocPromise: Promise<any> | null = null;

/** Returns the OpenCascade.js module, initializing it lazily on first call. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getOcct(extensionPath: string): Promise<any> {
  if (!_ocPromise) {
    const wasmPath = path.join(extensionPath, "dist", "opencascade.wasm.wasm");
    const wasmBinary = fs.readFileSync(wasmPath);
    _ocPromise = openCascadeFactory({ wasmBinary });
  }
  return _ocPromise;
}

/** Resets the singleton — used by tests and for future hot-reload support. */
export function resetOcct(): void {
  _ocPromise = null;
}

export interface BRepResult {
  groups: SolidGroup[];
  edges: EdgeLine[];
  points: PointEntity[];
  tree: TreeNode;
}

/**
 * Reads `bytes`, parses with the appropriate OCCT reader, applies the replayable
 * edit op-list (if any), tessellates grouped by solid, and returns geometry
 * groups alongside the component tree. With an empty `ops` this is the original
 * read-only path; the source bytes are never modified.
 */
export async function loadBRep(
  extensionPath: string,
  bytes: Uint8Array,
  format: Extract<CadFormat, "step" | "iges" | "brep">,
  ops: EditOp[] = []
): Promise<BRepResult> {
  const oc = await getOcct(extensionPath);

  const tmpName = `/in.${format}`;
  oc.FS.writeFile(tmpName, bytes);

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const baseShape = readShape(oc, tmpName, format, cleanup);
    const shape = applyEditsBRep(oc, baseShape, ops, cleanup);
    const groups = tessellateByGroup(oc, shape);
    const edges = extractEdges(oc, shape);
    const points = extractVertices(oc, shape);
    const tree = buildTree(format, groups);
    return { groups, edges, points, tree };
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try { cleanup[i].delete(); } catch { /* ignore */ }
    }
    try { oc.FS.unlink(tmpName); } catch { /* ignore */ }
  }
}

function buildTree(format: string, groups: SolidGroup[]): TreeNode {
  return {
    id: "root",
    label: format.toUpperCase(),
    children: groups.map((g) => ({
      id: g.id,
      label: g.label,
      faceCount: g.faceCount,
    })),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readShape(oc: any, filePath: string, format: string, cleanup: Array<{ delete(): void }>): any {
  const retDone = oc.IFSelect_ReturnStatus.IFSelect_RetDone.value;

  if (format === "step") {
    const reader = new oc.STEPControl_Reader_1();
    cleanup.push(reader);
    const ret = reader.ReadFile(filePath);
    if (ret.value !== retDone) throw new Error(`STEP ReadFile failed (code ${ret.value})`);
    reader.TransferRoots();
    const shape = reader.OneShape();
    cleanup.push(shape);
    return shape;
  }

  if (format === "iges") {
    const reader = new oc.IGESControl_Reader_1();
    cleanup.push(reader);
    const ret = reader.ReadFile(filePath);
    if (ret.value !== retDone) throw new Error(`IGES ReadFile failed (code ${ret.value})`);
    reader.TransferRoots();
    const shape = reader.OneShape();
    cleanup.push(shape);
    return shape;
  }

  if (format === "brep") {
    const builder = new oc.BRep_Builder();
    cleanup.push(builder);
    const shape = new oc.TopoDS_Shape();
    cleanup.push(shape);
    // Not `Message_ProgressRange_1` — that constructor doesn't exist in this OCCT
    // build and throws immediately. `Read_2`'s 4th param is actually a
    // `Handle_Message_ProgressIndicator`.
    const progress = new oc.Handle_Message_ProgressIndicator_1();
    cleanup.push(progress);
    oc.BRepTools.Read_2(shape, filePath, builder, progress);
    return shape;
  }

  throw new Error(`Unknown B-rep format: ${format}`);
}

type BRepFormat = Extract<CadFormat, "step" | "iges" | "brep">;

/**
 * Re-parses `bytes` as `sourceFormat`, applies the edit op-list, and writes the
 * resulting shape out as `targetFormat`, returning the output file's bytes — so
 * Export bakes in the same edits the view shows. Writer calls are verified against
 * the live OCCT build — see `writeShape` below for the per-format quirks.
 *
 * `unit` (default `"mm"`, i.e. no-op) applies a real geometric unit-conversion
 * scale right after edits and before the writer, so the *exported file's*
 * coordinates are in the chosen unit while the live, in-memory model (and
 * every other caller of this function — meshing input, `compare_models`, mass
 * properties, etc.) stays untouched at the cascade unit (mm). Only
 * `provider.ts`'s `handleExport`/`resolveMeshInput` and `mcpTools.ts`'s
 * `exportBRepTool`/`resolveMeshInputHeadless` ever pass a non-default value.
 *
 * Per target format, this is genuinely three different mechanisms, not one
 * scale applied uniformly — see `writeShape`'s doc comment for the two
 * writer-level quirks this dispatches around:
 * - `"brep"`: `scaleShapeForExport` only (BREP has no unit metadata at all).
 * - `"step"`: `scaleShapeForExport`, THEN — when `labelStepUnit` is `true`
 *   (the default) — a text-only header patch (`stepUnitPatch.ts`'s
 *   `patchStepUnitDeclaration`) after writing, since this OCCT WASM build's
 *   STEP writer has no unit-aware API at all (see that module's doc comment
 *   for the full probing trail) — the geometry is already correctly scaled by
 *   the time the writer runs, so every raw number in the file (including the
 *   writer's own auto-computed tolerance) is already correct; only the
 *   *label* needs fixing.
 * - `"iges"`: NEVER `scaleShapeForExport` — `IGESControl_Writer_2`'s
 *   unit-aware overload scales the geometry internally when given a
 *   non-native unit name, so pre-scaling would double-convert.
 *
 * `labelStepUnit` (default `true`) exists SOLELY for `resolveMeshInput`/
 * `resolveMeshInputHeadless`'s meshing-input STEP, which must pass `false`.
 * Verified against the live WASM: Gmsh's own `gmsh.model.occ.importShapes`
 * (unlike this codebase's own OCCT reader, confirmed by comparison) DOES
 * reinterpret a STEP file's declared unit — feeding it a correctly-scaled AND
 * correctly-labeled `"in"` file makes Gmsh silently convert the geometry BACK
 * to its original (larger) real-world size, undoing the scale entirely, while
 * `MeshOptions.sizeMin`/`sizeMax` stay at the (smaller, already-rescaled)
 * requested values — a real, confirmed regression (mesh density mismatch,
 * `mm`-vs-`in`-scale disagreement) this flag exists to prevent. The
 * meshing-input STEP is never shown to the user (discarded immediately after
 * Gmsh reads it), so keeping its header at the OCCT-native `"mm"` label while
 * still scaling its geometry — the exact behavior this codebase already had
 * before STEP-header-patching existed — has zero externally-visible effect.
 */
export async function exportBRep(
  extensionPath: string,
  bytes: Uint8Array,
  sourceFormat: BRepFormat,
  targetFormat: BRepFormat,
  ops: EditOp[] = [],
  unit: DisplayUnit = "mm",
  labelStepUnit = true
): Promise<Uint8Array> {
  const oc = await getOcct(extensionPath);

  // Short, single-character-basename paths: this OCCT WASM build's STEP
  // path-handling (STEPControl_Reader/Writer, or lower-level XSTEP/IFSelect
  // infrastructure) has a fixed-size internal C string buffer — total MEMFS
  // path strings of 11+ characters consistently fail to read (`STEP ReadFile
  // failed (code 2)`) and, worse, can *silently* corrupt writes (the writer
  // reports success but the file is unreadable afterward). Verified: 10 chars
  // OK, 11 FAIL, for all of step/iges/brep (each a 4-char extension). Distinct
  // from loadBRep()'s `/in.${format}` since both run on the same shared,
  // long-lived `getOcct()` singleton.
  const inPath = `/e.${sourceFormat}`;
  const outPath = `/o.${targetFormat}`;
  oc.FS.writeFile(inPath, bytes);

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const baseShape = readShape(oc, inPath, sourceFormat, cleanup);
    let shape = applyEditsBRep(oc, baseShape, ops, cleanup);
    const factor = unitScaleFactor(unit);
    if (factor !== 1 && targetFormat !== "iges") shape = scaleShapeForExport(oc, shape, factor, cleanup);
    writeShape(oc, shape, outPath, targetFormat, cleanup, unit);
    const outBytes: Uint8Array = oc.FS.readFile(outPath);
    if (targetFormat === "step" && unit !== "mm" && labelStepUnit) {
      const text = Buffer.from(outBytes).toString("utf8");
      return new TextEncoder().encode(patchStepUnitDeclaration(text, unit));
    }
    return outBytes;
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try { cleanup[i].delete(); } catch { /* ignore */ }
    }
    try { oc.FS.unlink(inPath); } catch { /* ignore */ }
    try { oc.FS.unlink(outPath); } catch { /* ignore */ }
  }
}

/**
 * `unit` only matters for `"iges"` — picks between the plain `_1` writer
 * (native mm) and the unit-aware `_2` overload (`IGESControl_Writer_2(name,
 * modeCreation)`), verified against the live WASM to both correctly declare
 * AND correctly scale the output for all five `DisplayUnit`s (round-tripped
 * through this codebase's own reader, recovering the source model's exact
 * bounding box in every case — see `igesUnitName`'s doc comment in
 * `lengthUnits.ts` for the full trail). The original CLAUDE.md write-up
 * calling this overload's output "unconfirmed" was a false negative caused
 * by feeding it an 11+ character MEMFS path (this build's undocumented
 * path-length limit, documented above in `exportBRep`), not a real limitation
 * of the writer itself.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeShape(oc: any, shape: any, filePath: string, format: BRepFormat, cleanup: Array<{ delete(): void }>, unit: DisplayUnit = "mm"): void {
  const retDone = oc.IFSelect_ReturnStatus.IFSelect_RetDone.value;

  if (format === "step") {
    const writer = new oc.STEPControl_Writer_1();
    cleanup.push(writer);
    const transferStatus = writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true);
    if (transferStatus.value !== retDone) throw new Error(`STEP Transfer failed (code ${transferStatus.value})`);
    const writeStatus = writer.Write(filePath);
    if (writeStatus.value !== retDone) throw new Error(`STEP Write failed (code ${writeStatus.value})`);
    return;
  }

  if (format === "iges") {
    const writer = unit === "mm" ? new oc.IGESControl_Writer_1() : new oc.IGESControl_Writer_2(igesUnitName(unit), 0);
    cleanup.push(writer);
    writer.AddShape(shape);
    writer.ComputeModel();
    const ok = writer.Write_2(filePath, false);
    if (!ok) throw new Error("IGES Write failed");
    return;
  }

  if (format === "brep") {
    const progress = new oc.Handle_Message_ProgressIndicator_1();
    cleanup.push(progress);
    const ok = oc.BRepTools.Write_2(shape, filePath, progress);
    if (!ok) throw new Error("BREP Write failed");
    return;
  }

  throw new Error(`Unknown B-rep export format: ${format}`);
}
