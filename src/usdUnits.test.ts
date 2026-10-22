import { describe, expect, it } from "vitest";
import { usdDeclaredUnit, usdMmPerUnit } from "./usdUnits";

describe("usdMmPerUnit", () => {
  it("converts metersPerUnit to millimetres", () => {
    expect(usdMmPerUnit(1)).toBe(1000);
    expect(usdMmPerUnit(0.001)).toBeCloseTo(1, 12);
    expect(usdMmPerUnit(0.01)).toBeCloseTo(10, 12);
    expect(usdMmPerUnit(0.0254)).toBeCloseTo(25.4, 12);
  });
  it("falls back to metres for an unusable value, never NaN", () => {
    for (const bad of [0, -1, NaN, Infinity]) expect(usdMmPerUnit(bad)).toBe(1000);
  });
});

describe("usdDeclaredUnit", () => {
  it("maps each listed unit", () => {
    expect(usdDeclaredUnit(0.001)).toBe("mm");
    expect(usdDeclaredUnit(0.01)).toBe("cm");
    expect(usdDeclaredUnit(0.0254)).toBe("in");
    expect(usdDeclaredUnit(0.3048)).toBe("ft");
  });
  it("is undefined for 1 (undeclared), an unlisted unit, or garbage", () => {
    expect(usdDeclaredUnit(1)).toBeUndefined();
    expect(usdDeclaredUnit(0.000001)).toBeUndefined();
    expect(usdDeclaredUnit(NaN)).toBeUndefined();
  });
});
