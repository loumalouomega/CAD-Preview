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
