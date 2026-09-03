/**
 * Child-process entry point for the kernel-worker IPC boundary (roadmap
 * "OCCT in a forked child process" — Phase 0+1 wired the MCP server, Phase
 * 2+3 additionally wired the interactive extension; see CLAUDE.md). Bundled
 * by esbuild to `dist/kernel-worker.js` (`esbuild.mjs`'s `kernelConfig`),
 * forked by `kernelClient.ts`. Hosts the exact same 21 `Pipeline` functions
 * `mcpServer.ts` used to call directly — their internals are UNCHANGED, only
 * the process they run in moves — plus two document-cache-aware functions
 * (`loadBRepCachedForDocument`/`disposeBRepCacheForDocument`) and
 * `readMeshioFieldValues`, which `provider.ts` needs and `mcpTools.ts` never
 * did (see `kernelClient.ts`'s `DocumentPipeline`).
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

import { loadBRep, exportBRep, loadBRepCached, disposeBRepCache, type BRepCacheEntry, type BRepResult } from "./occtService";
import { generateMesh, exportMeshFormat, exportMdpa, exportGeoUnrolled, repairMesh } from "./gmshService";
import { computeMassProperties, computeBom } from "./massProperties";
import { getEntityFacts, measureEntities, measureExact, checkInterference, checkInterferenceAll, rebindPartsAcrossOps, resolveBucketSelector } from "./entityFacts";
import { renderSnapshot, isRenderAvailable } from "./renderService";
import { searchStandardParts, downloadStandardPart } from "./stepPartsService";
import { compareModels } from "./modelDiffHost";
import {
  convertToStlBoundary,
  convertToStlBoundaryWithRegions,
  convertFoamCaseToStlBoundary,
  exportViaMeshio,
  readMeshioMetadata,
  readMeshioDataInfo,
  runMeshioOps,
  readMeshioFieldValues,
} from "./meshioService";
import { checkMeshHealth, promoteMeshToBrep } from "./meshHeal";
import { recognizePrimitives } from "./primitiveReport";
import { fitMeshRegion } from "./meshRegionFit";
import { exportSvgSilhouette } from "./svgSilhouetteHost";
import { buildPrimitivesFile } from "./primitiveWrite";
import { marshal, unmarshal, type KernelRequest, type KernelResponse } from "./kernelIpc";
import type { DocumentPipeline } from "./kernelClient";
import { hitTest } from "./hitTestService";

/**
 * Per-document OCCT parse+replay cache (roadmap "Base-shape caching and
 * incremental replay", closed, moved here from `provider.ts` for Phase 2) —
 * the one piece of genuine, persistent state in this otherwise 100%-
 * stateless dispatcher, and deliberately so: `BRepCacheEntry`'s `baseShape`/
 * `shape` are live OCCT WASM handles that cannot be marshaled across the IPC
 * boundary at all (`kernelIpc.ts`'s generic `marshal()` would silently
 * produce garbage from an emscripten-bound object's near-empty own-property
 * set, not a loud error) — they can only ever be read, updated, and freed
 * from inside THIS process. `loadBRepCachedForDocument`/
 * `disposeBRepCacheForDocument` below are the only two functions that ever
 * touch this map; every other handler stays exactly as stateless as before.
 *
 * Accepted trade-off, stated plainly: if this child process is killed
 * (`kernelClient.ts`'s `cancelCurrent()`, the Phase 3 watchdog timeout, or a
 * genuine unhandled abort) EVERY open document's cache entry is lost at
 * once, since it's one process's memory — the next call for any given
 * document simply does a full cold re-parse, the same "a killed child loses
 * its warm state" trade-off Phase 0+1 already accepted for the stateless
 * calls, just now affecting potentially multiple documents simultaneously.
 */
const brepCacheByDocument = new Map<string, BRepCacheEntry>();

