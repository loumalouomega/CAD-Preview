import { describe, expect, it } from "vitest";
import { triangleMassProperties } from "./triangleMassProperties";

// Unit cube [0,1]^3 as 12 triangles (2 per face), outward-wound.
function cubeSoup(origin: [number, number, number] = [0, 0, 0]): number[] {
  const [ox, oy, oz] = origin;
  const v: [number, number, number][] = [
    [ox, oy, oz],
    [ox + 1, oy, oz],
    [ox + 1, oy + 1, oz],
    [ox, oy + 1, oz],
    [ox, oy, oz + 1],
    [ox + 1, oy, oz + 1],
    [ox + 1, oy + 1, oz + 1],
    [ox, oy + 1, oz + 1],
  ];
  const tris: [number, number, number][] = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [2, 3, 7],
    [2, 7, 6],
    [1, 2, 6],
    [1, 6, 5],
    [0, 4, 7],
    [0, 7, 3],
  ];
  return tris.flatMap(([a, b, c]) => [...v[a], ...v[b], ...v[c]]);
}

describe("triangleMassProperties", () => {
  it("recovers unit cube volume, area, centroids, watertight", () => {
    const p = triangleMassProperties(cubeSoup());
    expect(p.volume).toBeCloseTo(1, 9);
    expect(p.area).toBeCloseTo(6, 9);
    expect(p.volumeCentroid[0]).toBeCloseTo(0.5, 9);
    expect(p.volumeCentroid[1]).toBeCloseTo(0.5, 9);
    expect(p.volumeCentroid[2]).toBeCloseTo(0.5, 9);
    expect(p.areaCentroid[0]).toBeCloseTo(0.5, 9);
    expect(p.watertight).toBe(true);
  });

  it("translates with the geometry (no origin dependence)", () => {
    const p = triangleMassProperties(cubeSoup([10, -4, 7]));
    expect(p.volume).toBeCloseTo(1, 9);
    expect(p.area).toBeCloseTo(6, 9);
    expect(p.volumeCentroid[0]).toBeCloseTo(10.5, 9);
    expect(p.volumeCentroid[1]).toBeCloseTo(-3.5, 9);
    expect(p.volumeCentroid[2]).toBeCloseTo(7.5, 9);
    expect(p.watertight).toBe(true);
  });

  it("sums two disjoint cubes", () => {
    const p = triangleMassProperties([...cubeSoup([0, 0, 0]), ...cubeSoup([10, 0, 0])]);
    expect(p.volume).toBeCloseTo(2, 9);
    expect(p.area).toBeCloseTo(12, 9);
    expect(p.volumeCentroid[0]).toBeCloseTo(5.5, 9);
    expect(p.watertight).toBe(true);
  });

  it("marks an open triangle as non-watertight", () => {
    const p = triangleMassProperties([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(p.area).toBeCloseTo(0.5, 9);
    expect(p.watertight).toBe(false);
  });

  it("preserves the empty-geometry convention", () => {
    const p = triangleMassProperties([]);
    expect(p.volume).toBe(0);
    expect(p.area).toBe(0);
    expect(p.volumeCentroid).toEqual([0, 0, 0]);
    expect(p.watertight).toBe(true);
  });

  it("rejects non-finite coordinates", () => {
    expect(() => triangleMassProperties([0, 0, 0, 1, 0, 0, NaN, 1, 0])).toThrow(/non-finite/i);
  });
});
