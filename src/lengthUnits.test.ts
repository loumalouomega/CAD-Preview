import { describe, it, expect } from "vitest";
import { DISPLAY_UNITS, unitScaleFactor, displayUnitFromUnitName, igesUnitName, UNIT_LABELS, type DisplayUnit } from "./lengthUnits";

describe("unitScaleFactor", () => {
  it("mm is the identity factor", () => {
    expect(unitScaleFactor("mm")).toBe(1);
  });

  it("matches known conversions", () => {
    expect(unitScaleFactor("cm")).toBeCloseTo(0.1);
    expect(unitScaleFactor("m")).toBeCloseTo(0.001);
    expect(unitScaleFactor("in")).toBeCloseTo(1 / 25.4);
    expect(unitScaleFactor("ft")).toBeCloseTo(1 / 304.8);
  });

  it("every DISPLAY_UNITS entry has a factor and a label", () => {
    for (const u of DISPLAY_UNITS) {
      expect(Number.isFinite(unitScaleFactor(u))).toBe(true);
      expect(UNIT_LABELS[u]).toBeTruthy();
    }
  });
});

describe("displayUnitFromUnitName", () => {
  it("maps every recognized STEP unit name", () => {
    const cases: Array<[string, DisplayUnit]> = [
      ["MILLIMETRE", "mm"],
      ["CENTIMETRE", "cm"],
      ["METRE", "m"],
      ["INCH", "in"],
      ["FOOT", "ft"],
    ];
    for (const [name, unit] of cases) expect(displayUnitFromUnitName(name)).toBe(unit);
  });

  it("returns undefined for unknown/undefined names", () => {
    expect(displayUnitFromUnitName("PARSEC")).toBeUndefined();
    expect(displayUnitFromUnitName(undefined)).toBeUndefined();
  });
});

describe("igesUnitName", () => {
  it("maps every DisplayUnit to the exact string IGESControl_Writer_2 expects", () => {
    // Verified against the live OCCT WASM: each of these strings, round-tripped
    // through IGESControl_Writer_2 then this codebase's own detectIgesLengthUnit,
    // recovers the matching flag (2/10/6/4/1) — see this function's doc comment.
    expect(igesUnitName("mm")).toBe("MM");
    expect(igesUnitName("cm")).toBe("CM");
    expect(igesUnitName("m")).toBe("M");
    expect(igesUnitName("in")).toBe("IN");
    expect(igesUnitName("ft")).toBe("FT");
  });
});
