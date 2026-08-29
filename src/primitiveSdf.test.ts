import { describe, expect, it } from "vitest";
import { signedDistance, maxDeviation, normalize, type Primitive, type Vec3 } from "./primitiveSdf";

const Z: Vec3 = [0, 0, 1];
const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];

describe("signedDistance — sphere", () => {
  const sphere: Primitive = { kind: "sphere", center: [1, 2, 3], radius: 5 };

  it("is zero on the surface", () => {
    expect(signedDistance([6, 2, 3], sphere)).toBeCloseTo(0, 12);
  });

  it("is the exact offset outside, and negative inside", () => {
    expect(signedDistance([9, 2, 3], sphere)).toBeCloseTo(3, 12);
    expect(signedDistance([2, 2, 3], sphere)).toBeCloseTo(-4, 12);
  });
});

describe("signedDistance — box", () => {
  const box: Primitive = { kind: "box", center: [0, 0, 0], size: [10, 4, 2], xAxis: X, yAxis: Y, zAxis: Z };

  it("is zero on each face", () => {
    expect(signedDistance([5, 0, 0], box)).toBeCloseTo(0, 12);
    expect(signedDistance([0, 2, 0], box)).toBeCloseTo(0, 12);
    expect(signedDistance([0, 0, 1], box)).toBeCloseTo(0, 12);
  });

  it("is the perpendicular gap just outside a face", () => {
    expect(signedDistance([8, 0, 0], box)).toBeCloseTo(3, 12);
  });

  it("is the distance to the nearest face when inside — negative", () => {
    // The z half-extent (1) is the closest boundary from the centre.
    expect(signedDistance([0, 0, 0], box)).toBeCloseTo(-1, 12);
  });

  it("is the true corner distance diagonally outside, not a per-axis max", () => {
    // 3-4-5 offset beyond the +x/+y corner, at z on the surface.
    expect(signedDistance([5 + 3, 2 + 4, 1], box)).toBeCloseTo(5, 12);
  });

  it("respects a rotated frame — the box's own axes, not the world's", () => {
    const rot: Primitive = {
      kind: "box",
      center: [0, 0, 0],
      size: [10, 4, 2],
      xAxis: [0, 1, 0],
      yAxis: [-1, 0, 0],
      zAxis: Z,
    };
    // The long (10) axis now points along world +y.
    expect(signedDistance([0, 5, 0], rot)).toBeCloseTo(0, 12);
    expect(signedDistance([0, 8, 0], rot)).toBeCloseTo(3, 12);
  });
});

describe("signedDistance — cylinder", () => {
  // Base at the origin, axis +z, r=3, h=10.
  const cyl: Primitive = { kind: "cylinder", base: [0, 0, 0], axis: Z, radius: 3, height: 10 };

  it("is zero on the lateral surface and on both caps", () => {
    expect(signedDistance([3, 0, 5], cyl)).toBeCloseTo(0, 12);
    expect(signedDistance([0, 0, 0], cyl)).toBeCloseTo(0, 12);
    expect(signedDistance([0, 0, 10], cyl)).toBeCloseTo(0, 12);
  });

  it("is the radial gap outside the lateral surface", () => {
    expect(signedDistance([7, 0, 5], cyl)).toBeCloseTo(4, 12);
  });

  it("is the axial gap beyond a cap", () => {
    expect(signedDistance([0, 0, 14], cyl)).toBeCloseTo(4, 12);
  });

  it("is negative inside", () => {
    expect(signedDistance([0, 0, 5], cyl)).toBeCloseTo(-3, 12);
  });

  it("is the true corner distance past the rim", () => {
    // 3 out radially, 4 past the top cap.
    expect(signedDistance([6, 0, 14], cyl)).toBeCloseTo(5, 12);
  });

  it("follows a tilted axis", () => {
    const axis = normalize([0, 1, 1])!;
    const tilted: Primitive = { kind: "cylinder", base: [1, 1, 1], axis, radius: 2, height: 6 };
    // A point 2 along the axis from the base is on the axis line, so its
    // distance to the lateral surface is the radius.
    const onAxis: Vec3 = [1 + axis[0] * 2, 1 + axis[1] * 2, 1 + axis[2] * 2];
    expect(signedDistance(onAxis, tilted)).toBeCloseTo(-2, 12);
  });
});

