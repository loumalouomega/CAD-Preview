/**
 * Child-process entry point for the kernel-worker IPC boundary (roadmap
 * "OCCT in a forked child process", Phase 0+1 — see CLAUDE.md). Bundled by
 * esbuild to `dist/kernel-worker.js` (`esbuild.mjs`'s `kernelConfig`),
 * forked by `kernelClient.ts`. Hosts the exact same 21 `Pipeline` functions
 * `mcpServer.ts` used to call directly — their internals are UNCHANGED,
 * only the process they run in moves.
 */

// stdout purity: this process is spawned with stdio [ignore, ignore, pipe,
// ipc] (kernelClient.ts) — its stdout is discarded, not read, so a leaked
// console.log wouldn't corrupt anything today. Rebound anyway, matching
// mcpServer.ts's own discipline byte-for-byte: this file is a drop-in
// replacement for "the process this code runs in", and a future change to
// how the child's stdio is wired (or a future direct `node
// dist/kernel-worker.js` invocation) must not silently regress this.
/* eslint-disable no-console */
console.log = console.error.bind(console);
console.info = console.error.bind(console);
console.warn = console.error.bind(console);
console.debug = console.error.bind(console);
/* eslint-enable no-console */

import { loadBRep, exportBRep } from "./occtService";
import { generateMesh, exportMeshFormat, exportMdpa, exportGeoUnrolled } from "./gmshService";
import { computeMassProperties } from "./massProperties";
import { getEntityFacts, measureEntities, measureExact, checkInterference, rebindPartsAcrossOps } from "./entityFacts";
import { renderSnapshot, isRenderAvailable } from "./renderService";
import { searchStandardParts, downloadStandardPart } from "./stepPartsService";
import { compareModels } from "./modelDiffHost";
import { convertToStlBoundary, convertToStlBoundaryWithRegions, exportViaMeshio, readMeshioMetadata } from "./meshioService";
import { marshal, unmarshal, type KernelRequest, type KernelResponse } from "./kernelIpc";
import type { Pipeline } from "./mcpTools";

// Typed as `Record<keyof Pipeline, ...>` so TypeScript fails to compile if a
// key is missing/misspelled here relative to `Pipeline` — the one thing that
// would otherwise let this list silently drift from `kernelClient.ts`'s own
// (separately, structurally-checked) object literal.
type Handler = (...args: unknown[]) => Promise<unknown>;
const handlers: Record<keyof Pipeline, Handler> = {
  loadBRep: loadBRep as Handler,
  exportBRep: exportBRep as Handler,
  generateMesh: generateMesh as Handler,
  exportMeshFormat: exportMeshFormat as Handler,
  exportMdpa: exportMdpa as Handler,
  exportGeoUnrolled: exportGeoUnrolled as Handler,
  computeMassProperties: computeMassProperties as Handler,
  getEntityFacts: getEntityFacts as Handler,
  measureEntities: measureEntities as Handler,
  measureExact: measureExact as Handler,
  checkInterference: checkInterference as Handler,
  rebindPartsAcrossOps: rebindPartsAcrossOps as Handler,
  renderSnapshot: renderSnapshot as Handler,
  isRenderAvailable: isRenderAvailable as Handler,
  searchStandardParts: searchStandardParts as Handler,
  downloadStandardPart: downloadStandardPart as Handler,
  compareModels: compareModels as Handler,
  convertToStlBoundary: convertToStlBoundary as Handler,
  convertToStlBoundaryWithRegions: convertToStlBoundaryWithRegions as Handler,
  exportViaMeshio: exportViaMeshio as Handler,
  readMeshioMetadata: readMeshioMetadata as Handler,
};

process.on("message", (msg: KernelRequest) => {
  void (async () => {
    const { id, fn, args } = msg;
    try {
      const handler = handlers[fn as keyof Pipeline];
      if (!handler) throw new Error(`kernel-worker: unknown function "${fn}"`);
      const decodedArgs = args.map(unmarshal);
      const result = await handler(...decodedArgs);
      const response: KernelResponse = { id, ok: true, result: marshal(result) };
      process.send?.(response);
    } catch (err) {
      const response: KernelResponse = {
        id,
        ok: false,
        error: { message: err instanceof Error ? err.message : String(err) },
      };
      process.send?.(response);
    }
  })();
});
