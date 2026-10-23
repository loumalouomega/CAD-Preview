import { describe, it, expect } from "vitest";
import { normalizeDecimalComma } from "./localeNumber";
import { evalExpr } from "./paramExpr";

function norm(s: string): string {
  const r = normalizeDecimalComma(s);
  if (!r.ok) throw new Error(r.error);
  return r.text;
}

describe("normalizeDecimalComma", () => {
  it("leaves dot-decimal and comma-free input unchanged", () => {
    for (const s of ["1.5", "42", "-3", "2*pi", "x+1", ""]) expect(norm(s)).toBe(s);
  });
  it("reads a plain decimal comma as a dot", () => {
    expect(norm("1,5")).toBe("1.5");
    expect(norm("-0,25")).toBe("-0.25");
    expect(norm(" 1,5e3 ")).toBe("1.5e3");
    const r = evalExpr(norm("1,5"), {});
    expect(r.ok && r.value).toBe(1.5);
  });
  it("never treats a comma as a thousands separator", () => {
    expect(norm("1,234")).toBe("1.234");
  });
  it("keeps function-argument commas untouched", () => {
    expect(norm("max(1,5)")).toBe("max(1,5)");
    const r = evalExpr(norm("max(1,5)"), {});
    expect(r.ok && r.value).toBe(5);
  });
  it("rejects a bare comma inside an expression, naming the rule", () => {
    for (const s of ["1,5+2", "1,5,2", "a,5", "1,"]) {
      const r = normalizeDecimalComma(s);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/decimal separator/);
    }
  });
});