async function loadBRepCachedForDocument(
  documentKey: string,
  extensionPath: string,
  bytes: Uint8Array,
  format: Parameters<typeof loadBRepCached>[2],
  ops: Parameters<typeof loadBRepCached>[3],
  quality?: Parameters<typeof loadBRepCached>[5]
): Promise<BRepResult> {
  const previous = brepCacheByDocument.get(documentKey);
  const { result, cache } = await loadBRepCached(extensionPath, bytes, format, ops, previous, quality);
  brepCacheByDocument.set(documentKey, cache);
  return result; // never return `cache` itself — see the map's own doc comment above
}

async function disposeBRepCacheForDocument(documentKey: string): Promise<void> {
  const entry = brepCacheByDocument.get(documentKey);
  if (!entry) return;
  disposeBRepCache(entry);
  brepCacheByDocument.delete(documentKey);
}

// Typed as `Record<keyof DocumentPipeline, ...>` so TypeScript fails to
// compile if a key is missing/misspelled here relative to `DocumentPipeline`
// (`Pipeline` plus the 3 document-cache-aware functions, minus
// `cancelCurrent` — a client-only method with nothing for the worker to
// dispatch) — the one thing that would otherwise let this list silently
// drift from `kernelClient.ts`'s own (separately, structurally-checked)
// object literal.
type Handler = (...args: unknown[]) => Promise<unknown>;
const handlers: Record<keyof DocumentPipeline, Handler> = {
  loadBRep: loadBRep as Handler,
  exportBRep: exportBRep as Handler,
  generateMesh: generateMesh as Handler,
  exportMeshFormat: exportMeshFormat as Handler,
  exportMdpa: exportMdpa as Handler,
  exportGeoUnrolled: exportGeoUnrolled as Handler,
  computeMassProperties: computeMassProperties as Handler,
  computeBom: computeBom as Handler,
  getEntityFacts: getEntityFacts as Handler,
  hitTest: hitTest as Handler,
  measureEntities: measureEntities as Handler,
  measureExact: measureExact as Handler,
  checkInterference: checkInterference as Handler,
  checkInterferenceAll: checkInterferenceAll as Handler,
  rebindPartsAcrossOps: rebindPartsAcrossOps as Handler,
  resolveBucketSelector: resolveBucketSelector as Handler,
  renderSnapshot: renderSnapshot as Handler,
  isRenderAvailable: isRenderAvailable as Handler,
  searchStandardParts: searchStandardParts as Handler,
  downloadStandardPart: downloadStandardPart as Handler,
  compareModels: compareModels as Handler,
  convertToStlBoundary: convertToStlBoundary as Handler,
  convertToStlBoundaryWithRegions: convertToStlBoundaryWithRegions as Handler,
  convertFoamCaseToStlBoundary: convertFoamCaseToStlBoundary as Handler,
  exportViaMeshio: exportViaMeshio as Handler,
  readMeshioMetadata: readMeshioMetadata as Handler,
  readMeshioDataInfo: readMeshioDataInfo as Handler,
  runMeshioOps: runMeshioOps as Handler,
  loadBRepCachedForDocument: loadBRepCachedForDocument as Handler,
  disposeBRepCacheForDocument: disposeBRepCacheForDocument as Handler,
  readMeshioFieldValues: readMeshioFieldValues as Handler,
  checkMeshHealth: checkMeshHealth as Handler,
  recognizePrimitives: recognizePrimitives as Handler,
  fitMeshRegion: fitMeshRegion as Handler,
  promoteMeshToBrep: promoteMeshToBrep as Handler,
  repairMesh: repairMesh as Handler,
  exportSvgSilhouette: exportSvgSilhouette as Handler,
  buildPrimitivesFile: buildPrimitivesFile as Handler,
};

process.on("message", (msg: KernelRequest) => {
  void (async () => {
    const { id, fn, args } = msg;
    try {
      const handler = handlers[fn as keyof DocumentPipeline];
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
