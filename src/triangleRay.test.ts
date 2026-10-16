import { describe, expect, it } from "vitest";
import { buildTriangleGrid, castRay } from "./triangleRay";

/** Axis-aligned box [0,sx]x[0,sy]x[0,sz] as 12 outward triangles. */
export function box(sx: number, sy: number, sz: number, ox = 0, oy = 0, oz = 0) {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const positions = new Float32Array(v.flatMap((p) => [ox + p[0] * sx, oy + p[1] * sy, oz + p[2] * sz]));
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  return { positions, indices };
}

describe("castRay", () => {
  const g = buildTriangleGrid(box(10, 10, 10).positions, box(10, 10, 10).indices);

  it("measures the distance to the far face from inside", () => {
    expect(castRay(g, [5, 5, 2], [0, 0, 1])).toBeCloseTo(8, 6);
    expect(castRay(g, [5, 5, 2], [0, 0, -1])).toBeCloseTo(2, 6);
    expect(castRay(g, [1, 5, 5], [1, 0, 0])).toBeCloseTo(9, 6);
  });

  it("hits from outside and misses when pointing away", () => {
    expect(castRay(g, [5, 5, -3], [0, 0, 1])).toBeCloseTo(3, 6);
    expect(castRay(g, [5, 5, -3], [0, 0, -1])).toBeNull();
    expect(castRay(g, [50, 5, 5], [0, 0, 1])).toBeNull();
  });

  it("handles an oblique ray", () => {
    const s = Math.SQRT1_2;
    expect(castRay(g, [5, 5, 5], [s, 0, s])).toBeCloseTo(5 / s, 5);
  });

  it("agrees with brute force over a denser mesh", () => {
    // 4 stacked boxes => several grid cells; the nearest of many layers wins.
    const parts = [0, 3, 6, 9].map((z) => box(10, 10, 1, 0, 0, z));
    const positions = new Float32Array(parts.flatMap((p) => [...p.positions]));
    const indices = new Uint32Array(parts.flatMap((p, k) => [...p.indices].map((i) => i + k * 8)));
    const grid = buildTriangleGrid(positions, indices);
    expect(castRay(grid, [5, 5, -1], [0, 0, 1])).toBeCloseTo(1, 6);
    // Layers span z 0-1, 3-4, 6-7, 9-10: from the gap at 1.5 the nearest is z=3 (up) / z=1 (down).
    expect(castRay(grid, [5, 5, 1.5], [0, 0, 1])).toBeCloseTo(1.5, 6);
    expect(castRay(grid, [5, 5, 1.5], [0, 0, -1])).toBeCloseTo(0.5, 6);
    expect(castRay(grid, [5, 5, 2.5], [0, 0, -1])).toBeCloseTo(1.5, 6);
  });
});
