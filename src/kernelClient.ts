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
import {
  KERNELS_BY_FUNCTION,
  initialKernelState,
  reduceKernelState,
  type KernelEvent,
  type KernelState,
} from "./kernelActivity";
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

/** Per-call scoping for the kernel queue (roadmap "Document-scoped jobs and
 * cancellation"). `owner` groups jobs so one tab's Cancel can never touch
 * another tab's work; `signal` (an MCP request's `extra.signal`) cancels the
 * job when it aborts; `timeoutMs` overrides the client-wide watchdog. */
export interface JobOptions {
  owner?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type JobState = "queued" | "running";

export interface JobInfo {
  jobId: number;
  fn: string;
  owner: string | null;
  state: JobState;
}

/** Rejection used for a job that was cancelled — queued jobs are rejected
 * with this WITHOUT ever being sent to the worker. */
export class JobCancelledError extends Error {
  constructor(readonly fn: string) {
    super(`kernel-worker: "${fn}" was cancelled`);
    this.name = "JobCancelledError";
  }
}

/** A `DocumentPipeline` whose every call carries the same `JobOptions`, plus
 * `cancel()` for exactly that owner's jobs. */
export interface ScopedPipeline extends DocumentPipeline {
  readonly owner: string | null;
  cancel(): void;
}

export interface KernelClient extends DocumentPipeline {
  /** Kills whichever job is RUNNING right now (SIGKILL — real interruption,
   * not a discarded result), regardless of owner. Queued jobs are untouched
   * and dispatch to a freshly-spawned child. Prefer `cancel({owner})`. */
  cancelCurrent(): void;
  /** Cancels the matching jobs: a queued match is removed and rejected with
   * `JobCancelledError` without ever being sent; a running match is rejected
   * the same way and its child killed. Non-matching jobs are untouched (a
   * non-matching RUNNING job is never killed). Returns how many matched. */
  cancel(match: { owner?: string; jobId?: number }): number;
  /** Returns a pipeline whose calls all carry `opts` (see `JobOptions`). */
  withJob(opts: JobOptions): ScopedPipeline;
  /** Snapshot of queued + running jobs, running first. */
  jobs(): JobInfo[];
  /** Subscribes to job-list changes; returns an unsubscribe. */
  onJobs(listener: (jobs: JobInfo[]) => void): () => void;
  /** The kernels' inferred readiness (see `kernelActivity.ts`) — a snapshot. */
  kernelState(): KernelState;
  /** Subscribes to readiness changes; returns an unsubscribe. Fires only when
   * the state actually changed. `mcpServer.ts` never subscribes. */
  onKernelState(listener: (state: KernelState) => void): () => void;
}

interface Job {
  jobId: number;
  fn: string;
  args: unknown[];
  owner: string | null;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  state: JobState;
  /** Set once sent: the request id, the child it went to, and its watchdog. */
  requestId?: number;
  proc?: ChildProcess;
  timer?: ReturnType<typeof setTimeout>;
  cleanupSignal?: () => void;
  settled: boolean;
}

/** No real operation should ever take this long — `scripts/perf/baseline.json`'s
 * xlarge fixture (2.3 MB STEP) is ~14s to load / ~27s to mesh, so 5 minutes
 * leaves enormous headroom for legitimately large files while still catching
 * the documented GMSH-3D-algorithm-hangs-indefinitely failure mode (CLAUDE.md's
 * Meshing section) in bounded time instead of never. */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Every kernel function name, taken from the compile-time-complete
 * `KERNELS_BY_FUNCTION` table (a missing key there is already a type error). */
const KERNEL_FUNCTIONS = Object.keys(KERNELS_BY_FUNCTION) as (keyof DocumentPipeline)[];

/** Creates one independent kernel-worker child + its own request queue. Each caller (the interactive extension host, an MCP server instance) gets its own — no cross-process sharing/daemon. */
export function createKernelClient(extensionPath: string, options?: { timeoutMs?: number }): KernelClient {
  const defaultTimeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let child: ChildProcess | null = null;
  let nextRequestId = 1;
  let nextJobId = 1;
  // One job runs at a time (the kernels are single-threaded per process);
  // the rest wait in `queue`, in order. Explicit rather than a promise chain
  // so a queued job can be removed before it is ever sent.
  const queue: Job[] = [];
  let active: Job | null = null;
  // Kernel readiness is INFERRED from calls (kernelActivity.ts explains why).
  let kernels: KernelState = initialKernelState();
  const kernelListeners = new Set<(state: KernelState) => void>();
  const jobListeners = new Set<(jobs: JobInfo[]) => void>();
  function emit(ev: KernelEvent): void {
    const next = reduceKernelState(kernels, ev);
    if (next === kernels) return;
    kernels = next;
    for (const l of [...kernelListeners]) l(kernels);
  }
  function snapshot(): JobInfo[] {
    const all = active ? [active, ...queue] : [...queue];
    return all.map((j) => ({ jobId: j.jobId, fn: j.fn, owner: j.owner, state: j.state }));
  }
  function emitJobs(): void {
    if (jobListeners.size === 0) return;
    const s = snapshot();
    for (const l of [...jobListeners]) l(s);
  }

  /** The ONE settlement path for a job: a response, a timeout, a send
   * error, a child exit or a cancel all come through here, so a promise can
   * never settle twice and a timer can never outlive its job. */
  function settle(job: Job, outcome: { ok: true; value: unknown } | { ok: false; error: Error }): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    job.cleanupSignal?.();
    const wasRunning = job === active;
    if (wasRunning) active = null;
    else {
      const i = queue.indexOf(job);
      if (i >= 0) queue.splice(i, 1);
    }
    if (job.state === "running") emit(outcome.ok ? { type: "success", fn: job.fn } : { type: "failure", fn: job.fn });
    if (outcome.ok) job.resolve(outcome.value);
    else job.reject(outcome.error);
    emitJobs();
    if (wasRunning) pump();
  }

