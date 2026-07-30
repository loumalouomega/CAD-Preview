import { describe, it, expect } from "vitest";
import { summarizeQuality } from "./meshQuality";

describe("summarizeQuality", () => {
  it("returns an all-zero summary for an empty array", () => {
    expect(summarizeQuality([])).toEqual({ min: 0, mean: 0, histogram: new Array(10).fill(0) });
  });

  it("computes min and mean correctly", () => {
    const s = summarizeQuality([0.2, 0.5, 0.8, 1.0]);
    expect(s.min).toBeCloseTo(0.2);
    expect(s.mean).toBeCloseTo((0.2 + 0.5 + 0.8 + 1.0) / 4);
  });

  it("buckets values into the correct histogram slot", () => {
    // buckets of width 0.1: [0,0.1) [0.1,0.2) ... [0.9,1.0) plus overflow for >=1
    const s = summarizeQuality([0.05, 0.15, 0.95], 10);
    expect(s.histogram[0]).toBe(1); // 0.05
    expect(s.histogram[1]).toBe(1); // 0.15
    expect(s.histogram[9]).toBe(1); // 0.95
    expect(s.histogram.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("clamps a perfect-quality value (1.0) into the last bucket, not an overflow index", () => {
    const s = summarizeQuality([1.0], 10);
    expect(s.histogram[9]).toBe(1);
    expect(s.histogram.length).toBe(10);
  });

  it("clamps negative (inverted-element) values into the first bucket", () => {
    const s = summarizeQuality([-0.5, -1], 10);
    expect(s.histogram[0]).toBe(2);
    expect(s.min).toBeCloseTo(-1);
  });

  it("supports a custom bucket count", () => {
    const s = summarizeQuality([0.05, 0.55, 0.95], 4);
    expect(s.histogram.length).toBe(4);
    expect(s.histogram.reduce((a, b) => a + b, 0)).toBe(3);
  });
});
