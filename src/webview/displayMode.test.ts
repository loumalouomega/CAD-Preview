import { describe, it, expect } from "vitest";
import { DISPLAY_MODES, DISPLAY_MODE_LABELS, isDisplayMode, parseZebra, ZEBRA_COUNT_RANGE } from "./displayMode";

describe("isDisplayMode", () => {
  it("accepts every declared mode", () => {
    for (const mode of DISPLAY_MODES) expect(isDisplayMode(mode)).toBe(true);
  });

  it("rejects unknown strings", () => {
    expect(isDisplayMode("solid")).toBe(false);
    expect(isDisplayMode("")).toBe(false);
  });
});

describe("DISPLAY_MODE_LABELS", () => {
  it("has a label for every mode, and no extras", () => {
    expect(Object.keys(DISPLAY_MODE_LABELS).sort()).toEqual([...DISPLAY_MODES].sort());
  });
});

describe("parseZebra", () => {
  it("accepts a valid setting and clamps/rounds the count", () => {
    expect(parseZebra({ count: 12, axis: "z" })).toEqual({ count: 12, axis: "z" });
    expect(parseZebra({ count: 1000, axis: "x" })).toEqual({ count: ZEBRA_COUNT_RANGE.max, axis: "x" });
    expect(parseZebra({ count: 0.2, axis: "y" })).toEqual({ count: ZEBRA_COUNT_RANGE.min, axis: "y" });
    expect(parseZebra({ count: 7.6, axis: "y" })).toEqual({ count: 8, axis: "y" });
  });
  it("rejects anything unusable instead of throwing", () => {
    for (const bad of [null, undefined, 3, "x", {}, { count: "8", axis: "y" }, { count: NaN, axis: "y" }, { count: 8, axis: "w" }]) {
      expect(parseZebra(bad)).toBeUndefined();
    }
  });
});
