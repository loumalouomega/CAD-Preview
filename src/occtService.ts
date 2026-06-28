import * as fs from "fs";
import * as path from "path";
// Use the raw emscripten factory directly (NOT the initOpenCascade wrapper from
// index.js, which takes no arguments and ignores wasmBinary). Passing wasmBinary
// bypasses Node 18's built-in fetch(), which fails to parse filesystem paths.
import openCascadeFactory from "opencascade.js/dist/opencascade.wasm.js";
import { tessellateShape, type GeometryBuffers } from "./meshExtract";
import type { CadFormat } from "./fileRouter";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ocPromise: Promise<any> | null = null;

/**
 * Returns the OpenCascade.js module, initializing it lazily on first call.
 *
 * The WASM binary is read from disk and passed as `wasmBinary` to avoid
 * Node 18's built-in `fetch()` being invoked with a filesystem path.
 *
 * `extensionPath` is the root of the installed extension (from ExtensionContext).
 * The WASM binary is expected at `<extensionPath>/dist/opencascade.wasm.wasm`.
 */
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

export interface MeshResult {
  meshes: GeometryBuffers[];
}

/**
 * Reads `bytes`, parses with the appropriate OCCT reader, tessellates, and
 * returns the resulting geometry buffers.
 */
export async function loadBRep(
  extensionPath: string,
  bytes: Uint8Array,
  format: Extract<CadFormat, "step" | "iges" | "brep">
): Promise<MeshResult> {
  const oc = await getOcct(extensionPath);

  const tmpName = `/in.${format}`;
  oc.FS.writeFile(tmpName, bytes);

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const shape = readShape(oc, tmpName, format, cleanup);
    const meshes = tessellateShape(oc, shape);
    return { meshes };
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try { cleanup[i].delete(); } catch { /* ignore */ }
    }
    try { oc.FS.unlink(tmpName); } catch { /* ignore */ }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readShape(oc: any, path: string, format: string, cleanup: Array<{ delete(): void }>): any {
  const retDone = oc.IFSelect_ReturnStatus.IFSelect_RetDone.value;

  if (format === "step") {
    const reader = new oc.STEPControl_Reader_1();
    cleanup.push(reader);
    const ret = reader.ReadFile(path);
    if (ret.value !== retDone) throw new Error(`STEP ReadFile failed (code ${ret.value})`);
    reader.TransferRoots();
    const shape = reader.OneShape();
    cleanup.push(shape);
    return shape;
  }

  if (format === "iges") {
    const reader = new oc.IGESControl_Reader_1();
    cleanup.push(reader);
    const ret = reader.ReadFile(path);
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
    oc.BRepTools.Read_2(shape, path, builder, new oc.Message_ProgressRange_1());
    return shape;
  }

  throw new Error(`Unknown B-rep format: ${format}`);
}
