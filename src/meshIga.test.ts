import { describe, expect, test } from "vitest";
import { buildCadRead, healReportOf } from "./meshIga";

describe("buildCadRead", () => {
  test("undefined / null / empty pass nothing (a default read stays byte-identical)", () => {
    expect(buildCadRead(undefined)).toBeUndefined();
    expect(buildCadRead(null)).toBeUndefined();
    expect(buildCadRead({})).toBeUndefined();
    expect(buildCadRead({ deflection: undefined, heal: undefined })).toBeUndefined();
  });
  test("forwards only the keys that were set", () => {
    expect(buildCadRead({ heal: true })).toEqual({ heal: true });
    expect(buildCadRead({ deflection: 5, angularDeflection: 1 })).toEqual({ deflection: 5, angularDeflection: 1 });
    expect(buildCadRead({ sewTolerance: 0 })).toEqual({ sewTolerance: 0 });
  });
  test("non-finite numbers and non-boolean heal are refused by name", () => {
    expect(() => buildCadRead({ deflection: NaN })).toThrow(/cadRead\.deflection/);
    expect(() => buildCadRead({ sewTolerance: Infinity })).toThrow(/cadRead\.sewTolerance/);
    expect(() => buildCadRead({ heal: "yes" as unknown as boolean })).toThrow(/cadRead\.heal/);
  });
});

describe("healReportOf", () => {
  test("maps upstream's snake_case heal member", () => {
    const extra = JSON.stringify({ version_number: 1, heal: { healed: true, fixed: false, sew_tolerance: 0.025, free_edges_before: 2, free_edges_after: 0, multiple_edges: 0, degenerated: 1 } });
    expect(healReportOf({ extra })).toEqual({ healed: true, fixed: false, sewTolerance: 0.025, freeEdgesBefore: 2, freeEdgesAfter: 0, multipleEdges: 0, degenerated: 1 });
  });
  test("absent, malformed or heal-less extra yields undefined", () => {
    expect(healReportOf({})).toBeUndefined();
    expect(healReportOf({ extra: "{not json" })).toBeUndefined();
    expect(healReportOf({ extra: JSON.stringify({ version_number: 1 }) })).toBeUndefined();
  });
});
