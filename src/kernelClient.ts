/**
 * Parent-side IPC client for the kernel-worker child process (roadmap "OCCT
 * in a forked child process", Phase 0+1 — see CLAUDE.md). `createKernelClient
 * (extensionPath)` returns an object satisfying the exact same `Pipeline`
 * interface `mcpTools.ts` already consumes (`mcpServer.ts`'s own `Pipeline`
 * object literal used to import the 21 functions directly from
 * `occtService.ts`/`gmshService.ts`/etc. — this is a drop-in replacement,
 * `mcpTools.ts` needs no changes), plus one extra method, `cancelCurrent()`,
 * for real (process-kill) cancellation.
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

export interface KernelClient extends Pipeline {
  /** Kills the current child (SIGKILL) — real interruption, not just a
   * discarded result. Any request already sent to it rejects immediately;
   * the NEXT call transparently spawns a fresh child. A no-op if no child is
   * currently running. */
  cancelCurrent(): void;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** Creates one independent kernel-worker child + its own request queue. Each caller (the interactive extension host, an MCP server instance) gets its own — no cross-process sharing/daemon. */
export function createKernelClient(extensionPath: string): KernelClient {
  let child: ChildProcess | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingEntry>();
  // A single-slot chain: each new call's request is only SENT after the
  // previous one has settled (resolved or rejected) — see the file doc
  // comment for why serializing is both correct and sufficient here.
  let queueTail: Promise<unknown> = Promise.resolve();

  function rejectAllPending(err: Error): void {
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
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
      const entry = pending.get(msg.id);
      if (!entry) return; // a response for a request we've already given up on (e.g. after cancelCurrent) — ignore
      pending.delete(msg.id);
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
        pending.set(id, { resolve, reject });
        const request: KernelRequest = { id, fn, args: args.map(marshal) };
        getChild().send(request, (err) => {
          if (err) {
            pending.delete(id);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
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
    getEntityFacts: (...args) => callKernel("getEntityFacts", args) as ReturnType<Pipeline["getEntityFacts"]>,
    measureEntities: (...args) => callKernel("measureEntities", args) as ReturnType<Pipeline["measureEntities"]>,
    measureExact: (...args) => callKernel("measureExact", args) as ReturnType<Pipeline["measureExact"]>,
    checkInterference: (...args) => callKernel("checkInterference", args) as ReturnType<Pipeline["checkInterference"]>,
    rebindPartsAcrossOps: (...args) => callKernel("rebindPartsAcrossOps", args) as ReturnType<Pipeline["rebindPartsAcrossOps"]>,
    renderSnapshot: (...args) => callKernel("renderSnapshot", args) as ReturnType<Pipeline["renderSnapshot"]>,
    isRenderAvailable: (...args) => callKernel("isRenderAvailable", args) as ReturnType<Pipeline["isRenderAvailable"]>,
    searchStandardParts: (...args) => callKernel("searchStandardParts", args) as ReturnType<Pipeline["searchStandardParts"]>,
    downloadStandardPart: (...args) => callKernel("downloadStandardPart", args) as ReturnType<Pipeline["downloadStandardPart"]>,
    compareModels: (...args) => callKernel("compareModels", args) as ReturnType<Pipeline["compareModels"]>,
    convertToStlBoundary: (...args) => callKernel("convertToStlBoundary", args) as ReturnType<Pipeline["convertToStlBoundary"]>,
    convertToStlBoundaryWithRegions: (...args) =>
      callKernel("convertToStlBoundaryWithRegions", args) as ReturnType<Pipeline["convertToStlBoundaryWithRegions"]>,
    exportViaMeshio: (...args) => callKernel("exportViaMeshio", args) as ReturnType<Pipeline["exportViaMeshio"]>,
    readMeshioMetadata: (...args) => callKernel("readMeshioMetadata", args) as ReturnType<Pipeline["readMeshioMetadata"]>,
    cancelCurrent(): void {
      if (child) child.kill("SIGKILL"); // onGone (the 'exit' handler) rejects pending + clears `child` for the next call
    },
  };
}
