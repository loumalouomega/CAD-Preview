import * as fs from "fs";
import * as path from "path";
// Use the raw emscripten factory directly (NOT the initOpenCascade wrapper from
// index.js, which takes no arguments and ignores wasmBinary). Passing wasmBinary
// bypasses Node 18's built-in fetch(), which fails to parse filesystem paths.
import openCascadeFactory from "opencascade.js/dist/opencascade.wasm.js";
import { tessellateByGroup, type SolidGroup } from "./meshExtract";
import type { TreeNode } from "./protocol";
import type { CadFormat } from "./fileRouter";

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
  tree: TreeNode;
}

/**
 * Reads `bytes`, parses with the appropriate OCCT reader, tessellates grouped
 * by solid, and returns geometry groups alongside the component tree.
 */
export async function loadBRep(
  extensionPath: string,
  bytes: Uint8Array,
  format: Extract<CadFormat, "step" | "iges" | "brep">
): Promise<BRepResult> {
  const oc = await getOcct(extensionPath);

  const tmpName = `/in.${format}`;
  oc.FS.writeFile(tmpName, bytes);

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const shape = readShape(oc, tmpName, format, cleanup);
    const groups = tessellateByGroup(oc, shape);
    const tree = buildTree(format, groups);
    return { groups, tree };
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
 * Re-parses `bytes` as `sourceFormat` and writes the resulting shape out as
 * `targetFormat`, returning the output file's bytes. Writer calls are verified against
 * the live OCCT build — see `writeShape` below for the per-format quirks.
 */
export async function exportBRep(
  extensionPath: string,
  bytes: Uint8Array,
  sourceFormat: BRepFormat,
  targetFormat: BRepFormat
): Promise<Uint8Array> {
  const oc = await getOcct(extensionPath);

  const inPath = `/export-in.${sourceFormat}`;
  const outPath = `/export-out.${targetFormat}`;
  oc.FS.writeFile(inPath, bytes);

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const shape = readShape(oc, inPath, sourceFormat, cleanup);
    writeShape(oc, shape, outPath, targetFormat, cleanup);
    return oc.FS.readFile(outPath);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try { cleanup[i].delete(); } catch { /* ignore */ }
    }
    try { oc.FS.unlink(inPath); } catch { /* ignore */ }
    try { oc.FS.unlink(outPath); } catch { /* ignore */ }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeShape(oc: any, shape: any, filePath: string, format: BRepFormat, cleanup: Array<{ delete(): void }>): void {
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
    const writer = new oc.IGESControl_Writer_1();
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
