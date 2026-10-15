import { describe, it, expect } from "vitest";
import { findCoincidentPoint } from "./coincidentPoint";

const pts = [
  { id: "point-0", position: [0, 0, 0] as [number, number, number] },
  { id: "point-1", position: [10, 0, 0] as [number, number, number] },
];

describe("findCoincidentPoint", () => {
  it("matches within 1e-3 of the diagonal and returns the nearest", () => {
    expect(findCoincidentPoint([10.01, 0, 0], pts, 100)).toBe("point-1"); // tol 0.1
    expect(findCoincidentPoint([0.05, 0, 0], pts, 100)).toBe("point-0");
  });
  it("is null outside the tolerance", () => {
    expect(findCoincidentPoint([10.2, 0, 0], pts, 100)).toBeNull();
    expect(findCoincidentPoint([5, 5, 5], pts, 100)).toBeNull();
  });
  it("keeps the 1e-6 floor for an unknown/zero diagonal", () => {
    expect(findCoincidentPoint([0, 0, 1e-7], pts, 0)).toBe("point-0");
    expect(findCoincidentPoint([0, 0, 1e-3], pts, NaN)).toBeNull();
  });
});
