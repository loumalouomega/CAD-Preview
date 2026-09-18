import { describe, it, expect } from "vitest";
import { planeBasis, profilePlacementFromPlane, type Vec3 } from "./planeFrame";

const close = (a: Vec3, b: Vec3) => {
  expect(a[0]).toBeCloseTo(b[0], 9);
  expect(a[1]).toBeCloseTo(b[1], 9);
  expect(a[2]).toBeCloseTo(b[2], 9);
};

describe("planeBasis", () => {
  it("is orthonormal for an axis-aligned normal", () => {
    const basis = planeBasis([0, 0, 1]);
    expect(basis).not.toBeNull();
    const [u, v] = basis!;
    close(u, [0, -1, 0]);
    close(v, [1, 0, 0]);
  });

  it("is deterministic and orthonormal for a tilted normal", () => {
    const n: Vec3 = [1, 1, 1];
    const a = planeBasis(n)!;
    const b = planeBasis(n)!;
    expect(a).toEqual(b);
    const [u, v] = a;
    const nn = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    expect(u[0] * nn[0] + u[1] * nn[1] + u[2] * nn[2]).toBeCloseTo(0, 9);
    expect(v[0] * nn[0] + v[1] * nn[1] + v[2] * nn[2]).toBeCloseTo(0, 9);
    expect(u[0] * v[0] + u[1] * v[1] + u[2] * v[2]).toBeCloseTo(0, 9);
    expect(Math.hypot(...u)).toBeCloseTo(1, 9);
    expect(Math.hypot(...v)).toBeCloseTo(1, 9);
  });

  it("rejects a degenerate normal", () => {
    expect(planeBasis([0, 0, 0])).toBeNull();
    expect(planeBasis([NaN, 0, 1])).toBeNull();
  });
});

describe("profilePlacementFromPlane", () => {
  const plane = { point: [10, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 };

  it("places the center on the plane point with zero offsets", () => {
    const p = profilePlacementFromPlane(plane, 0, 0, 0)!;
    close(p.center, [10, 0, 0]);
    close(p.normal, [0, 0, 1]);
  });

  it("moves the center along the basis axes", () => {
    // For normal +Z the basis is U=(0,-1,0), V=(1,0,0).
    const p = profilePlacementFromPlane(plane, 2, 3, 0)!;
    close(p.center, [13, -2, 0]);
    close(p.up, [1, 0, 0]);
  });

  it("rotation 0 is the identity and 90 swaps the axes", () => {
    const p0 = profilePlacementFromPlane(plane, 0, 0, 0)!;
    const p90 = profilePlacementFromPlane(plane, 0, 0, 90)!;
    close(p0.up, [1, 0, 0]);
    close(p90.up, [0, -1, 0]);
  });

  it("returns null for degenerate inputs", () => {
    expect(profilePlacementFromPlane({ point: [0, 0, 0], normal: [0, 0, 0] }, 0, 0, 0)).toBeNull();
    expect(profilePlacementFromPlane(plane, NaN, 0, 0)).toBeNull();
    expect(profilePlacementFromPlane(plane, 0, 0, Infinity)).toBeNull();
  });
});
