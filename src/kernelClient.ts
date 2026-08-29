/**
 * Parent-side IPC client for the kernel-worker child process (roadmap "OCCT
 * in a forked child process", Phase 0+1 wired the MCP server; Phase 2+3 —
 * this file's `DocumentPipeline` extension, and the watchdog timeout below —
 * additionally cover the interactive extension. See CLAUDE.md.
 * `createKernelClient(extensionPath)` returns an object satisfying the exact
 * same `Pipeline` interface `mcpTools.ts` already consumes (`mcpServer.ts`'s
 * own `Pipeline` object literal used to import the 21 functions directly
 * from `occtService.ts`/`gmshService.ts`/etc. — this is a drop-in
 * replacement, `mcpTools.ts` needs no changes) PLUS three extra
 * document-cache-aware methods `provider.ts` needs that have no stateless
 * `Pipeline` equivalent (`DocumentPipeline`, below), PLUS `cancelCurrent()`
 * for real (process-kill) cancellation. One object serves both consumers —
 * `mcpServer.ts` simply never calls the three extra methods.
 *
 * OCCT/Gmsh/meshio++ are already effectively single-threaded per process (one
 * `_ocPromise`/`_gmshPromise`/`_meshioPromise` singleton each in the child) —
 * calls are queued and sent to the child one at a time, in order, matching
 * today's implicit serialization and making cancellation simple: kill the
 * child mid-request, the next queued call transparently respawns a fresh one.
 */

import { fork, type ChildProcess } from "child_process";
import * as path from "path";
import { marshal, unmarshal, type KernelRequest, type KernelResponse } from "./kernelIpc";
import type { Pipeline } from "./mcpTools";
import type { loadBRepCached, BRepResult } from "./occtService";
import type { readMeshioFieldValues } from "./meshioService";

type LoadBRepCachedParams = Parameters<typeof loadBRepCached>; // [extensionPath, bytes, format, ops, previous, quality]

/**
 * `Pipeline` plus the document-cache-aware calls only `provider.ts` needs —
 * `mcpTools.ts`'s tools never call `loadBRepCached` at all (every MCP tool is
 * stateless per-call), so these have no place in `Pipeline` itself.
 */
export interface DocumentPipeline extends Pipeline {
  /**
   * Like `loadBRep`, but the base-shape/op-replay cache (roadmap "Base-shape
   * caching and incremental replay", closed) now lives INSIDE the
   * kernel-worker child, keyed by `documentKey` (the caller's own choice of
   * stable id — `provider.ts` uses `document.uri.toString()`), since a
   * `BRepCacheEntry`'s live OCCT handles cannot cross the IPC boundary at
   * all — there is no `previous`/`cache` parameter or return field here the
   * way `loadBRepCached` itself has; the child manages that internally and
   * this returns only the tessellation result.
   */
  loadBRepCachedForDocument(
    documentKey: string,
    extensionPath: LoadBRepCachedParams[0],
    bytes: LoadBRepCachedParams[1],
    format: LoadBRepCachedParams[2],
    ops: LoadBRepCachedParams[3],
    quality?: LoadBRepCachedParams[5]
  ): Promise<BRepResult>;
  /** Frees `documentKey`'s cached OCCT handles inside the child (a no-op if
   * none exist there) — call once when a document's tab closes. Fire-and-
   * forget from the caller's point of view; nothing depends on its result. */
  disposeBRepCacheForDocument(documentKey: string): Promise<void>;
  readMeshioFieldValues: typeof readMeshioFieldValues;
}

