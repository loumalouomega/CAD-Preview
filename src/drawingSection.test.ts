import { describe, expect, it } from "vitest";
import {
  buildCutLoops,
  clipTrianglesToPlane,
  cuttingPlaneMark,
  hatchLoops,
} from "./drawingSection";
import type { Vec3 } from "./svgSilhouette";

// A unit cube, 12 triangles — the same boundary as `examples/VTK/cube.vtk`.
const POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
const INDICES = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);

describe("clipTrianglesToPlane", () => {
  it("keeps the negative side by default and the positive side flipped", async () => {
    const kept = clipTrianglesToPlane(POSITIONS, INDICES, undefined, { origin: [0, 0.5, 0], normal: [0, 1, 0] });
    expect(kept.crossed).toBe(true);
    expect(kept.cutSegments.length).toBeGreaterThan(0);
    let maxY = -Infinity;
    for (let i = 1; i < kept.positions.length; i += 3) maxY = Math.max(maxY, kept.positions[i]);
    expect(maxY).toBeLessThanOrEqual(0.5 + 1e-6);

    const flipped = clipTrianglesToPlane(POSITIONS, INDICES, undefined, { origin: [0, 0.5, 0], normal: [0, 1, 0], flip: true });
    let minY = Infinity;
    for (let i = 1; i < flipped.positions.length; i += 3) minY = Math.min(minY, flipped.positions[i]);
    expect(minY).toBeGreaterThanOrEqual(0.5 - 1e-6);
  });

  it("reports a miss without touching the caller's arrays", async () => {
    const missed = clipTrianglesToPlane(POSITIONS, INDICES, undefined, { origin: [0, 5, 0], normal: [0, 1, 0] });
    expect(missed.crossed).toBe(false);
    expect(missed.cutSegments).toEqual([]);
    // A miss retains every triangle, so the caller's geometry is untouched.
    expect(missed.indices.length).toBe(INDICES.length);
  });

  it("chains the mid-cube cut into one closed loop", async () => {
    const cut = clipTrianglesToPlane(POSITIONS, INDICES, undefined, { origin: [0, 0.5, 0], normal: [0, 1, 0] });
    const loops = buildCutLoops(cut.cutSegments, 1e-6);
    expect(loops).toHaveLength(1);
    expect(loops[0].closed).toBe(true);
    expect(loops[0].points.length).toBeGreaterThanOrEqual(4);
    for (const p of loops[0].points) expect(p[1]).toBeCloseTo(0.5, 9);
  });
});

describe("hatchLoops", () => {
  it("fills a square and leaves a square hole unhatched", async () => {
    const outer: Array<[number, number]> = [[0, 0], [4, 0], [4, 4], [0, 4]];
    const hole: Array<[number, number]> = [[1, 1], [3, 1], [3, 3], [1, 3]];
    const hatch = hatchLoops([outer, hole], { angleDeg: 0, spacing: 0.5 });
    expect(hatch.length).toBeGreaterThan(0);
    for (const [[x0, y0], [x1, y1]] of hatch) {
      for (const [x, y] of [[x0, y0], [x1, y1]] as Array<[number, number]>) {
        expect(x).toBeGreaterThanOrEqual(-1e-9);
        expect(x).toBeLessThanOrEqual(4 + 1e-9);
        expect(y).toBeGreaterThanOrEqual(-1e-9);
        expect(y).toBeLessThanOrEqual(4 + 1e-9);
      }
      // Even-odd pairing: a segment fully inside the hole would mean the
      // hole was filled. Midpoints must stay in material.
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      expect(mx > 1 && mx < 3 && my > 1 && my < 3).toBe(false);
    }
  });
});

describe("cuttingPlaneMark", () => {
  const front = { right: [1, 0, 0] as Vec3, up: [0, 1, 0] as Vec3, forward: [0, 0, 1] as Vec3 };
  const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

  it("draws an edge-on plane as a line with two arrowheads and a label", async () => {
    // The mark is extended to the parent drawing's bounds, so the bounds
    // must contain the projected cutting line (world y = 5 reads as
    // screen y = -5 in the Y-down frame).
    const mark = cuttingPlaneMark({ origin: [0, 5, 0], normal: [0, 1, 0] }, front, { minX: 0, minY: -10, maxX: 10, maxY: 10 }, "A—A");
    expect(mark).not.toBeNull();
    expect(mark!.segments).toHaveLength(1);
    expect(mark!.arrows).toHaveLength(4);
    expect(mark!.label).toBe("A—A");
  });

  it("returns null for a plane face-on to the parent instead of a false line", async () => {
    expect(cuttingPlaneMark({ origin: [0, 0, 5], normal: [0, 0, 1] }, front, bounds, "B—B")).toBeNull();
  });
});
