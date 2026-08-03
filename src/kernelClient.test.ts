import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// A fake ChildProcess: records every `.send()` call so a test can reply by
// emitting a "message" event, and tracks `.kill()` calls without spawning a
// real process — the request/response correlation + queueing logic in
// kernelClient.ts is pure control flow over these events, so it's fully
// testable without a real dist/kernel-worker.js or WASM (that's what the
// Phase 0 spike script + npm run mcp:smoke cover instead).
interface SentRequest {
  id: number;
  fn: string;
  args: unknown[];
}

class FakeChild extends EventEmitter {
  sent: SentRequest[] = [];
  killed: string[] = [];
  stderr = new EventEmitter();
  send(msg: unknown, cb?: (err?: Error) => void): boolean {
    this.sent.push(msg as SentRequest);
    cb?.();
    return true;
  }
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    // Real child_process semantics: killing fires 'exit', not a direct callback.
    queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
    return true;
  }
}

let fakeChildren: FakeChild[] = [];

vi.mock("child_process", () => ({
  fork: vi.fn(() => {
    const c = new FakeChild();
    fakeChildren.push(c);
    return c;
  }),
}));

// Imported AFTER the mock is registered (vi.mock is hoisted by vitest, so
// this static import already sees the mocked module).
const { createKernelClient } = await import("./kernelClient");

function reply(child: FakeChild, id: number, result: unknown): void {
  child.emit("message", { id, ok: true, result });
}
function replyError(child: FakeChild, id: number, message: string): void {
  child.emit("message", { id, ok: false, error: { message } });
}
function lastRequest(child: FakeChild): SentRequest {
  return child.sent[child.sent.length - 1];
}

beforeEach(() => {
  fakeChildren = [];
});

