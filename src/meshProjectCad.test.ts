import { describe, expect, it } from "vitest";
import { buildProjectCall, summarizeProjection, MAX_OUTSIDE_TRIM_LISTED } from "./meshProjectCad";

describe("buildProjectCall", () => {
  it("forwards only the options that were given", () => {
    expect(buildProjectCall({})).toEqual({});
    expect(buildProjectCall({ faceArray: "f", edgeArray: "e", maxDistance: 0.5, trimSamples: 8 })).toEqual({ faceArray: "f", edgeArray: "e", maxDistance: 0.5, trimSamples: 8 });
  });
  it("rejects bad values by name", () => {
    expect(() => buildProjectCall({ maxDistance: -1 })).toThrow(/maxDistance/);
    expect(() => buildProjectCall({ trimSamples: 0 })).toThrow(/trimSamples/);
    expect(() => buildProjectCall({ trimSamples: 1.5 })).toThrow(/trimSamples/);
    expect(() => buildProjectCall({ faceArray: "" })).toThrow(/faceArray/);
  });
});

describe("summarizeProjection", () => {
  const base = { numProjected: 128, numOnEdges: 44, numOnCurves: 44, numCorners: 8, numAmbiguous: 0, numTooFar: 0, numFailed: 0, numOutsideTrim: 0, maxMove: 0.0128, outsideTrim: [] as number[], warnings: [] as string[] };
  it("reports a clean run without warnings", () => {
    const r = summarizeProjection(base);
    expect(r).toMatchObject({ numProjected: 128, numOnEdges: 44, maxMove: 0.0128, outsideTrimTruncated: false });
    expect(r.warnings).toEqual([]);
  });
  it("warns about points left in place and caps the outside-trim list with the true count", () => {
    const ids = Array.from({ length: MAX_OUTSIDE_TRIM_LISTED + 5 }, (_, i) => i);
    const r = summarizeProjection({ ...base, numTooFar: 77, numFailed: 2, numOutsideTrim: ids.length, outsideTrim: ids });
    expect(r.outsideTrim).toHaveLength(MAX_OUTSIDE_TRIM_LISTED);
    expect(r.outsideTrimTruncated).toBe(true);
    expect(r.numOutsideTrim).toBe(ids.length);
    expect(r.warnings.join("|")).toMatch(/77 point\(s\) were farther than maxDistance/);
    expect(r.warnings.join("|")).toMatch(/2 point\(s\) could not be projected/);
    expect(r.warnings.join("|")).toMatch(/capped at 200/);
  });
});
