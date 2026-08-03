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
});
