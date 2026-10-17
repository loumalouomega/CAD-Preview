import { describe, it, expect } from "vitest";
import { sizeMapFromIndicator, lumpedIntegral } from "./adaptSizing";

// Two tets sharing a face: points 0..4.
const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1];
const tets = [0, 1, 2, 3, 1, 2, 3, 4];

describe("sizeMapFromIndicator", () => {
  it("refines the high-indicator cell and keeps the base elsewhere, vertex = min over its cells", () => {
    const r = sizeMapFromIndicator({ positions, tetrahedra: tets, indicator: [1, 0], base: 1, min: 0.1, strength: 4 });
    // mean 0.5, ratio 2 -> h = 1/(1+8) = 0.111; point 4 only touches the quiet cell
    expect(r.sizes[0]).toBeCloseTo(1 / 9, 12);
    expect(r.sizes[1]).toBeCloseTo(1 / 9, 12); // shared vertex takes the finer size
    expect(r.sizes[4]).toBe(1);
    expect(r.range[0]).toBeCloseTo(1 / 9, 12);
  });
  it("floors at min", () => {
    const r = sizeMapFromIndicator({ positions, tetrahedra: tets, indicator: [100, 0], base: 1, min: 0.5, strength: 50 });
    expect(Math.min(...r.sizes)).toBe(0.5);
  });
  it("a flat indicator leaves every vertex at the base size", () => {
    const r = sizeMapFromIndicator({ positions, tetrahedra: tets, indicator: [0, 0], base: 2, min: 0.1 });
    expect([...r.sizes]).toEqual([2, 2, 2, 2, 2]);
  });
  it("rejects a length mismatch, bad bounds, and out-of-range vertices", () => {
    expect(() => sizeMapFromIndicator({ positions, tetrahedra: tets, indicator: [1], base: 1, min: 0.1 })).toThrow(/indicator/);
    expect(() => sizeMapFromIndicator({ positions, tetrahedra: tets, indicator: [1, 1], base: 1, min: 2 })).toThrow(/min/);
    expect(() => sizeMapFromIndicator({ positions, tetrahedra: [0, 1, 2, 9, 1, 2, 3, 4], indicator: [1, 1], base: 1, min: 0.1 })).toThrow(/range/);
  });
});

describe("lumpedIntegral", () => {
  it("is volume times the mean vertex value", () => {
    // unit corner tet volume 1/6; second tet volume |det|/6 with (1,0,0),(0,1,0),(0,0,1) rel. to point 1 ... compute both
    const one = lumpedIntegral(positions, [0, 1, 2, 3], [1, 1, 1, 1]);
    expect(one).toBeCloseTo(1 / 6, 12);
    expect(lumpedIntegral(positions, [0, 1, 2, 3], [0, 4, 0, 0])).toBeCloseTo(1 / 6, 12); // mean 1
  });
});
