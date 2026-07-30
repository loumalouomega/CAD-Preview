import { describe, it, expect } from "vitest";
import { pointDistance, polylineLength, angleBetweenVectors, circleRadiusFromArcPoints } from "./measurement";

describe("pointDistance", () => {
  it("computes Euclidean distance", () => {
    expect(pointDistance([0, 0, 0], [3, 4, 0])).toBe(5);
    expect(pointDistance([1, 1, 1], [1, 1, 1])).toBe(0);
  });
});

describe("polylineLength", () => {
  it("sums segment lengths along a flat coordinate array", () => {
    // (0,0,0) -> (3,0,0) -> (3,4,0): 3 + 4 = 7
    expect(polylineLength([0, 0, 0, 3, 0, 0, 3, 4, 0])).toBe(7);
  });

  it("returns 0 for a single point or empty array", () => {
    expect(polylineLength([1, 2, 3])).toBe(0);
    expect(polylineLength([])).toBe(0);
  });
});

describe("angleBetweenVectors", () => {
  it("returns 90 for perpendicular vectors", () => {
    expect(angleBetweenVectors([1, 0, 0], [0, 1, 0])).toBeCloseTo(90, 6);
  });

  it("returns 0 for parallel vectors", () => {
    expect(angleBetweenVectors([2, 0, 0], [5, 0, 0])).toBeCloseTo(0, 6);
  });

  it("returns 180 for opposite vectors", () => {
    expect(angleBetweenVectors([1, 0, 0], [-1, 0, 0])).toBeCloseTo(180, 6);
  });

  it("returns NaN for a zero-length vector", () => {
    expect(angleBetweenVectors([0, 0, 0], [1, 0, 0])).toBeNaN();
  });
});

describe("circleRadiusFromArcPoints", () => {
  it("computes the radius of a known circle in the XY plane", () => {
    // Circle of radius 5 centered at origin: (5,0,0), (0,5,0), (-5,0,0)
    const r = circleRadiusFromArcPoints([5, 0, 0], [0, 5, 0], [-5, 0, 0]);
    expect(r).toBeCloseTo(5, 6);
  });

  it("returns null for (near-)collinear points", () => {
    expect(circleRadiusFromArcPoints([0, 0, 0], [1, 0, 0], [2, 0, 0])).toBeNull();
  });
});
