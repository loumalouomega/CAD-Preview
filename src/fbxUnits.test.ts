import { describe, expect, it } from "vitest";
import { fbxDeclaredUnit, fbxMmPerUnit } from "./fbxUnits";

describe("fbxMmPerUnit", () => {
  it("converts the centimetre-based factor to millimetres", () => {
    expect(fbxMmPerUnit(1)).toBe(10);
    expect(fbxMmPerUnit(0.1)).toBeCloseTo(1, 12);
    expect(fbxMmPerUnit(100)).toBe(1000);
    expect(fbxMmPerUnit(2.54)).toBeCloseTo(25.4, 12);
  });

  it("falls back to centimetres for a missing or unusable factor", () => {
    for (const bad of [undefined, null, 0, -1, NaN, Infinity, "1"]) expect(fbxMmPerUnit(bad)).toBe(10);
  });
});

describe("fbxDeclaredUnit", () => {
  it("names the matching display unit", () => {
    expect(fbxDeclaredUnit(0.1)).toBe("mm");
    expect(fbxDeclaredUnit(100)).toBe("m");
    expect(fbxDeclaredUnit(2.54)).toBe("in");
    expect(fbxDeclaredUnit(30.48)).toBe("ft");
  });

  it("leaves the dropdown alone for the default, an absent or an unlisted factor", () => {
    expect(fbxDeclaredUnit(1)).toBeUndefined();
    expect(fbxDeclaredUnit(undefined)).toBeUndefined();
    expect(fbxDeclaredUnit(7)).toBeUndefined();
  });
});