  /** Detaches the current child (the NEXT dispatch spawns a fresh one) and
   * kills it. Detaching first means a queued job dispatched right after a
   * kill can never be sent to the dying process. */
  function killChild(proc: ChildProcess | undefined | null): void {
    if (!proc) return;
    if (child === proc) child = null;
    proc.kill("SIGKILL");
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
      const job = active;
      // A response for a request we've already given up on (timeout/cancel) — ignore.
      if (!job || job.requestId !== msg.id || job.proc !== spawned) return;
      if (msg.ok) settle(job, { ok: true, value: unmarshal(msg.result) });
      else settle(job, { ok: false, error: new Error(msg.error.message) });
    });
    let gone = false;
    const onGone = (err: Error) => {
      if (gone) return;
      gone = true;
      if (child === spawned) child = null; // let the NEXT dispatch respawn
      emit({ type: "reset" }); // the kernels died with the child
      // Only the job that was actually running ON THIS CHILD fails; queued
      // jobs were never sent and dispatch to the respawned child.
      if (active && active.proc === spawned) settle(active, { ok: false, error: err });
    };
    spawned.on("exit", (code, signal) => onGone(new Error(`kernel worker exited unexpectedly (code=${code}, signal=${signal})`)));
    spawned.on("error", onGone);
    child = spawned;
    return spawned;
  }

  function pump(): void {
    if (active || queue.length === 0) return;
    const job = queue.shift()!;
    active = job;
    job.state = "running";
    const requestId = nextRequestId++;
    job.requestId = requestId;
    job.timer = setTimeout(() => {
      const proc = job.proc;
      if (proc && child === proc) child = null; // detach BEFORE settle pumps the next job
      settle(job, {
        ok: false,
        error: new Error(
          `kernel-worker: "${job.fn}" did not respond within ${job.timeoutMs}ms — the kernel likely hung; killing and respawning the worker.`
        ),
      });
      killChild(proc);
    }, job.timeoutMs);
    emit({ type: "start", fn: job.fn });
    emitJobs();
    let proc: ChildProcess;
    try {
      proc = getChild();
    } catch (err) {
      settle(job, { ok: false, error: err instanceof Error ? err : new Error(String(err)) });
      return;
    }
    job.proc = proc;
    const request: KernelRequest = { id: requestId, fn: job.fn, args: job.args.map(marshal) };
    proc.send(request, (err) => {
      if (err) settle(job, { ok: false, error: err instanceof Error ? err : new Error(String(err)) });
    });
  }

  function cancelJob(job: Job): void {
    const proc = job.state === "running" ? job.proc : undefined;
    if (proc && child === proc) child = null; // detach BEFORE settle pumps the next job
    settle(job, { ok: false, error: new JobCancelledError(job.fn) });
    killChild(proc);
  }

  function callKernel(fn: string, args: unknown[], opts?: JobOptions): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const job: Job = {
        jobId: nextJobId++,
        fn,
        args,
        owner: opts?.owner ?? null,
        timeoutMs: opts?.timeoutMs ?? defaultTimeoutMs,
        resolve,
        reject,
        state: "queued",
        settled: false,
      };
      const signal = opts?.signal;
      if (signal?.aborted) {
        reject(new JobCancelledError(fn));
        return;
      }
      if (signal) {
        const onAbort = () => cancelJob(job);
        signal.addEventListener("abort", onAbort, { once: true });
        job.cleanupSignal = () => signal.removeEventListener("abort", onAbort);
      }
      queue.push(job);
      emitJobs();
      pump();
    });
  }

  function cancel(match: { owner?: string; jobId?: number }): number {
    const matches = (j: Job) =>
      (match.jobId === undefined || j.jobId === match.jobId) && (match.owner === undefined || j.owner === match.owner);
    if (match.jobId === undefined && match.owner === undefined) return 0;
    const hits = [...queue.filter(matches), ...(active && matches(active) ? [active] : [])];
    for (const j of hits) cancelJob(j);
    return hits.length;
  }

  function methods(opts?: JobOptions): DocumentPipeline {
    const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const fn of KERNEL_FUNCTIONS) out[fn] = (...args: unknown[]) => callKernel(fn, args, opts);
    return out as unknown as DocumentPipeline;
  }

  return {
    ...methods(),
    cancelCurrent: () => {
      if (active) cancelJob(active);
      else killChild(child); // nothing running: still recycle the idle child (old contract)
    },
    cancel,
    withJob: (opts) => ({
      ...methods(opts),
      owner: opts.owner ?? null,
      cancel: () => {
        if (opts.owner !== undefined) cancel({ owner: opts.owner });
      },
    }),
    jobs: snapshot,
    onJobs: (listener) => {
      jobListeners.add(listener);
      return () => void jobListeners.delete(listener);
    },
    kernelState: () => kernels,
    onKernelState: (listener) => {
      kernelListeners.add(listener);
      return () => void kernelListeners.delete(listener);
    },
  };
}
