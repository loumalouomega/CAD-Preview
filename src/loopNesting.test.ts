import { describe, it, expect } from "vitest";
import { signedArea2d, pointInPolygon, loopDepths, nestLoops, type Loop2d } from "./loopNesting";

const square = (cx: number, cy: number, hw: number, hh: number, reversed = false): Loop2d => {
  const pts: [number, number][] = [
    [cx - hw, cy - hh],
    [cx + hw, cy - hh],
    [cx + hw, cy + hh],
    [cx - hw, cy + hh],
  ];
  return reversed ? [...pts].reverse() : pts;
};

describe("signedArea2d", () => {
  it("is positive for a counter-clockwise loop", () => {
    expect(signedArea2d(square(0, 0, 5, 3))).toBeCloseTo(60, 6);
  });
  it("is negative for a clockwise loop", () => {
    expect(signedArea2d(square(0, 0, 5, 3, true))).toBeCloseTo(-60, 6);
  });
});

describe("pointInPolygon", () => {
  const outer = square(0, 0, 5, 3);
  it("is true for a point inside", () => {
    expect(pointInPolygon([0, 0], outer)).toBe(true);
  });
  it("is false for a point outside", () => {
    expect(pointInPolygon([100, 100], outer)).toBe(false);
  });
});

describe("loopDepths / nestLoops — the letter O (one outer + one hole)", () => {
  const outer = square(0, 0, 5, 3);
  const hole = square(0, 0, 2, 1);

  it("gives the hole depth 1 and the outer depth 0", () => {
    expect(loopDepths([outer, hole])).toEqual([0, 1]);
  });

  it("groups into one region: outer with one hole", () => {
    const regions = nestLoops([outer, hole]);
    expect(regions).toEqual([{ outer: 0, holes: [1] }]);
  });

  it("nests regardless of input order", () => {
    const regions = nestLoops([hole, outer]);
    expect(regions).toEqual([{ outer: 1, holes: [0] }]);
  });
});

describe("nestLoops — the letter B (two holes in one outer)", () => {
  const outer = square(0, 0, 5, 5);
  const holeTop = square(0, 2, 2, 1.5);
  const holeBottom = square(0, -2, 2, 1.5);

  it("assigns both holes to the same outer", () => {
    const regions = nestLoops([outer, holeTop, holeBottom]);
    expect(regions).toHaveLength(1);
    expect(regions[0].outer).toBe(0);
    expect(regions[0].holes.sort()).toEqual([1, 2]);
  });
});

describe("nestLoops — an island inside a counter (depth 2, like an registered-trademark glyph)", () => {
  const outer = square(0, 0, 10, 10);
  const counter = square(0, 0, 6, 6);
  const island = square(0, 0, 2, 2);

  it("starts a second region at the island (even depth)", () => {
    expect(loopDepths([outer, counter, island])).toEqual([0, 1, 2]);
    const regions = nestLoops([outer, counter, island]);
    expect(regions).toHaveLength(2);
    const byOuter = new Map(regions.map((r) => [r.outer, r.holes]));
    expect(byOuter.get(0)).toEqual([1]);
    expect(byOuter.get(2)).toEqual([]);
  });
});

describe("nestLoops — two disjoint outers (two separate letters)", () => {
  const a = square(-10, 0, 3, 3);
  const b = square(10, 0, 3, 3);

  it("produces two regions, each with no holes", () => {
    const regions = nestLoops([a, b]);
    expect(regions).toHaveLength(2);
    expect(regions.every((r) => r.holes.length === 0)).toBe(true);
  });
});

describe("nestLoops — degenerate loops are dropped, never crash", () => {
  it("ignores a loop with fewer than 3 points", () => {
    const outer = square(0, 0, 5, 3);
    const degenerate: Loop2d = [[0, 0], [1, 1]];
    const regions = nestLoops([outer, degenerate]);
    expect(regions).toEqual([{ outer: 0, holes: [] }]);
  });

  it("ignores a zero-area (collinear) loop", () => {
    const outer = square(0, 0, 5, 3);
    const collinear: Loop2d = [[0, 0], [1, 0], [2, 0]];
    const regions = nestLoops([outer, collinear]);
    expect(regions).toEqual([{ outer: 0, holes: [] }]);
  });

  it("returns no regions for an all-degenerate input", () => {
    expect(nestLoops([[[0, 0], [1, 1]]])).toEqual([]);
  });
});
