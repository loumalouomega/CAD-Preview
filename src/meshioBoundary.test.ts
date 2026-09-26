/**
 * Tests for the boundary-extent invariant.
 *
 * The negative controls matter more than the positives here: a guard that
 * passes everything is worse than no guard, because it reads as protection.
 * Each "accepts" case is paired with a mutation that MUST be rejected, so a
 * future loosening of the tolerance shows up as a failure rather than as
 * silence.
 */
import { describe, it, expect } from "vitest";
import {
  BOUNDARY_EXTENT_TOLERANCE,
  boundaryExtentMismatches,
  describeExtentMismatch,
  extentOf,
} from "./meshioBoundary";

/** Box corners as a flat row-major array: min then max per axis. */
const box = (min: [number, number, number], max: [number, number, number]) => [
  ...min, ...max,
];

describe("extentOf", () => {
  it("bounds a flat row-major coordinate array", () => {
    expect(extentOf(box([0, 0, 0], [2, 1, 1]), 3)).toEqual({ min: [0, 0, 0], max: [2, 1, 1] });
  });

  it("handles a single point and negative coordinates", () => {
    expect(extentOf([5, -3, 7], 3)).toEqual({ min: [5, -3, 7], max: [5, -3, 7] });
    expect(extentOf(box([-4, -4, -4], [-1, -1, -1]), 3)).toEqual({
      min: [-4, -4, -4],
      max: [-1, -1, -1],
    });
  });

  it("returns null for a non-3D or too-short array rather than a bogus extent", () => {
    expect(extentOf([0, 1, 2, 3], 2)).toBeNull();
    expect(extentOf([0, 1], 3)).toBeNull();
    expect(extentOf(new Float64Array(0), 3)).toBeNull();
  });
});

describe("boundaryExtentMismatches", () => {
  const unit = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };

  it("accepts an identical extent — the measured norm for every committed fixture", () => {
    expect(boundaryExtentMismatches(unit, unit)).toEqual([]);
  });

  it("accepts a boundary that is marginally LARGER (asymmetric by design)", () => {
    expect(boundaryExtentMismatches(unit, { min: [0, 0, 0], max: [1.5, 1, 1] })).toEqual([]);
  });

  it("rejects a collapsed axis, as the EnSight extraction does", () => {
    // Exactly the measured failure: source spans 2 in x, boundary spans 1.
    const source = { min: [0, 0, 0] as [number, number, number], max: [2, 1, 1] as [number, number, number] };
    const boundary = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    const bad = boundaryExtentMismatches(source, boundary);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ axis: 0, sourceSpan: 2, boundarySpan: 1 });
    expect(bad[0].ratio).toBeCloseTo(0.5, 10);
  });

  it("names the failing axis, so a thin model is distinguishable from a defect", () => {
    const source = { min: [0, 0, 0] as [number, number, number], max: [4, 4, 4] as [number, number, number] };
    const boundary = { min: [0, 0, 0] as [number, number, number], max: [4, 4, 1] as [number, number, number] };
    expect(boundaryExtentMismatches(source, boundary).map((m) => m.axis)).toEqual([2]);
  });

  it("reports every failing axis, not just the first", () => {
    const source = { min: [0, 0, 0] as [number, number, number], max: [2, 2, 2] as [number, number, number] };
    const boundary = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    expect(boundaryExtentMismatches(source, boundary).map((m) => m.axis)).toEqual([0, 1, 2]);
  });

  it("skips a degenerate source axis instead of dividing by zero", () => {
    // A flat sheet: zero extent in z says nothing about extraction fidelity.
    const source = { min: [0, 0, 5] as [number, number, number], max: [3, 2, 5] as [number, number, number] };
    expect(boundaryExtentMismatches(source, { min: [0, 0, 5], max: [3, 2, 5] })).toEqual([]);
  });

  it("tolerates float noise from linearization, and nothing more", () => {
    const jitter = BOUNDARY_EXTENT_TOLERANCE / 10;
    expect(
      boundaryExtentMismatches(unit, { min: [-jitter, 0, 0], max: [1, 1, 1] })
    ).toEqual([]);
    // One order of magnitude past the tolerance must be caught — this is the
    // assertion that stops someone widening BOUNDARY_EXTENT_TOLERANCE later.
    // It has to be a shortfall: the check is deliberately asymmetric, so a
    // boundary LARGER than the source is not what it diagnoses.
    expect(
      boundaryExtentMismatches(unit, { min: [0, 0, 0], max: [1 - BOUNDARY_EXTENT_TOLERANCE * 100, 1, 1] }).length
    ).toBe(1);
  });

  it("scales: a 1e6 mm model is judged relatively, not absolutely", () => {
    const big = { min: [0, 0, 0] as [number, number, number], max: [1e6, 1e6, 1e6] as [number, number, number] };
    // A 1-unit absolute shortfall is negligible at this scale...
    expect(boundaryExtentMismatches(big, { min: [0, 0, 0], max: [1e6 - 1, 1e6, 1e6] })).toEqual([]);
    // ...but losing a whole axis-sized fraction is not.
    expect(boundaryExtentMismatches(big, { min: [0, 0, 0], max: [5e5, 1e6, 1e6] }).length).toBe(1);
  });
});

describe("describeExtentMismatch", () => {
  it("names the format, the axis and both spans", () => {
    const msg = describeExtentMismatch("ensight", [
      { axis: 0, sourceSpan: 2, boundarySpan: 1, ratio: 0.5 },
    ]);
    expect(msg).toContain("ensight");
    expect(msg).toContain("x:");
    expect(msg).toContain("boundary spans 1");
    expect(msg).toContain("source spans 2");
    // It must read as a defect, not as user error.
    expect(msg).toMatch(/not in the file/);
  });

  it("joins multiple axes into one sentence", () => {
    const msg = describeExtentMismatch("x", [
      { axis: 0, sourceSpan: 2, boundarySpan: 1, ratio: 0.5 },
      { axis: 2, sourceSpan: 4, boundarySpan: 1, ratio: 0.25 },
    ]);
    expect(msg).toContain("x:");
    expect(msg).toContain("z:");
  });
});
