import { describe, expect, it } from "vitest";
import {
  groupCylindricalFaces,
  holeTableTsv,
  nearestHoleDesignation,
  type CylindricalFaceFacts,
} from "./holeTable";

const face = (id: string, radius: number, axis: [number, number, number], solidIds: string[] = ["solid-0"]): CylindricalFaceFacts => ({
  id,
  solidIds,
  radius,
  axisDirection: axis,
});

describe("groupCylindricalFaces", () => {
  it("merges same-radius parallel faces and splits on radius or direction", () => {
    const { rows, dropped } = groupCylindricalFaces([
      face("face-0", 2.5, [0, 0, 1]),
      face("face-1", 2.5, [0, 0, 1]),
      face("face-2", 4.5, [0, 0, 1]),
      face("face-3", 2.5, [1, 0, 0]),
    ]);
    expect(dropped).toEqual([]);
    expect(rows).toHaveLength(3);
    // Largest count first.
    expect(rows[0].faceIds).toEqual(["face-0", "face-1"]);
    expect(rows[0].count).toBe(2);
    expect(rows[0].diameter).toBe(5);
  });

  it("merges opposite-sign readings of the same axis", () => {
    const { rows } = groupCylindricalFaces([face("face-0", 3, [0, 0, 1]), face("face-1", 3, [0, 0, -1])]);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
    // Canonicalized: first-significant-component positive.
    expect(rows[0].axis[2]).toBeGreaterThan(0);
  });

  it("absorbs rotated-copy float error but not a genuinely different direction", () => {
    const { rows } = groupCylindricalFaces([
      face("face-0", 3, [0, 0, 1]),
      // ~0.05° off — a patterned copy's float drift.
      face("face-1", 3, [0.001, 0, 1]),
    ]);
    expect(rows).toHaveLength(1);
    const split = groupCylindricalFaces([face("face-0", 3, [0, 0, 1]), face("face-1", 3, [0, 1, 0])]);
    expect(split.rows).toHaveLength(2);
  });

  it("drops non-finite radius and degenerate axis, never building a row from them", () => {
    const { rows, dropped } = groupCylindricalFaces([
      face("face-0", 2.5, [0, 0, 1]),
      face("face-1", NaN, [0, 0, 1]),
      face("face-2", 2.5, [0, 0, 0]),
      face("face-3", -1, [0, 0, 1]),
    ]);
    expect(rows).toHaveLength(1);
    expect(dropped.sort()).toEqual(["face-1", "face-2", "face-3"]);
  });

  it("unions solid ids across a group's faces without duplication", () => {
    const { rows } = groupCylindricalFaces([
      face("face-0", 2.5, [0, 0, 1], ["solid-0"]),
      face("face-1", 2.5, [0, 0, 1], ["solid-0", "solid-1"]),
    ]);
    expect(rows[0].solidIds).toEqual(["solid-0", "solid-1"]);
  });
});

describe("nearestHoleDesignation", () => {
  it("matches an exact tap drill with zero delta", () => {
    expect(nearestHoleDesignation(5)).toEqual({
      designation: "M6",
      standard: "iso-metric-coarse",
      column: "tapDrill",
      delta: 0,
    });
  });

  it("matches an exact clearance with zero delta", () => {
    expect(nearestHoleDesignation(6.6)).toMatchObject({ designation: "M6", column: "clearance", delta: 0 });
  });

  it("reports a far match as far, never as a verdict", () => {
    const near = nearestHoleDesignation(100);
    expect(Math.abs(near.delta)).toBeGreaterThan(0);
    expect(near.designation).toBeTruthy();
  });
});

describe("holeTableTsv", () => {
  it("serializes one line per row under a fixed header", () => {
    const { rows } = groupCylindricalFaces([face("face-0", 2.5, [0, 0, 1]), face("face-1", 2.5, [0, 0, 1])]);
    const tsv = holeTableTsv(rows);
    const lines = tsv.split("\n");
    expect(lines[0]).toBe("Diameter_mm\tAxis\tCount\tFaces\tSolids\tNearest\tColumn\tDelta_mm");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("M6");
    expect(lines[1]).toContain("face-0,face-1");
  });

  it("an empty table is a header alone, never an error", () => {
    expect(holeTableTsv([]).split("\n")).toHaveLength(1);
  });
});