describe("signedDistance — cone", () => {
  // Base r=5 at the origin, top r=2 at z=4.
  const cone: Primitive = { kind: "cone", base: [0, 0, 0], axis: Z, radius1: 5, radius2: 2, height: 4 };

  it("is zero on the lateral surface at both ends", () => {
    expect(signedDistance([5, 0, 0], cone)).toBeCloseTo(0, 12);
    expect(signedDistance([2, 0, 4], cone)).toBeCloseTo(0, 12);
  });

  it("is zero at the midpoint of the taper", () => {
    // Radius interpolates linearly: 3.5 at z=2.
    expect(signedDistance([3.5, 0, 2], cone)).toBeCloseTo(0, 12);
  });

  it("is negative inside and positive outside the lateral surface", () => {
    expect(signedDistance([0, 0, 2], cone)).toBeLessThan(0);
    expect(signedDistance([10, 0, 2], cone)).toBeGreaterThan(0);
  });

  it("degrades to a cylinder when both radii are equal", () => {
    const straight: Primitive = { kind: "cone", base: [0, 0, 0], axis: Z, radius1: 3, radius2: 3, height: 10 };
    expect(signedDistance([3, 0, 5], straight)).toBeCloseTo(0, 12);
    expect(signedDistance([7, 0, 5], straight)).toBeCloseTo(4, 12);
  });
});

describe("signedDistance — torus", () => {
  // Ring of radius 10 about +z, tube radius 2, centred at the origin.
  const torus: Primitive = { kind: "torus", center: [0, 0, 0], axis: Z, majorRadius: 10, minorRadius: 2 };

  it("is zero on the tube surface", () => {
    expect(signedDistance([12, 0, 0], torus)).toBeCloseTo(0, 12);
    expect(signedDistance([8, 0, 0], torus)).toBeCloseTo(0, 12);
    expect(signedDistance([10, 0, 2], torus)).toBeCloseTo(0, 12);
  });

  it("is negative on the tube's centre circle — the deepest interior", () => {
    expect(signedDistance([10, 0, 0], torus)).toBeCloseTo(-2, 12);
  });

  it("measures from the ring, not the centre, at the hole", () => {
    // At the axis, the nearest tube point is majorRadius away minus the tube.
    expect(signedDistance([0, 0, 0], torus)).toBeCloseTo(8, 12);
  });
});

describe("maxDeviation", () => {
  const sphere: Primitive = { kind: "sphere", center: [0, 0, 0], radius: 5 };

  it("returns the largest absolute deviation, counting interior points too", () => {
    // +2 outside, -3 inside: the interior one is larger in magnitude and must win.
    expect(maxDeviation([[7, 0, 0], [2, 0, 0]], sphere)).toBeCloseTo(3, 12);
  });

  it("is ~0 for points that genuinely lie on the primitive", () => {
    const on: Vec3[] = [[5, 0, 0], [0, 5, 0], [0, 0, 5], [-5, 0, 0]];
    expect(maxDeviation(on, sphere)!).toBeLessThan(1e-12);
  });

  it("returns null for an empty point set rather than a perfect-looking 0", () => {
    // A residual that could not be computed must never read as a perfect fit.
    expect(maxDeviation([], sphere)).toBeNull();
  });

  it("returns null when any point is non-finite", () => {
    expect(maxDeviation([[0, 0, Number.NaN]], sphere)).toBeNull();
  });
});

describe("normalize", () => {
  it("returns a unit vector", () => {
    const n = normalize([0, 3, 4])!;
    expect(Math.hypot(...n)).toBeCloseTo(1, 12);
  });

  it("returns null for a degenerate vector rather than NaN", () => {
    expect(normalize([0, 0, 0])).toBeNull();
  });
});