describe("createKernelClient", () => {
  it("lazily spawns a child only on the first call, not at creation", () => {
    createKernelClient("/ext");
    expect(fakeChildren).toHaveLength(0);
  });

  it("sends a request and resolves with the unmarshaled result", async () => {
    const client = createKernelClient("/ext");
    const promise = client.isRenderAvailable();
    await Promise.resolve(); // let the queued `run()` execute
    const child = fakeChildren[0];
    const req = lastRequest(child);
    expect(req.fn).toBe("isRenderAvailable");
    reply(child, req.id, { available: true });
    await expect(promise).resolves.toEqual({ available: true });
  });

  it("rejects the caller when the child replies with ok:false", async () => {
    const client = createKernelClient("/ext");
    const promise = client.isRenderAvailable();
    await Promise.resolve();
    const child = fakeChildren[0];
    const req = lastRequest(child);
    replyError(child, req.id, "boom");
    await expect(promise).rejects.toThrow("boom");
  });

  it("serializes two calls — the second is not sent until the first settles", async () => {
    const client = createKernelClient("/ext");
    const p1 = client.isRenderAvailable();
    const p2 = client.isRenderAvailable();
    await Promise.resolve();
    await Promise.resolve();
    const child = fakeChildren[0];
    expect(child.sent).toHaveLength(1); // only the first request has been sent so far
    reply(child, child.sent[0].id, { available: true });
    await p1;
    await Promise.resolve();
    await Promise.resolve();
    expect(child.sent).toHaveLength(2); // now the second was sent
    reply(child, child.sent[1].id, { available: false });
    await expect(p2).resolves.toEqual({ available: false });
  });

  it("reuses the same child across multiple calls (no respawn on every call)", async () => {
    const client = createKernelClient("/ext");
    const p1 = client.isRenderAvailable();
    await Promise.resolve();
    reply(fakeChildren[0], fakeChildren[0].sent[0].id, { available: true });
    await p1;
    const p2 = client.isRenderAvailable();
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeChildren).toHaveLength(1);
    reply(fakeChildren[0], fakeChildren[0].sent[1].id, { available: true });
    await p2;
  });

  it("a rejected call does not wedge the queue for the next call", async () => {
    const client = createKernelClient("/ext");
    const p1 = client.isRenderAvailable();
    await Promise.resolve();
    const child = fakeChildren[0];
    replyError(child, child.sent[0].id, "first failed");
    await expect(p1).rejects.toThrow("first failed");
    const p2 = client.isRenderAvailable();
    await Promise.resolve();
    await Promise.resolve();
    expect(child.sent).toHaveLength(2);
    reply(child, child.sent[1].id, { available: true });
    await expect(p2).resolves.toEqual({ available: true });
  });

  it("cancelCurrent kills the child and rejects any pending request", async () => {
    const client = createKernelClient("/ext");
    const promise = client.isRenderAvailable();
    await Promise.resolve();
    const child = fakeChildren[0];
    client.cancelCurrent();
    await expect(promise).rejects.toThrow();
    expect(child.killed).toEqual(["SIGKILL"]);
  });

  it("a fresh child is spawned for the call after cancelCurrent", async () => {
    const client = createKernelClient("/ext");
    const p1 = client.isRenderAvailable();
    await Promise.resolve();
    client.cancelCurrent();
    await expect(p1).rejects.toThrow();
    await Promise.resolve(); // let the exit-triggered cleanup run
    const p2 = client.isRenderAvailable();
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeChildren).toHaveLength(2);
    reply(fakeChildren[1], fakeChildren[1].sent[0].id, { available: true });
    await expect(p2).resolves.toEqual({ available: true });
  });

  it("an unexpected child exit rejects any still-pending request", async () => {
    const client = createKernelClient("/ext");
    const promise = client.isRenderAvailable();
    await Promise.resolve();
    const child = fakeChildren[0];
    child.emit("exit", 1, null);
    await expect(promise).rejects.toThrow(/exited unexpectedly/);
  });

  it("two independently created clients each get their own child", async () => {
    const clientA = createKernelClient("/ext-a");
    const clientB = createKernelClient("/ext-b");
    const pA = clientA.isRenderAvailable();
    const pB = clientB.isRenderAvailable();
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeChildren).toHaveLength(2);
    reply(fakeChildren[0], fakeChildren[0].sent[0].id, { available: true });
    reply(fakeChildren[1], fakeChildren[1].sent[0].id, { available: false });
    await expect(pA).resolves.toEqual({ available: true });
    await expect(pB).resolves.toEqual({ available: false });
  });

  describe("the 3 document-cache-aware DocumentPipeline methods (Phase 2)", () => {
    it("loadBRepCachedForDocument sends the documentKey as the first arg and resolves with the result", async () => {
      const client = createKernelClient("/ext");
      const promise = client.loadBRepCachedForDocument("file:///a.stp", "/ext", new Uint8Array([1, 2, 3]), "step", []);
      await Promise.resolve();
      const child = fakeChildren[0];
      const req = lastRequest(child);
      expect(req.fn).toBe("loadBRepCachedForDocument");
      expect(req.args[0]).toBe("file:///a.stp"); // the documentKey, plain string, no marshaling needed
      reply(child, req.id, { groups: [], edges: [], points: [], tree: { id: "root", label: "root" } });
      await expect(promise).resolves.toEqual({ groups: [], edges: [], points: [], tree: { id: "root", label: "root" } });
    });

    it("disposeBRepCacheForDocument sends the documentKey and resolves", async () => {
      const client = createKernelClient("/ext");
      const promise = client.disposeBRepCacheForDocument("file:///a.stp");
      await Promise.resolve();
      const child = fakeChildren[0];
      const req = lastRequest(child);
      expect(req.fn).toBe("disposeBRepCacheForDocument");
      expect(req.args[0]).toBe("file:///a.stp");
      reply(child, req.id, undefined);
      await expect(promise).resolves.toBeUndefined();
    });

    it("readMeshioFieldValues round-trips like any other Pipeline call", async () => {
      const client = createKernelClient("/ext");
      const promise = client.readMeshioFieldValues(new Uint8Array([9]), "vtk", "Temperature", "point");
      await Promise.resolve();
      const child = fakeChildren[0];
      const req = lastRequest(child);
      expect(req.fn).toBe("readMeshioFieldValues");
      reply(child, req.id, null);
      await expect(promise).resolves.toBeNull();
    });
  });

  // Real (tiny) timeouts rather than vi.useFakeTimers() — simpler and avoids
  // fake-timer/microtask-ordering interactions with the queue's own
  // Promise-chain sequencing; a few tens of real milliseconds per test is
  // negligible for this suite's overall runtime.
  describe("the per-call watchdog timeout (Phase 3)", () => {
    it("rejects and kills the child when it never responds within timeoutMs", async () => {
      const client = createKernelClient("/ext", { timeoutMs: 20 });
      const promise = client.isRenderAvailable();
      await expect(promise).rejects.toThrow(/did not respond within 20ms/);
      const child = fakeChildren[0];
      expect(child.sent).toHaveLength(1);
      expect(child.killed).toEqual(["SIGKILL"]);
    });

    it("a late response after the timeout already fired is ignored, not a double-settle", async () => {
      const client = createKernelClient("/ext", { timeoutMs: 20 });
      const promise = client.isRenderAvailable();
      await expect(promise).rejects.toThrow(/did not respond/);
      const child = fakeChildren[0];
      const req = lastRequest(child);
      // The (now-irrelevant) real child eventually "replies" after all — must not throw.
      expect(() => reply(child, req.id, { available: true })).not.toThrow();
    });

    it("does not fire the watchdog for a call that responds well within timeoutMs", async () => {
      const client = createKernelClient("/ext", { timeoutMs: 5000 });
      const promise = client.isRenderAvailable();
      await Promise.resolve();
      const child = fakeChildren[0];
      reply(child, lastRequest(child).id, { available: true });
      await expect(promise).resolves.toEqual({ available: true });
      expect(child.killed).toEqual([]);
    });

    it("defaults to a generous timeout when none is configured", async () => {
      const client = createKernelClient("/ext");
      const promise = client.isRenderAvailable();
      await Promise.resolve();
      const child = fakeChildren[0];
      reply(child, lastRequest(child).id, { available: true });
      await expect(promise).resolves.toEqual({ available: true });
      expect(child.killed).toEqual([]);
    });
  });
});
