import { describe, it, expect } from "vitest";
import {
  computePaneRects,
  glViewportForPane,
  ndcInPane,
  paneAtPoint,
  paneCount,
  type PaneRect,
} from "./viewerPanes";

/** True when every point of `canvas` is covered by exactly one rect (no gaps, no overlaps). */
function tilesExactly(rects: PaneRect[], w: number, h: number): boolean {
  let covered = 0;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const owners = rects.filter(
        (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
      ).length;
      if (owners !== 1) return false;
      covered++;
    }
  }
  return covered === w * h;
}

describe("paneCount", () => {
  it("maps layouts to their pane counts", () => {
    expect(paneCount("1x1")).toBe(1);
    expect(paneCount("2x2")).toBe(4);
  });
});

describe("computePaneRects", () => {
  it("1x1 is the full canvas", () => {
    expect(computePaneRects("1x1", 1024, 768)).toEqual([
      { x: 0, y: 0, width: 1024, height: 768 },
    ]);
  });

  it("2x2 tiles exactly on even dimensions", () => {
    const rects = computePaneRects("2x2", 1024, 768);
    expect(rects).toHaveLength(4);
    expect(tilesExactly(rects, 32, 24)).toBe(true);
    expect(rects[0]).toEqual({ x: 0, y: 0, width: 512, height: 384 });
    expect(rects[1]).toEqual({ x: 512, y: 0, width: 512, height: 384 });
    expect(rects[2]).toEqual({ x: 0, y: 384, width: 512, height: 384 });
    expect(rects[3]).toEqual({ x: 512, y: 384, width: 512, height: 384 });
  });

  it("2x2 tiles exactly on odd dimensions (remainder absorbed by right/bottom)", () => {
    for (const [w, h] of [
      [1025, 767],
      [1023, 769],
      [3, 3],
    ] as const) {
      const rects = computePaneRects("2x2", w, h);
      expect(tilesExactly(rects, Math.min(w, 40), Math.min(h, 40))).toBe(true);
      // Integer edges, and the union's extent equals the canvas.
      for (const r of rects) {
        expect(Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.width) && Number.isInteger(r.height)).toBe(true);
      }
      const right = Math.max(...rects.map((r) => r.x + r.width));
      const bottom = Math.max(...rects.map((r) => r.y + r.height));
      expect(right).toBe(w);
      expect(bottom).toBe(h);
    }
  });
});

describe("paneAtPoint", () => {
  const rects = computePaneRects("2x2", 1000, 800);

  it("maps each quadrant's center to its own pane (row-major)", () => {
    expect(paneAtPoint(rects, 250, 200)).toBe(0);
    expect(paneAtPoint(rects, 750, 200)).toBe(1);
    expect(paneAtPoint(rects, 250, 600)).toBe(2);
    expect(paneAtPoint(rects, 750, 600)).toBe(3);
  });

  it("a shared internal boundary point belongs to exactly one pane", () => {
    expect(paneAtPoint(rects, 500, 400)).toBe(3);
    expect(paneAtPoint(rects, 500, 100)).toBe(1);
    expect(paneAtPoint(rects, 100, 400)).toBe(2);
  });

  it("returns -1 outside every pane", () => {
    expect(paneAtPoint(rects, -1, 400)).toBe(-1);
    expect(paneAtPoint(rects, 1000, 400)).toBe(-1); // right outer edge
    expect(paneAtPoint(rects, 400, 800)).toBe(-1); // bottom outer edge
  });
});

describe("ndcInPane", () => {
  const rect = { x: 500, y: 400, width: 500, height: 400 };

  it("maps corners to ±1 and center to 0,0", () => {
    expect(ndcInPane(rect, 500, 400)).toEqual({ x: -1, y: 1 });
    expect(ndcInPane(rect, 1000, 800)).toEqual({ x: 1, y: -1 });
    expect(ndcInPane(rect, 750, 600)).toEqual({ x: 0, y: 0 });
  });

  it("is pane-relative, not canvas-relative (same point differs per pane)", () => {
    const left = { x: 0, y: 0, width: 500, height: 400 };
    const right = { x: 500, y: 0, width: 500, height: 400 };
    // The same canvas point is +1 NDC in the left pane's frame and -1 in the right's.
    expect(ndcInPane(left, 499, 200).x).toBeCloseTo(0.996);
    expect(ndcInPane(right, 501, 200).x).toBeCloseTo(-0.996);
  });
});

describe("glViewportForPane", () => {
  it("flips the top-left-origin rect to GL's bottom-left origin", () => {
    const cssHeight = 800;
    expect(glViewportForPane({ x: 0, y: 0, width: 500, height: 400 }, cssHeight)).toEqual({
      x: 0,
      y: 400,
      width: 500,
      height: 400,
    });
    expect(glViewportForPane({ x: 500, y: 400, width: 500, height: 400 }, cssHeight)).toEqual({
      x: 500,
      y: 0,
      width: 500,
      height: 400,
    });
  });

  it("round-trips: the full-canvas rect maps to the full viewport", () => {
    expect(glViewportForPane({ x: 0, y: 0, width: 1024, height: 768 }, 768)).toEqual({
      x: 0,
      y: 0,
      width: 1024,
      height: 768,
    });
  });
});
