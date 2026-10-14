import { describe, expect, it } from "vitest";
import { densityForMaterial, massGrams, totalMass, validateDensity } from "./materialDensity";

describe("materialDensity", () => {
  it("a 10 mm steel cube at 7.85 g/cm3 is 7.85 g", () => {
    expect(massGrams(1000, 7.85)).toBeCloseTo(7.85, 12);
  });
  it("looks materials up case-insensitively, accepting the US spelling", () => {
    expect(densityForMaterial("Steel")).toBe(7.85);
    expect(densityForMaterial(" Aluminum ")).toBe(2.7);
    expect(densityForMaterial("unobtainium")).toBeUndefined();
  });
  it("validates density", () => {
    expect(validateDensity(1.2)).toBe(1.2);
    for (const bad of [0, -1, NaN, Infinity, "7", null, undefined]) expect(validateDensity(bad)).toBeUndefined();
  });
  it("sums a two-material assembly", () => {
    const t = totalMass([{ name: "a", mass: massGrams(1000, 7.85) }, { name: "b", mass: massGrams(2000, 2.7) }]);
    expect(t.total).toBeCloseTo(7.85 + 5.4, 12);
    expect(t.missing).toEqual([]);
  });
  it("reports a part with no density as missing rather than zero", () => {
    const t = totalMass([{ name: "a", mass: 7.85 }, { name: "b", mass: null }]);
    expect(t.total).toBeNull();
    expect(t.missing).toEqual(["b"]);
  });
});
