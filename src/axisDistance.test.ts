import { describe, expect, it } from "vitest";
import { axisDistance } from "./axisDistance";

describe("infinite axis distance", () => {
  it("handles parallel, opposite, and coaxial axes independent of axial placement", () => {
    expect(axisDistance([0,0,0], [0,0,2], [3,4,100], [0,0,-3])).toBe(5);
    expect(axisDistance([0,0,0], [0,0,1], [0,0,100], [0,0,1])).toBe(0);
  });
  it("handles intersecting and skew lines", () => {
    expect(axisDistance([10,20,30], [1,0,0], [10,20,30], [0,1,0])).toBe(0);
    expect(axisDistance([10,20,30], [1,0,0], [10,20,37], [0,1,0])).toBe(7);
  });
  it("normalizes directions and rejects bad input", () => {
    expect(axisDistance([0,0,0], [0,0,5], [3,4,0], [0,0,-2])).toBe(5);
    expect(axisDistance([0,0,0], [1,1,0], [0,0,3], [-2,-2,0])).toBe(3);
    expect(() => axisDistance([0,0,0], [0,0,0], [1,1,1], [1,0,0])).toThrow();
    expect(() => axisDistance([0,0,0], [NaN,0,0], [1,1,1], [1,0,0])).toThrow();
    expect(() => axisDistance([0,0,Infinity], [0,0,1], [1,1,1], [1,0,0])).toThrow();
  });
});
