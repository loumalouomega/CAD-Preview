import { describe, expect, it } from "vitest";
import {
  HOLE_STANDARDS,
  allHoleSizes,
  depthPresetsFor,
  findHoleSize,
  holeSizesFor,
  type HoleStandard,
} from "./holeStandards";

describe("holeSizesFor", () => {
  it("covers every declared standard with a non-empty table", () => {
    for (const s of HOLE_STANDARDS) {
      expect(holeSizesFor(s).length, s).toBeGreaterThan(0);
    }
  });

  it("tags every row with the standard it came from", () => {
    for (const s of HOLE_STANDARDS) {
      for (const row of holeSizesFor(s)) expect(row.standard).toBe(s);
    }
  });

  it("returns copies, so a caller cannot mutate the table", () => {
    const first = holeSizesFor("iso-metric-coarse")[0];
    first.tapDrillDiameter = 999;
    expect(holeSizesFor("iso-metric-coarse")[0].tapDrillDiameter).not.toBe(999);
  });

  it("lists sizes in ascending nominal order", () => {
    for (const s of HOLE_STANDARDS) {
      const majors = holeSizesFor(s).map((r) => r.majorDiameter);
      expect([...majors].sort((a, b) => a - b), s).toEqual(majors);
    }
  });
});

describe("the metric tables", () => {
  it("follows the D − P tap-drill rule exactly", () => {
    // The defining property of the metric columns — if a row is ever mistyped,
    // this catches it without hardcoding every value a second time.
    for (const s of ["iso-metric-coarse", "iso-metric-fine"] as HoleStandard[]) {
      for (const r of holeSizesFor(s)) {
        expect(r.tapDrillDiameter, `${r.designation} tap drill = D − P`).toBeCloseTo(
          r.majorDiameter - r.pitch,
          6
        );
      }
    }
  });

  it("pins the sizes people actually reach for", () => {
    expect(findHoleSize("M6")).toMatchObject({ majorDiameter: 6, pitch: 1, tapDrillDiameter: 5, clearanceDiameter: 6.6 });
    expect(findHoleSize("M3")).toMatchObject({ tapDrillDiameter: 2.5, clearanceDiameter: 3.4 });
    expect(findHoleSize("M10")).toMatchObject({ tapDrillDiameter: 8.5, clearanceDiameter: 11 });
  });

  it("gives a fine thread a LARGER tap drill than the coarse thread of the same major", () => {
    // Less material removed for a shallower thread — the whole reason to offer
    // both. A table that got this backwards would be quietly destructive.
    const coarse = findHoleSize("M10", "iso-metric-coarse")!;
    const fine = findHoleSize("M10x1.25", "iso-metric-fine")!;
    expect(fine.majorDiameter).toBe(coarse.majorDiameter);
    expect(fine.tapDrillDiameter).toBeGreaterThan(coarse.tapDrillDiameter);
  });
});

describe("the imperial tables", () => {
  it("reports millimetres, not inches — the unit every edit op consumes", () => {
    const q = findHoleSize("1/4-20")!;
    expect(q.nominalInch).toBe(0.25);
    expect(q.majorDiameter).toBeCloseTo(6.35, 3); // 0.25" exactly
    expect(q.tapDrillDiameter).toBeCloseTo(0.201 * 25.4, 3); // #7 drill
  });

  it("carries the nominal inch size for imperial rows only", () => {
    expect(findHoleSize("1/4-20")!.nominalInch).toBeDefined();
    expect(findHoleSize("M6")!.nominalInch).toBeUndefined();
  });
});

describe("every row, whatever the standard", () => {
  it("keeps tap drill < major diameter < clearance", () => {
    // The ordering that makes the two columns meaningful: you can always tap a
    // tap-drilled hole and always pass a bolt through a clearance hole.
    for (const r of allHoleSizes()) {
      expect(r.tapDrillDiameter, r.designation).toBeLessThan(r.majorDiameter);
      expect(r.clearanceDiameter, r.designation).toBeGreaterThan(r.majorDiameter);
    }
  });

  it("has finite, positive numbers throughout", () => {
    for (const r of allHoleSizes()) {
      for (const k of ["majorDiameter", "pitch", "tapDrillDiameter", "clearanceDiameter"] as const) {
        expect(Number.isFinite(r[k]) && r[k] > 0, `${r.designation}.${k}`).toBe(true);
      }
    }
  });

  it("has a unique designation", () => {
    const names = allHoleSizes().map((r) => r.designation);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("findHoleSize", () => {
  it("is case- and separator-insensitive, because designations get written many ways", () => {
    const canonical = findHoleSize("M10x1.25");
    expect(findHoleSize("m10x1.25")).toEqual(canonical);
    expect(findHoleSize("M10X1.25")).toEqual(canonical);
    expect(findHoleSize(" M10 x1.25 ")).toEqual(canonical);
  });

  it("narrows by standard when asked", () => {
    expect(findHoleSize("M6", "iso-metric-coarse")).not.toBeNull();
    expect(findHoleSize("M6", "unc")).toBeNull();
  });

  it("returns null rather than throwing for anything unknown", () => {
    expect(findHoleSize("M7")).toBeNull();
    expect(findHoleSize("")).toBeNull();
    expect(findHoleSize("   ")).toBeNull();
    expect(findHoleSize("not a thread")).toBeNull();
  });
});

describe("depthPresetsFor", () => {
  it("scales with the thread's major diameter", () => {
    const presets = depthPresetsFor(findHoleSize("M6")!);
    expect(presets.map((p) => p.depth)).toEqual([6, 9, 12, 15]);
  });

  it("labels each preset rather than implying one correct answer", () => {
    for (const p of depthPresetsFor(findHoleSize("M8")!)) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.depth).toBeGreaterThan(0);
    }
  });

  it("returns them in ascending depth order", () => {
    const d = depthPresetsFor(findHoleSize("M12")!).map((p) => p.depth);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
  });
});
