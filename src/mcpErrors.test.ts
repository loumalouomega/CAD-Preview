import { describe, it, expect } from "vitest";
import {
  classifyToolError,
  errorToolResult,
  mergeWarningsIntoResult,
  splitUnknownKeys,
  unknownKeyWarnings,
} from "./mcpErrors";
import { nearestName } from "./opCommands";

function named(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  const e = new Error(message);
  e.name = name;
  return Object.assign(e, extra);
}

describe("classifyToolError", () => {
  it("codes the retryable kernel conditions", () => {
    const timeout = classifyToolError(new Error('kernel-worker: "generateMesh" did not respond within 300000ms — the kernel likely hung; killing and respawning the worker.'));
    expect(timeout).toMatchObject({ code: "kernel-timeout", retryable: true });
    expect(timeout.hint).toMatch(/repeat the same call/i);
    expect(classifyToolError(named("JobCancelledError", 'kernel-worker: "x" was cancelled'))).toMatchObject({ code: "job-cancelled", retryable: true });
    expect(classifyToolError(new Error("kernel worker exited unexpectedly (code=null, signal=SIGKILL)"))).toMatchObject({ code: "kernel-crashed", retryable: true });
    expect(classifyToolError(new Error("OCCT crashed (memory access out of bounds) — the kernel has been reset; try the operation again."))).toMatchObject({ code: "kernel-reset", retryable: true });
  });

  it("codes OpenSCAD failures by error class, not message text", () => {
    expect(classifyToolError(named("ScadUnavailableError", "binary not found"))).toMatchObject({ code: "unsupported-source", retryable: false });
    expect(classifyToolError(named("ScadConvertError", "whatever", { kind: "timeout" }))).toMatchObject({ code: "source-timeout", retryable: false });
    expect(classifyToolError(named("ScadConvertError", "whatever", { kind: "failed" }))).toMatchObject({ code: "source-conversion-failed", retryable: false });
  });

  it("codes a dirty buffer, and leaves anything else as a non-retryable tool-error", () => {
    expect(classifyToolError(named("DirtyBufferError", "Not saving x"))).toMatchObject({ code: "dirty-buffer", retryable: false });
    const other = classifyToolError(new Error("Unknown op kind foo"));
    expect(other).toEqual({ code: "tool-error", message: "Unknown op kind foo", retryable: false });
    expect(classifyToolError("plain string").message).toBe("plain string");
  });

  it("does not mistake a digit-bearing application message for a kernel condition", () => {
    expect(classifyToolError(new Error("radius 1000000 is likely too large")).code).toBe("tool-error");
  });
});

describe("errorToolResult", () => {
  it("keeps the original message first and carries the code in structuredContent", () => {
    const r = errorToolResult(new Error("kernel worker exited unexpectedly (code=1, signal=null)"));
    expect(r.isError).toBe(true);
    expect(r.content[0].text.startsWith("kernel worker exited unexpectedly")).toBe(true);
    expect(r.content[0].text).toMatch(/\nHint: /);
    expect(r.structuredContent).toMatchObject({ code: "kernel-crashed", retryable: true });
  });

  it("adds no hint line for an uncoded error", () => {
    expect(errorToolResult(new Error("boom")).content[0].text).toBe("boom");
  });
});

describe("unknown parameters", () => {
  const known = ["path", "outputPath", "overwrite"];

  it("names the nearest declared key for a near-miss and none for a distant one", () => {
    expect(unknownKeyWarnings(["outputPth"], known)).toEqual(['Unknown parameter "outputPth" was ignored — did you mean "outputPath"?']);
    expect(unknownKeyWarnings(["zzzzzzzz"], known)).toEqual(['Unknown parameter "zzzzzzzz" was ignored.']);
    expect(unknownKeyWarnings(["path", "overwrite"], known)).toEqual([]);
  });

  it("splitUnknownKeys hands the handler only declared keys", () => {
    const { kept, unknown } = splitUnknownKeys({ path: "a", outputPth: "b" }, known);
    expect(kept).toEqual({ path: "a" });
    expect(unknown).toEqual(["outputPth"]);
    expect(splitUnknownKeys(undefined, known)).toEqual({ kept: {}, unknown: [] });
  });

  it("merges into an existing warnings array, creates one, or appends a block for non-JSON text", () => {
    const withWarn = mergeWarningsIntoResult({ content: [{ type: "text", text: JSON.stringify({ a: 1, warnings: ["x"] }) }] }, ["y"]);
    expect(JSON.parse(withWarn.content[0].text!)).toEqual({ a: 1, warnings: ["x", "y"] });
    const without = mergeWarningsIntoResult({ content: [{ type: "text", text: JSON.stringify({ a: 1 }) }] }, ["y"]);
    expect(JSON.parse(without.content[0].text!).warnings).toEqual(["y"]);
    const plain = mergeWarningsIntoResult({ content: [{ type: "text", text: "not json" }] }, ["y"]);
    expect(plain.content).toHaveLength(2);
    const none = { content: [{ type: "text", text: "{}" }] };
    expect(mergeWarningsIntoResult(none, [])).toBe(none);
  });

  it("nearestName applies the same near-miss rule as nearestOpKind", () => {
    expect(nearestName("fillt", ["fillet", "chamfer"])).toBe("fillet");
    expect(nearestName("qqqqqq", ["fillet", "chamfer"])).toBeNull();
  });
});
