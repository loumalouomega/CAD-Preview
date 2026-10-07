import type { Mmg, MmgHandles } from "@loumalouomega/mmg-wasm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { resolveRuntimePackage } from "./runtimePackage";
import { MMG_MEMORY_MB, validateMmgOptions, type MmgOptions } from "./mmgOptions";

let singleton: Promise<Mmg> | null = null;

/** Lazy CJS external, with an explicitly staged, replaceable WASM binary. */
export function getMmg(extensionPath: string): Promise<Mmg> {
  if (!singleton) {
    const initialize = createRequire(import.meta.url)(resolveRuntimePackage("@loumalouomega/mmg-wasm", "mmg", "dist/mmg.cjs")) as typeof import("@loumalouomega/mmg-wasm").initialize;
    singleton = initialize({
      wasmBinary: readFileSync(join(extensionPath, "dist", "mmg-core.wasm")),
      print: (text: string) => console.error(`[MMG] ${text}`),
      printErr: (text: string) => console.error(`[MMG] ${text}`),
    }).catch(error => { singleton = null; throw error; });
  }
  return singleton;
}

export function resetMmg(): void { singleton = null; }

export function wrapMmgFault(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/STRONGFAILURE|out of bounds|abort|RuntimeError|unreachable|null function|table index|function table|wasmtable/i.test(message) || /^\d+$/.test(message.trim())) {
    resetMmg();
    return new Error(`MMG failed; the kernel was reset. Retry with a coarser size or a smaller mesh. ${message}`);
  }
  return error instanceof Error ? error : new Error(message);
}

export interface MmgMesh {
  positions: Float64Array;
  triangles: Int32Array; // one-based vertex ids
  triangleRefs: Int32Array;
  tetrahedra: Int32Array;
  tetraRefs: Int32Array;
}

/** Stateless worker-side operation. References, not renumbered ids, carry
 * regions across the remesh. No implicit linearisation or optim-only mode. */
export async function remeshMmg(extensionPath: string, input: MmgMesh, requested: MmgOptions = {}) {
  const options = validateMmgOptions(requested);
  if (!input.positions.length || input.positions.length % 3) throw new Error("MMG requires non-empty xyz vertices");
  const volume = input.tetrahedra.length > 0;
  if (!volume && !input.triangles.length) throw new Error("MMG requires triangles or tetrahedra");
  const np = input.positions.length / 3;
  for (const [cells, refs, arity] of [[input.triangles, input.triangleRefs, 3], [input.tetrahedra, input.tetraRefs, 4]] as const) {
    if (cells.length % arity || refs.length !== cells.length / arity) throw new Error("MMG connectivity/reference count mismatch");
    for (const id of cells) if (id < 1 || id > np) throw new Error("MMG vertex index out of range");
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < input.positions.length; i++) {
    const n = input.positions[i];
    if (!Number.isFinite(n)) throw new Error("MMG vertices must be finite");
    min[i % 3] = Math.min(min[i % 3], n); max[i % 3] = Math.max(max[i % 3], n);
  }
  const diagonal = Math.hypot(...max.map((n, i) => n - min[i]));
  if (!(diagonal > 0)) throw new Error("MMG mesh has zero extent");
  const hausd = (options.hausd ?? 0.005) * (options.hausdRelative === false ? 1 : diagonal);
  if (!Number.isFinite(hausd) || !(hausd > 0)) throw new Error("MMG effective hausd must be finite and positive; check mesh scale and hausd");
  const mmg = await getMmg(extensionPath);
  const api = volume ? mmg.mmg3d : mmg.mmgs;
  let handles: MmgHandles | undefined;
  const start = Date.now();
  try {
    handles = api.init();
    const { mesh, met } = handles;
    // MUST precede setMeshSize: otherwise the default ~800MB arrays have
    // already been allocated. This is MMG's allocation target, not an OS cap.
    api.setIparameter(mesh, met, api.IPARAM_mem, MMG_MEMORY_MB);
    api.setIparameter(mesh, met, api.IPARAM_verbose, -1);
    if (volume) mmg.mmg3d.setMeshSize(mesh, np, input.tetrahedra.length / 4, 0, input.triangles.length / 3, 0, 0);
    else mmg.mmgs.setMeshSize(mesh, np, input.triangles.length / 3, 0);
    api.setVertices(mesh, input.positions, null);
    if (volume) mmg.mmg3d.setTetrahedra(mesh, input.tetrahedra, input.tetraRefs);
    if (input.triangles.length) api.setTriangles(mesh, input.triangles, input.triangleRefs);
    api.setDparameter(mesh, met, api.DPARAM_hausd, hausd);
    for (const [key, parameter] of [["hmin", api.DPARAM_hmin], ["hmax", api.DPARAM_hmax], ["hgrad", api.DPARAM_hgrad]] as const) {
      if (options[key] !== undefined) api.setDparameter(mesh, met, parameter, options[key]!);
    }
    const code = api.remesh(mesh, met);
    const size = api.getMeshSize(mesh) as { np: number; nt: number; ne?: number };
    if (size.np <= 0 || (volume ? (size.ne ?? 0) <= 0 : size.nt <= 0)) throw new Error("MMG empty harvest — no output mesh was produced");
    const positions = api.getVertices(mesh, size.np).vertices.slice();
    const triangles = size.nt ? api.getTriangles(mesh, size.nt) : { tria: new Int32Array(), refs: new Int32Array() };
    const tets = volume ? mmg.mmg3d.getTetrahedra(mesh, size.ne!) : { tetra: new Int32Array(), refs: new Int32Array() };
    return {
      positions, triangles: triangles.tria.slice(), triangleRefs: triangles.refs.slice(),
      tetrahedra: tets.tetra.slice(), tetraRefs: tets.refs.slice(),
      report: { module: volume ? "mmg3d" as const : "mmgs" as const, inputNodes: np, outputNodes: size.np,
        inputCells: volume ? input.tetrahedra.length / 4 : input.triangles.length / 3,
        outputCells: volume ? size.ne! : size.nt, hausd, memoryMb: MMG_MEMORY_MB,
        wasmBytes: (mmg.module.HEAPU8 as Uint8Array).byteLength, elapsedMs: Date.now() - start,
        lowFailure: code === mmg.MMG5_LOWFAILURE },
    };
  } catch (error) {
    throw wrapMmgFault(error);
  } finally {
    if (handles) { try { api.free(handles); } catch (error) { throw wrapMmgFault(error); } }
  }
}
