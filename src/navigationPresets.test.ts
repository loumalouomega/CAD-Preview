import { describe, it, expect } from "vitest";
import { NAVIGATION_PRESETS, normalizeNavigationPreset } from "./navigationPresets";

describe("navigation presets", () => {
  it("default keeps the long-standing mapping", () => {
    expect(NAVIGATION_PRESETS.default).toEqual({ left: "rotate", middle: "dolly", right: "pan" });
  });
  it("fusion pans on the middle button and frees the left and right ones", () => {
    expect(NAVIGATION_PRESETS.fusion).toEqual({ left: "none", middle: "pan", right: "none" });
  });
  it("normalizes unknown values to default", () => {
    expect(normalizeNavigationPreset("fusion")).toBe("fusion");
    expect(normalizeNavigationPreset("maya")).toBe("default");
    expect(normalizeNavigationPreset(3)).toBe("default");
  });
});
