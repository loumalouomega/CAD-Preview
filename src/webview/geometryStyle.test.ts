import { describe, expect, it } from "vitest";
import { solidColor, solidIndexOf } from "./geometryStyle";

describe("solidColor", () => {
  it("is deterministic", () => {
    expect(solidColor(3)).toBe(solidColor(3));
  });
  it("gives the first twelve solids distinct colours", () => {
    const set = new Set(Array.from({ length: 12 }, (_, i) => solidColor(i)));
    expect(set.size).toBe(12);
  });
  it("stays a valid 24-bit colour and tolerates junk", () => {
    for (const i of [0, 1, 7, 99, -4, NaN, 2.7]) {
      const c = solidColor(i);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(0xffffff);
    }
  });
  it("index 0 is the pure hue-0 red family", () => {
    const c = solidColor(0);
    expect(c >> 16).toBeGreaterThan((c >> 8) & 255);
  });
});

describe("solidIndexOf", () => {
  it("reads the trailing number", () => {
    expect(solidIndexOf("solid-12")).toBe(12);
  });
  it("defaults to 0", () => {
    expect(solidIndexOf(undefined)).toBe(0);
    expect(solidIndexOf("x")).toBe(0);
  });
});
