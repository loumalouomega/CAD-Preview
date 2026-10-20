import { describe, expect, it } from "vitest";
import { cumulativeRows, measureBoundaryLayerRows, type BoundaryLayerWall } from "./boundaryLayerMeasurement";
import { boundaryLayerPlan, type MeshBoundaryLayer } from "./meshOptions";

const layer: MeshBoundaryLayer = { wallSize: 0.05, growthRatio: 1.2, thickness: 0.5, quads: true };
const heights = cumulativeRows(layer, 6);

/** A straight wall from x=0 to 10 at y=0, plus one row of nodes at each height. */
function rectangleNodes(rows: readonly number[], xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]): number[] {
  const coords: number[] = [];
  for (const y of [0, ...rows]) for (const x of xs) coords.push(x, y, 0);
  return coords;
}

function wall(lines = 1): BoundaryLayerWall {
  return { part: "Wall", layer, polylines: [[[0, 0, 0], [10, 0, 0]]] };
}

describe("cumulativeRows", () => {
  it("uses the same geometric series boundaryLayerPlan promises", () => {
    expect(heights).toHaveLength(6);
    expect(heights.map((h) => Number(h.toFixed(6)))).toEqual([0.05, 0.11, 0.182, 0.2684, 0.37208, 0.496496]);
    expect(cumulativeRows({ wallSize: 0.1, growthRatio: 1, thickness: 0.3, quads: true }, 3)).toEqual([0.1, 0.2, 0.30000000000000004]);
  });
});

describe("measureBoundaryLayerRows", () => {
  it("reports the full planned stack when every row has nodes on every station", () => {
    const [result] = measureBoundaryLayerRows([wall()], rectangleNodes(heights));
    expect(result).toMatchObject({ part: "Wall", plannedRows: 6, achievedMin: 6, achievedMedian: 6, coverage: 1 });
    expect(result.stations).toBe(9);
  });

  it("reports a 10-row plan on every sampled station of a 10x4 wall", () => {
    const thick: MeshBoundaryLayer = { ...layer, thickness: 1.3 };
    expect(boundaryLayerPlan(thick).layers).toBe(10);
    const xs = Array.from({ length: 41 }, (_, i) => i * 0.25);
    const [result] = measureBoundaryLayerRows(
      [{ part: "Wall", layer: thick, polylines: [[[0, 0, 0], [10, 0, 0]]] }],
      rectangleNodes(cumulativeRows(thick, 10), xs)
    );
    expect(result).toMatchObject({ part: "Wall", plannedRows: 10, achievedMin: 10, achievedMedian: 10, coverage: 1 });
  });

  it("reports fewer rows when thickness only fits a smaller stack", () => {
    const thin: MeshBoundaryLayer = { ...layer, thickness: 0.25 };
    const [result] = measureBoundaryLayerRows(
      [{ part: "Wall", layer: thin, polylines: [[[0, 0, 0], [10, 0, 0]]] }],
      rectangleNodes(cumulativeRows(thin, 3))
    );
    expect(result.plannedRows).toBe(3);
    expect(result.achievedMin).toBe(3);
    expect(result.achievedMedian).toBe(3);
    expect(result.coverage).toBe(1);
  });

  it("reports zero for a plain mesh whose nodes are not at the layer rows", () => {
    const [result] = measureBoundaryLayerRows([wall()], rectangleNodes([0.3, 0.6, 0.9]));
    expect(result.achievedMin).toBe(0);
    expect(result.achievedMedian).toBe(0);
    expect(result.coverage).toBe(0);
    expect(result.plannedRows).toBe(6);
  });

  it("reports coverage and a zero minimum when only part of the wall has rows", () => {
    const [result] = measureBoundaryLayerRows([wall()], rectangleNodes(heights, [0, 1, 2, 3, 4, 5]));
    expect(result.achievedMin).toBe(0);
    expect(result.achievedMedian).toBe(6);
    expect(result.coverage).toBeCloseTo(5 / 9, 6);
  });

  it("measures each connected polyline and counts a resolved edge with no mesh rows as zero", () => {
    const [result] = measureBoundaryLayerRows(
      [
        {
          part: "Wall",
          layer,
          polylines: [
            [[0, 0, 0], [5, 0, 0]],
            [[6, 0, 0], [10, 0, 0]],
          ],
        },
      ],
      rectangleNodes(heights, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5])
    );
    expect(result.stations).toBe(18);
    expect(result.achievedMin).toBe(0);
    expect(result.achievedMedian).toBe(3);
    expect(result.coverage).toBeCloseTo(9 / 18, 6);
  });

  it("measures a curved wall by its sampled polyline, not by its endpoints", () => {
    const quarter: Array<[number, number, number]> = [];
    for (let i = 0; i <= 8; i++) {
      const a = (Math.PI / 2) * (i / 8);
      quarter.push([5 + 5 * Math.cos(a), 5 * Math.sin(a), 0]);
    }
    const coords: number[] = [];
    for (const [x, y] of quarter) {
      coords.push(x, y, 0);
      // Offset along the local radial direction by every analytic row height.
      const dx = (x - 5) / 5;
      const dy = y / 5;
      for (const h of heights) coords.push(x + dx * h, y + dy * h, 0);
    }
    const [result] = measureBoundaryLayerRows([{ part: "Arc", layer, polylines: [quarter] }], coords);
    expect(result.plannedRows).toBe(6);
    expect(result.achievedMin).toBe(6);
    expect(result.achievedMedian).toBe(6);
    expect(result.coverage).toBe(1);
  });

  it("returns zeroes for a wall with no usable polyline instead of dropping it", () => {
    const [result] = measureBoundaryLayerRows([{ part: "Wall", layer, polylines: [[[0, 0, 0]]] }], rectangleNodes(heights));
    expect(result).toMatchObject({ plannedRows: 6, achievedMin: 0, achievedMedian: 0, coverage: 0, stations: 0 });
  });
});
