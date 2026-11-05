import { describe, it, expect } from "vitest";
import { NAVIGATION_PRESETS, normalizeNavigationPreset, wheelBehaviourOf, wheelDeltaPixels, wheelPanOffset } from "./navigationPresets";

describe("navigation presets", () => {
  it("default keeps the long-standing mapping", () => {
    expect(NAVIGATION_PRESETS.default).toEqual({ left: "rotate", middle: "dolly", right: "pan" });
  });
  it("fusion pans on the middle button and frees the left and right ones", () => {
    expect(NAVIGATION_PRESETS.fusion).toEqual({ left: "none", middle: "pan", right: "none" });
  });
  it("touchpad keeps orbit on the left button and pans on a plain wheel", () => {
    expect(NAVIGATION_PRESETS.touchpad).toEqual({ left: "rotate", middle: "pan", right: "pan", wheel: "pan" });
    expect(wheelBehaviourOf("touchpad")).toBe("pan");
    expect(wheelBehaviourOf("default")).toBe("zoom");
    expect(wheelBehaviourOf("fusion")).toBe("zoom");
    expect(normalizeNavigationPreset("touchpad")).toBe("touchpad");
  });
  it("normalises the wheel delta mode to pixels", () => {
    expect(wheelDeltaPixels(3, -4, 0)).toEqual([3, -4]);
    expect(wheelDeltaPixels(1, 2, 1)).toEqual([16, 32]);
    expect(wheelDeltaPixels(1, 1, 2)).toEqual([400, 400]);
  });
  it("scrolls the content with the fingers at 1:1 on screen", () => {
    // 100 world units visible over 500 px: 5 px of scroll is 1 unit.
    const o = wheelPanOffset(5, 10, 0, 100, 500);
    expect(o.right).toBeCloseTo(1, 12);
    expect(o.up).toBeCloseTo(-2, 12); // scroll down => camera moves down
    expect(wheelPanOffset(0, -10, 0, 100, 500).up).toBeCloseTo(2, 12);
    expect(wheelPanOffset(5, 5, 0, 0, 500)).toEqual({ right: 0, up: 0 });
    expect(wheelPanOffset(5, 5, 0, 100, 0)).toEqual({ right: 0, up: 0 });
  });
  it("normalizes unknown values to default", () => {
    expect(normalizeNavigationPreset("fusion")).toBe("fusion");
    expect(normalizeNavigationPreset("maya")).toBe("default");
    expect(normalizeNavigationPreset(3)).toBe("default");
  });
});