export interface KernelClient extends DocumentPipeline {
  /** Kills the current child (SIGKILL) — real interruption, not just a
   * discarded result. Any request already sent to it rejects immediately;
   * the NEXT call transparently spawns a fresh child. A no-op if no child is
   * currently running. Also what the per-call watchdog timeout below uses
   * internally on a hang. */
  cancelCurrent(): void;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** No real operation should ever take this long — `scripts/perf/baseline.json`'s
 * xlarge fixture (2.3 MB STEP) is ~14s to load / ~27s to mesh, so 5 minutes
 * leaves enormous headroom for legitimately large files while still catching
 * the documented GMSH-3D-algorithm-hangs-indefinitely failure mode (CLAUDE.md's
 * Meshing section) in bounded time instead of never. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Creates one independent kernel-worker child + its own request queue. Each caller (the interactive extension host, an MCP server instance) gets its own — no cross-process sharing/daemon. */
export function createKernelClient(extensionPath: string, options?: { timeoutMs?: number }): KernelClient {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let child: ChildProcess | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingEntry>();
  // A single-slot chain: each new call's request is only SENT after the
  // previous one has settled (resolved or rejected) — see the file doc
  // comment for why serializing is both correct and sufficient here.
  let queueTail: Promise<unknown> = Promise.resolve();

  /** Removes and returns a pending entry, clearing its watchdog timer — the
   * one place every settlement path (a real response, a timeout, a send
   * error, a child exit) goes through, so a timer can never outlive its
   * entry or fire twice. */
  function takePending(id: number): PendingEntry | undefined {
    const entry = pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(id);
    }
    return entry;
  }

  function rejectAllPending(err: Error): void {
    for (const id of [...pending.keys()]) takePending(id)?.reject(err);
  }

  function killCurrentChild(): void {
    if (child) child.kill("SIGKILL"); // the 'exit' handler below rejects pending + clears `child` for the next call
  }

