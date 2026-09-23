import { describe, it, expect } from "vitest";
import { measureDeviation, sampleSurface, deviationPly, type DeviationSurface } from "./meshDeviation";

/** An n×n grid over [0,10]² at height z (optionally offset in x). */
function grid(n: number, z = 0, dx = 0): DeviationSurface {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(dx + (i / n) * 10, (j / n) * 10, z);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      indices.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1);
    }
  return { positions, indices };
}

/** The lateral surface of a radius-R cylinder of height H with `seg` flat sides. */
function cylinder(R: number, H: number, seg: number, rings = 4): DeviationSurface {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r <= rings; r++)
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * 2 * Math.PI;
      positions.push(R * Math.cos(a), R * Math.sin(a), (r / rings) * H);
    }
  for (let r = 0; r < rings; r++)
    for (let k = 0; k < seg; k++) {
      const a = r * seg + k, b = r * seg + ((k + 1) % seg);
      indices.push(a, b, a + seg, b, b + seg, a + seg);
    }
  return { positions, indices };
}

/** A unit cube's six faces, each face its own region; `skip` drops one face. */
function cube(skip?: number): DeviationSurface {
  const P = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ].flat();
  const faces = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3],
  ];
  const indices: number[] = [];
  const triangleRegion: number[] = [];
  faces.forEach((f, i) => {
    if (i === skip) return;
    indices.push(f[0], f[1], f[2], f[0], f[2], f[3]);
    triangleRegion.push(i, i);
  });
  return { positions: P, indices, triangleRegion, regionNames: ["face-0", "face-1", "face-2", "face-3", "face-4", "face-5"] };
}

describe("measureDeviation", () => {
  it("an unchanged planar surface reads ≈ 0 in both directions with full coverage", () => {
    const r = measureDeviation(grid(10), grid(3), { tolerance: 1e-6, samples: 2000 }).report;
    expect(r.forward.max).toBeLessThan(1e-9);
    expect(r.reverse.max).toBeLessThan(1e-9);
    expect(r.forward.coverage).toBe(1);
    expect(r.extraneousFraction).toBe(0);
  });

  it("a coarse cylinder deviates by (close to) its analytic sagitta R(1 − cos(π/N))", () => {
    const R = 10, N = 12;
    const sagitta = R * (1 - Math.cos(Math.PI / N));
    const r = measureDeviation(cylinder(R, 10, 256), cylinder(R, 10, N), { tolerance: sagitta / 10, samples: 20000 }).report;
    expect(r.forward.max).toBeGreaterThan(sagitta * 0.9);
    expect(r.forward.max).toBeLessThanOrEqual(sagitta * 1.001);
    expect(r.forward.coverage).toBeLessThan(0.9); // most of the arc lies off the chords
  });

  it("an omitted face is a FORWARD failure named by its region", () => {
    const r = measureDeviation(cube(), cube(1), { tolerance: 0.01, samples: 6000 }).report;
    expect(r.regionFailures[0].region).toBe("face-1");
    expect(r.regionFailures[0].maxDeviation).toBeGreaterThan(0.3);
    expect(r.regionFailures).toHaveLength(1);
    expect(r.extraneousFraction).toBe(0);
  });

  it("an extraneous surface is a REVERSE failure, not a forward one", () => {
    const withExtra = grid(4);
    const extra = grid(4, 5, 0);
    const offset = withExtra.positions.length / 3;
    const merged: DeviationSurface = {
      positions: [...(withExtra.positions as number[]), ...(extra.positions as number[])],
      indices: [...(withExtra.indices as number[]), ...(extra.indices as number[]).map((i) => i + offset)],
    };
    const r = measureDeviation(grid(4), merged, { tolerance: 0.01, samples: 4000 }).report;
    expect(r.forward.max).toBeLessThan(1e-9);
    expect(r.extraneousFraction).toBeGreaterThan(0.4);
    expect(r.reverse.max).toBeCloseTo(5);
  });

  it("filtering reports its exclusions and never hides a failed region", () => {
    const r = measureDeviation(cube(), cube(1), { tolerance: 0.01, samples: 6000 }).report;
    expect(r.filtered.samples + r.filtered.excluded).toBe(r.forward.samples);
    expect(r.regionFailures.length).toBeGreaterThan(0); // from raw samples regardless of filtering
  });

  it("per-corner distances line up with the mesh triangles, and the PLY carries them", () => {
    const mesh = cylinder(10, 10, 8, 1);
    const { cornerDistances } = measureDeviation(cylinder(10, 10, 128), mesh, { tolerance: 0.1, perCorner: true, samples: 500 });
    expect(cornerDistances!.length).toBe(mesh.indices.length);
    expect(Math.max(...cornerDistances!)).toBeLessThan(1e-6); // mesh vertices lie on the true circle
    const ply = deviationPly(mesh, cornerDistances!);
    expect(ply).toMatch(/property float distance/);
    expect(ply.trim().split("\n")).toHaveLength(11 + mesh.indices.length + mesh.indices.length / 3);
  });

  it("sampling is deterministic and area-weighted", () => {
    const a = sampleSurface(grid(2), 100);
    const b = sampleSurface(grid(2), 100);
    expect(a.points).toEqual(b.points);
    expect(new Set(a.triangles).size).toBe(8); // every equal-area triangle is visited
  });

  it("refuses a nonsense tolerance or an empty surface", () => {
    expect(() => measureDeviation(grid(2), grid(2), { tolerance: 0 })).toThrow(/tolerance/);
    expect(() => measureDeviation(grid(2), { positions: [], indices: [] }, { tolerance: 1 })).toThrow(/at least one triangle/);
  });
});
