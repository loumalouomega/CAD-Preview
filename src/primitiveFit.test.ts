import { describe, expect, it } from "vitest";
import {
  symmetricEigen,
  solveLinear,
  fitPlane,
  fitSphere,
  fitCylinder,
  axialExtent,
  normalize,
  centroid,
  type Vec3,
  type Mat3,
} from "./primitiveFit";

/** Deterministic pseudo-random, so a failure is always reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const unit = (v: Vec3): Vec3 => normalize(v)!;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("symmetricEigen", () => {
  it("recovers a diagonal matrix's eigenvalues, sorted ascending", () => {
    const m: Mat3 = [5, 0, 0, 0, 1, 0, 0, 0, 3];
    const e = symmetricEigen(m);
    expect(e.values[0]).toBeCloseTo(1, 9);
    expect(e.values[1]).toBeCloseTo(3, 9);
    expect(e.values[2]).toBeCloseTo(5, 9);
  });

  it("pairs each eigenvector with its own eigenvalue", () => {
    const m: Mat3 = [5, 0, 0, 0, 1, 0, 0, 0, 3];
    const e = symmetricEigen(m);
    // Smallest eigenvalue is 1, whose eigenvector is the y axis.
    expect(Math.abs(e.vectors[0][1])).toBeCloseTo(1, 9);
  });

  it("satisfies A·v = lambda·v for a genuinely non-diagonal matrix", () => {
    // Symmetric, with off-diagonal terms so the rotation actually runs.
    const m: Mat3 = [4, 1, 1, 1, 3, 2, 1, 2, 5];
    const e = symmetricEigen(m);
    for (let i = 0; i < 3; i++) {
      const v = e.vectors[i];
      const av: Vec3 = [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
      ];
      for (let k = 0; k < 3; k++) expect(av[k]).toBeCloseTo(e.values[i] * v[k], 7);
    }
  });

  it("returns unit eigenvectors", () => {
    const e = symmetricEigen([4, 1, 1, 1, 3, 2, 1, 2, 5]);
    for (const v of e.vectors) expect(Math.hypot(...v)).toBeCloseTo(1, 9);
  });
});

describe("solveLinear", () => {
  it("solves a well-conditioned system", () => {
    const x = solveLinear(
      [
        [2, 1],
        [1, 3],
      ],
      [5, 10]
    )!;
    expect(x[0]).toBeCloseTo(1, 9);
    expect(x[1]).toBeCloseTo(3, 9);
  });

  it("returns null for a singular system rather than Infinity", () => {
    expect(
      solveLinear(
        [
          [1, 2],
          [2, 4],
        ],
        [3, 6]
      )
    ).toBeNull();
  });
});

describe("fitPlane", () => {
  it("recovers a known plane's normal and a point on it", () => {
    const n = unit([1, 2, 3]);
    const origin: Vec3 = [10, -5, 2];
    const r = rng(1);
    // Two in-plane directions.
    const u = unit([n[1], -n[0], 0]);
    const v: Vec3 = [
      n[1] * u[2] - n[2] * u[1],
      n[2] * u[0] - n[0] * u[2],
      n[0] * u[1] - n[1] * u[0],
    ];
    const pts: Vec3[] = [];
    for (let i = 0; i < 60; i++) {
      const a = (r() - 0.5) * 20;
      const b = (r() - 0.5) * 20;
      pts.push([
        origin[0] + u[0] * a + v[0] * b,
        origin[1] + u[1] * a + v[1] * b,
        origin[2] + u[2] * a + v[2] * b,
      ]);
    }
    const fit = fitPlane(pts)!;
    expect(fit).not.toBeNull();
    // Sign is free; the axis must match.
    expect(Math.abs(dot(fit.normal, n))).toBeCloseTo(1, 8);
    // The fitted point lies on the true plane.
    expect(dot([fit.point[0] - origin[0], fit.point[1] - origin[1], fit.point[2] - origin[2]], n)).toBeCloseTo(0, 8);
  });

  it("returns null for collinear points rather than an arbitrary normal", () => {
    const pts: Vec3[] = [
      [0, 0, 0],
      [1, 1, 1],
      [2, 2, 2],
      [3, 3, 3],
    ];
    expect(fitPlane(pts)).toBeNull();
  });

  it("returns null for fewer than three points", () => {
    expect(fitPlane([[0, 0, 0], [1, 0, 0]])).toBeNull();
  });
});

describe("fitSphere", () => {
  it("recovers a known centre and radius from full-sphere samples", () => {
    const centre: Vec3 = [3, -4, 7];
    const radius = 5;
    const r = rng(7);
    const pts: Vec3[] = [];
    for (let i = 0; i < 200; i++) {
      // Uniform-ish directions; exactness of the distribution does not matter.
      const z = r() * 2 - 1;
      const t = r() * Math.PI * 2;
      const s = Math.sqrt(Math.max(0, 1 - z * z));
      pts.push([centre[0] + radius * s * Math.cos(t), centre[1] + radius * s * Math.sin(t), centre[2] + radius * z]);
    }
    const fit = fitSphere(pts)!;
    expect(fit.radius).toBeCloseTo(radius, 6);
    for (let k = 0; k < 3; k++) expect(fit.center[k]).toBeCloseTo(centre[k], 6);
  });

  it("stays accurate for a sphere far from the origin", () => {
    // The solve is done in centroid-local coordinates precisely so this holds.
    const centre: Vec3 = [10000, -8000, 5000];
    const radius = 3;
    const r = rng(11);
    const pts: Vec3[] = [];
    for (let i = 0; i < 200; i++) {
      const z = r() * 2 - 1;
      const t = r() * Math.PI * 2;
      const s = Math.sqrt(Math.max(0, 1 - z * z));
      pts.push([centre[0] + radius * s * Math.cos(t), centre[1] + radius * s * Math.sin(t), centre[2] + radius * z]);
    }
    const fit = fitSphere(pts)!;
    expect(fit.radius).toBeCloseTo(radius, 4);
  });

  it("returns null for fewer than four points", () => {
    expect(fitSphere([[0, 0, 0], [1, 0, 0], [0, 1, 0]])).toBeNull();
  });
});

describe("fitCylinder", () => {
  /** Points and outward normals on a cylinder about `axis` through `base`. */
  function cylinderSamples(base: Vec3, axis: Vec3, radius: number, height: number, n = 240) {
    const a = unit(axis);
    const helper: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = unit([a[1] * helper[2] - a[2] * helper[1], a[2] * helper[0] - a[0] * helper[2], a[0] * helper[1] - a[1] * helper[0]]);
    const v: Vec3 = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
    const r = rng(23);
    const points: Vec3[] = [];
    const normals: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const h = r() * height;
      const nx = u[0] * Math.cos(t) + v[0] * Math.sin(t);
      const ny = u[1] * Math.cos(t) + v[1] * Math.sin(t);
      const nz = u[2] * Math.cos(t) + v[2] * Math.sin(t);
      points.push([base[0] + a[0] * h + nx * radius, base[1] + a[1] * h + ny * radius, base[2] + a[2] * h + nz * radius]);
      normals.push([nx, ny, nz]);
    }
    return { points, normals };
  }

  it("recovers a known axis, radius, and a point on the axis", () => {
    const base: Vec3 = [1, 2, 3];
    const axis = unit([0, 0, 1]);
    const { points, normals } = cylinderSamples(base, axis, 4, 10);
    const fit = fitCylinder(points, normals)!;
    expect(fit).not.toBeNull();
    expect(fit.radius).toBeCloseTo(4, 6);
    expect(Math.abs(dot(fit.axis, axis))).toBeCloseTo(1, 8);
    // The fitted point must lie on the true axis line: its perpendicular
    // offset from it is zero.
    const d: Vec3 = [fit.point[0] - base[0], fit.point[1] - base[1], fit.point[2] - base[2]];
    const along = dot(d, axis);
    const perp = Math.hypot(d[0] - axis[0] * along, d[1] - axis[1] * along, d[2] - axis[2] * along);
    expect(perp).toBeCloseTo(0, 6);
  });

  it("recovers a TILTED, off-origin cylinder — an axis-aligned bug cannot pass this", () => {
    const base: Vec3 = [120, -45, 33];
    const axis = unit([1, 2, -1]);
    const { points, normals } = cylinderSamples(base, axis, 2.5, 14);
    const fit = fitCylinder(points, normals)!;
    expect(fit.radius).toBeCloseTo(2.5, 5);
    expect(Math.abs(dot(fit.axis, axis))).toBeCloseTo(1, 7);
  });

  it("returns null for a FLAT region — parallel normals determine no axis", () => {
    // This is the honest answer: a plane is not a cylinder of some huge radius.
    const points: Vec3[] = [];
    const normals: Vec3[] = [];
    const r = rng(31);
    for (let i = 0; i < 50; i++) {
      points.push([r() * 10, r() * 10, 0]);
      normals.push([0, 0, 1]);
    }
    expect(fitCylinder(points, normals)).toBeNull();
  });
});

describe("axialExtent", () => {
  it("measures the span along the axis from the given point", () => {
    const [lo, hi] = axialExtent(
      [
        [0, 0, -2],
        [0, 0, 5],
        [0, 0, 1],
      ],
      [0, 0, 0],
      [0, 0, 1]
    );
    expect(lo).toBeCloseTo(-2, 9);
    expect(hi).toBeCloseTo(5, 9);
  });
});

describe("centroid / normalize", () => {
  it("averages the points", () => {
    expect(centroid([[0, 0, 0], [2, 4, 6]])).toEqual([1, 2, 3]);
  });

  it("returns null for an empty set and for a zero vector", () => {
    expect(centroid([])).toBeNull();
    expect(normalize([0, 0, 0])).toBeNull();
  });
});