  function getChild(): ChildProcess {
    if (child) return child;
    const workerPath = path.join(extensionPath, "dist", "kernel-worker.js");
    // stdout is hard-wired to "ignore" — nothing the child could ever print
    // to it can leak anywhere, by construction (kernelWorker.ts's own
    // console rebind is a second line of defense on top of this, for the
    // case this file's own stdio wiring ever changes). stderr is piped and
    // forwarded to this process's own console.error, mirroring the "stderr
    // is fine, stdout must stay pure" rule mcpServer.ts already established
    // for the WASM modules it hosts directly.
    const spawned = fork(workerPath, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    spawned.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[kernel-worker] ${chunk.toString().replace(/\n$/, "")}`);
    });
    spawned.on("message", (msg: KernelResponse) => {
      const entry = takePending(msg.id);
      if (!entry) return; // a response for a request we've already given up on (timeout/cancel) — ignore
      if (msg.ok) entry.resolve(unmarshal(msg.result));
      else entry.reject(new Error(msg.error.message));
    });
    const onGone = (err: Error) => {
      if (child === spawned) child = null; // let the NEXT call respawn
      rejectAllPending(err);
    };
    spawned.on("exit", (code, signal) => onGone(new Error(`kernel worker exited unexpectedly (code=${code}, signal=${signal})`)));
    spawned.on("error", onGone);
    child = spawned;
    return spawned;
  }

  function callKernel(fn: string, args: unknown[]): Promise<unknown> {
    const run = (): Promise<unknown> =>
      new Promise<unknown>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          takePending(id);
          reject(
            new Error(
              `kernel-worker: "${fn}" did not respond within ${timeoutMs}ms — the kernel likely hung; killing and respawning the worker.`
            )
          );
          killCurrentChild();
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        const request: KernelRequest = { id, fn, args: args.map(marshal) };
        getChild().send(request, (err) => {
          if (err) takePending(id)?.reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
    // Chain after the previous call regardless of whether it resolved or
    // rejected — one call's failure must never wedge every call after it.
    const result = queueTail.then(run, run);
    queueTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  return {
    loadBRep: (...args) => callKernel("loadBRep", args) as ReturnType<Pipeline["loadBRep"]>,
    exportBRep: (...args) => callKernel("exportBRep", args) as ReturnType<Pipeline["exportBRep"]>,
    generateMesh: (...args) => callKernel("generateMesh", args) as ReturnType<Pipeline["generateMesh"]>,
    exportMeshFormat: (...args) => callKernel("exportMeshFormat", args) as ReturnType<Pipeline["exportMeshFormat"]>,
    exportMdpa: (...args) => callKernel("exportMdpa", args) as ReturnType<Pipeline["exportMdpa"]>,
    exportGeoUnrolled: (...args) => callKernel("exportGeoUnrolled", args) as ReturnType<Pipeline["exportGeoUnrolled"]>,
    computeMassProperties: (...args) => callKernel("computeMassProperties", args) as ReturnType<Pipeline["computeMassProperties"]>,
    computeBom: (...args) => callKernel("computeBom", args) as ReturnType<Pipeline["computeBom"]>,
    getEntityFacts: (...args) => callKernel("getEntityFacts", args) as ReturnType<Pipeline["getEntityFacts"]>,
    hitTest: (...args) => callKernel("hitTest", args) as ReturnType<Pipeline["hitTest"]>,
    measureEntities: (...args) => callKernel("measureEntities", args) as ReturnType<Pipeline["measureEntities"]>,
    measureExact: (...args) => callKernel("measureExact", args) as ReturnType<Pipeline["measureExact"]>,
    checkInterference: (...args) => callKernel("checkInterference", args) as ReturnType<Pipeline["checkInterference"]>,
    checkInterferenceAll: (...args) => callKernel("checkInterferenceAll", args) as ReturnType<Pipeline["checkInterferenceAll"]>,
    rebindPartsAcrossOps: (...args) => callKernel("rebindPartsAcrossOps", args) as ReturnType<Pipeline["rebindPartsAcrossOps"]>,
    renderSnapshot: (...args) => callKernel("renderSnapshot", args) as ReturnType<Pipeline["renderSnapshot"]>,
    isRenderAvailable: (...args) => callKernel("isRenderAvailable", args) as ReturnType<Pipeline["isRenderAvailable"]>,
    searchStandardParts: (...args) => callKernel("searchStandardParts", args) as ReturnType<Pipeline["searchStandardParts"]>,
    downloadStandardPart: (...args) => callKernel("downloadStandardPart", args) as ReturnType<Pipeline["downloadStandardPart"]>,
    compareModels: (...args) => callKernel("compareModels", args) as ReturnType<Pipeline["compareModels"]>,
    convertToStlBoundary: (...args) => callKernel("convertToStlBoundary", args) as ReturnType<Pipeline["convertToStlBoundary"]>,
    convertToStlBoundaryWithRegions: (...args) =>
      callKernel("convertToStlBoundaryWithRegions", args) as ReturnType<Pipeline["convertToStlBoundaryWithRegions"]>,
    convertFoamCaseToStlBoundary: (...args) =>
      callKernel("convertFoamCaseToStlBoundary", args) as ReturnType<Pipeline["convertFoamCaseToStlBoundary"]>,
    exportViaMeshio: (...args) => callKernel("exportViaMeshio", args) as ReturnType<Pipeline["exportViaMeshio"]>,
    readMeshioMetadata: (...args) => callKernel("readMeshioMetadata", args) as ReturnType<Pipeline["readMeshioMetadata"]>,
    readMeshioDataInfo: (...args) => callKernel("readMeshioDataInfo", args) as ReturnType<Pipeline["readMeshioDataInfo"]>,
    runMeshioOps: (...args) => callKernel("runMeshioOps", args) as ReturnType<Pipeline["runMeshioOps"]>,
    loadBRepCachedForDocument: (...args) => callKernel("loadBRepCachedForDocument", args) as Promise<BRepResult>,
    disposeBRepCacheForDocument: (...args) => callKernel("disposeBRepCacheForDocument", args) as Promise<void>,
    readMeshioFieldValues: (...args) => callKernel("readMeshioFieldValues", args) as ReturnType<typeof readMeshioFieldValues>,
    checkMeshHealth: (...args) => callKernel("checkMeshHealth", args) as ReturnType<Pipeline["checkMeshHealth"]>,
    recognizePrimitives: (...args) => callKernel("recognizePrimitives", args) as ReturnType<Pipeline["recognizePrimitives"]>,
    fitMeshRegion: (...args) => callKernel("fitMeshRegion", args) as ReturnType<Pipeline["fitMeshRegion"]>,
    promoteMeshToBrep: (...args) => callKernel("promoteMeshToBrep", args) as ReturnType<Pipeline["promoteMeshToBrep"]>,
    repairMesh: (...args) => callKernel("repairMesh", args) as ReturnType<Pipeline["repairMesh"]>,
    exportSvgSilhouette: (...args) => callKernel("exportSvgSilhouette", args) as ReturnType<Pipeline["exportSvgSilhouette"]>,
    cancelCurrent: killCurrentChild,
  };
}
