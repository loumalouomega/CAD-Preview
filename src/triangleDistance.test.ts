import { describe, it, expect } from "vitest";
import { buildTriangleGrid3D, closestPointOnTriangle, nearestOnGrid } from "./triangleDistance";

const out = new Float64Array(3);
const d = (p: number[], t: number[][]) =>
  Math.sqrt(closestPointOnTriangle(p[0], p[1], p[2], ...(t[0] as [number, number, number]), ...(t[1] as [number, number, number]), ...(t[2] as [number, number, number]), out));

describe("closestPointOnTriangle", () => {
  const tri = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  it("covers every Voronoi region", () => {
    expect(d([0.2, 0.2, 3], tri)).toBeCloseTo(3); // face interior
    expect(d([-1, -1, 0], tri)).toBeCloseTo(Math.SQRT2); // vertex a
    expect(d([2, 0, 0], tri)).toBeCloseTo(1); // vertex b
    expect(d([0, 2, 0], tri)).toBeCloseTo(1); // vertex c
    expect(d([0.5, -1, 0], tri)).toBeCloseTo(1); // edge ab
    expect(d([-1, 0.5, 0], tri)).toBeCloseTo(1); // edge ac
    expect(d([1, 1, 0], tri)).toBeCloseTo(Math.SQRT1_2); // edge bc
  });
  it("tolerates a degenerate triangle", () => {
    expect(Number.isFinite(d([0, 1, 0], [[0, 0, 0], [1, 0, 0], [2, 0, 0]]))).toBe(true);
  });
});

/** Unit sphere-ish: an octahedron scaled, plus brute-force oracle. */
function brute(positions: number[], indices: number[], p: [number, number, number]): number {
  let best = Infinity;
  for (let t = 0; t < indices.length; t += 3) {
    const v = (i: number) => [positions[indices[t + i] * 3], positions[indices[t + i] * 3 + 1], positions[indices[t + i] * 3 + 2]];
    best = Math.min(best, d(p, [v(0), v(1), v(2)]));
  }
  return best;
}

function gridMesh(n: number): { positions: number[]; indices: number[] } {
  // A wavy n×n height field over [0,10]² — many small triangles.
  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) positions.push((i / n) * 10, (j / n) * 10, Math.sin(i * 0.7) * Math.cos(j * 0.5));
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      indices.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1);
    }
  return { positions, indices };
}

describe("nearestOnGrid", () => {
  it("matches a brute-force scan inside, near and far outside the mesh", () => {
    const { positions, indices } = gridMesh(30);
    const grid = buildTriangleGrid3D(positions, indices);
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 200; k++) {
      const spread = k < 150 ? 12 : 200;
      const p: [number, number, number] = [rnd() * spread - spread / 10, rnd() * spread - spread / 10, rnd() * 6 - 3];
      const hit = nearestOnGrid(grid, p)!;
      expect(hit.distance).toBeCloseTo(brute(positions, indices, p), 9);
    }
  });

  it("returns null for an empty mesh and 0 for a point on the surface", () => {
    expect(nearestOnGrid(buildTriangleGrid3D([], []), [0, 0, 0])).toBeNull();
    const grid = buildTriangleGrid3D([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    expect(nearestOnGrid(grid, [0.25, 0.25, 0])!.distance).toBeCloseTo(0);
  });
});
