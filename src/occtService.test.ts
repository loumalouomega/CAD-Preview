import { describe, it, expect } from "vitest";
import { wrapOcctFault } from "./occtService";

// `wrapOcctFault` is pure error-message dispatch — no WASM call is needed to
// exercise it, unlike the rest of this file's exports. Every other function
// here (`loadBRep`/`exportBRep`/`readShape`) is WASM-touching and, per this
// codebase's established convention (see `gmshService.ts`'s equally-untested
// `isWasmAbort`), exercised only via `npm run mcp:smoke` / manual F5
// verification, not a unit test — genuinely fault-injecting a WASM abort
// isn't something a unit test can safely do.

describe("wrapOcctFault", () => {
  it("recognizes an Emscripten abort message and produces an actionable error", () => {
    const wrapped = wrapOcctFault(new Error("memory access out of bounds"));
    expect(wrapped.message).toMatch(/^OCCT crashed/);
    expect(wrapped.message).toContain("memory access out of bounds");
    expect(wrapped.message).toMatch(/reset/i);
  });

  it("recognizes RuntimeError/unreachable/null function/table index as aborts too", () => {
    for (const raw of ["RuntimeError: abort(...)", "unreachable executed", "null function or function signature mismatch", "table index is out of bounds"]) {
      expect(wrapOcctFault(new Error(raw)).message).toMatch(/^OCCT crashed/);
    }
  });

  it("recognizes the wasmTable abort signature (a JS TypeError from emscripten's glue, not a WebAssembly.Table message)", () => {
    // Real message from an accumulated-pressure abort in this dev
    // environment's perf run — reproduced deterministically at clean HEAD:
    // `wasmTable.get(...) is not a function` matched NONE of the earlier
    // alternatives, leaving the singleton corrupt with no reset. The
    // distinctive token is `wasmTable` (emscripten glue only); a generic
    // "is not a function" is deliberately NOT matched — it's a common JS
    // bug phrase that would misclassify ordinary application errors.
    expect(wrapOcctFault(new Error("wasmTable.get(...) is not a function")).message).toMatch(/^OCCT crashed/);
    expect(wrapOcctFault(new Error("TypeError: WASMTABLE_GET is not a function")).message).toMatch(/^OCCT crashed/);
  });

  it("does NOT match a plain JS 'x is not a function' bug as an abort", () => {
    const original = new Error("foo.bar is not a function");
    expect(wrapOcctFault(original)).toBe(original);
  });

  it("recognizes a bare-digit message — a raw exception pointer with no text at all", () => {
    // Real, reproducible-at-clean-HEAD failure: `npm run mcp:smoke`'s
    // render_ops_prefix block threw a literal `24012480` — an OCCT/Emscripten
    // exception POINTER, not a textual message — which every earlier
    // vocabulary word necessarily missed (there is no word to match). A raw
    // JS number thrown by OCCT has no `.message`; `wrapOcctFault`'s own
    // `String(err)` turns it into exactly this all-digit string.
    expect(wrapOcctFault(24012480).message).toMatch(/^OCCT crashed/);
    expect(wrapOcctFault(24012480).message).toContain("24012480");
  });

  it("does NOT match an ordinary sentence containing digits as an abort", () => {
    // The bare-digit rule must require the WHOLE message to be digits, or it
    // would misclassify any real error that happens to mention a number —
    // e.g. this codebase's own "radius 1000000 is likely too large" diagnostics.
    const original = new Error("the fillet build threw — the radius 1000000 is likely too large for the geometry");
    expect(wrapOcctFault(original)).toBe(original);
  });

  it("leaves an ordinary application error unchanged (same instance, same message)", () => {
    const original = new Error("Unknown entity id: face-99");
    const wrapped = wrapOcctFault(original);
    expect(wrapped).toBe(original);
    expect(wrapped.message).toBe("Unknown entity id: face-99");
  });

  it("wraps a non-Error thrown value into a real Error without matching the abort vocabulary", () => {
    const wrapped = wrapOcctFault("plain string rejection");
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe("plain string rejection");
  });
});
