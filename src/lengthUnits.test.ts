import { describe, it, expect } from "vitest";
import { DISPLAY_UNITS, unitScaleFactor, displayUnitFromStepName, UNIT_LABELS, type DisplayUnit } from "./lengthUnits";

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

describe("displayUnitFromStepName", () => {
  it("maps every recognized STEP unit name", () => {
    const cases: Array<[string, DisplayUnit]> = [
      ["MILLIMETRE", "mm"],
      ["CENTIMETRE", "cm"],
      ["METRE", "m"],
      ["INCH", "in"],
      ["FOOT", "ft"],
    ];
    for (const [name, unit] of cases) expect(displayUnitFromStepName(name)).toBe(unit);
  });

  it("returns undefined for unknown/undefined names", () => {
    expect(displayUnitFromStepName("PARSEC")).toBeUndefined();
    expect(displayUnitFromStepName(undefined)).toBeUndefined();
  });
});
