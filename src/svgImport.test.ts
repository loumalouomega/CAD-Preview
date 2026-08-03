import { describe, it, expect } from "vitest";
import { extractPathData, parsePathData, parseSvgPaths } from "./svgImport";

function round(p: [number, number]): [number, number] {
  return [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];
}

describe("extractPathData", () => {
  it("extracts a single path's d attribute (double quotes)", () => {
    const svg = `<svg><path d="M0 0 L10 10 Z" fill="red"/></svg>`;
    expect(extractPathData(svg)).toEqual(["M0 0 L10 10 Z"]);
  });

  it("extracts a single quoted d attribute", () => {
    const svg = `<svg><path d='M0 0 L10 10 Z'/></svg>`;
    expect(extractPathData(svg)).toEqual(["M0 0 L10 10 Z"]);
  });

  it("extracts multiple paths in document order, ignoring non-path elements", () => {
    const svg = `<svg><rect x="0" y="0" width="10" height="10"/><path d="M0 0 L1 1"/><circle cx="5" cy="5" r="2"/><path d="M2 2 L3 3"/></svg>`;
    expect(extractPathData(svg)).toEqual(["M0 0 L1 1", "M2 2 L3 3"]);
  });

  it("returns an empty array for an SVG with no paths", () => {
    expect(extractPathData(`<svg><rect x="0" y="0" width="1" height="1"/></svg>`)).toEqual([]);
  });
});

describe("parsePathData — lines", () => {
  it("M + L builds a simple open polyline", () => {
    const result = parsePathData("M0 0 L10 0 L10 10");
    expect(result).toHaveLength(1);
    expect(result[0].closed).toBe(false);
    expect(result[0].points.map(round)).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it("Z closes the subpath", () => {
    const result = parsePathData("M0 0 L10 0 L10 10 Z");
    expect(result[0].closed).toBe(true);
  });

  it("implicit L after M (repeated coordinate pairs with no command letter)", () => {
    const result = parsePathData("M0 0 10 0 10 10");
    expect(result[0].points.map(round)).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it("relative lowercase commands accumulate from the current point", () => {
    const result = parsePathData("m0 0 l10 0 l0 10");
    expect(result[0].points.map(round)).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it("H/V move only one axis, relative and absolute", () => {
    const result = parsePathData("M0 0 H10 V5 h-5 v-5");
    expect(result[0].points.map(round)).toEqual([[0, 0], [10, 0], [10, 5], [5, 5], [5, 0]]);
  });

  it("multiple M...Z subpaths in one d attribute", () => {
    const result = parsePathData("M0 0 L1 0 Z M5 5 L6 5 Z");
    expect(result).toHaveLength(2);
    expect(result[0].closed).toBe(true);
    expect(result[1].closed).toBe(true);
    expect(result[1].points.map(round)[0]).toEqual([5, 5]);
  });

  it("numbers glued together with no separator (e.g. '1.5.5' -> 1.5, .5)", () => {
    const result = parsePathData("M0 0 L1.5.5 2 2");
    expect(result[0].points.map(round)).toEqual([[0, 0], [1.5, 0.5], [2, 2]]);
  });
});

describe("parsePathData — curves", () => {
  it("cubic bezier (C) flattens into multiple points ending exactly at the endpoint", () => {
    const result = parsePathData("M0 0 C0 10 10 10 10 0");
    const pts = result[0].points;
    expect(pts.length).toBeGreaterThan(2); // genuinely flattened, not a single segment
    expect(round(pts[pts.length - 1])).toEqual([10, 0]);
  });

  it("quadratic bezier (Q) flattens and ends exactly at the endpoint", () => {
    const result = parsePathData("M0 0 Q5 10 10 0");
    const pts = result[0].points;
    expect(pts.length).toBeGreaterThan(2);
    expect(round(pts[pts.length - 1])).toEqual([10, 0]);
  });

  it("S (smooth cubic) reflects the previous C's control point", () => {
    // A symmetric S-curve: C then S should produce a smooth, continuous curve
    // ending exactly at each specified endpoint.
    const result = parsePathData("M0 0 C0 10 10 10 10 0 S20 -10 20 0");
    const pts = result[0].points;
    expect(round(pts[pts.length - 1])).toEqual([20, 0]);
  });

  it("T (smooth quadratic) reflects the previous Q's control point", () => {
    const result = parsePathData("M0 0 Q5 10 10 0 T20 0");
    const pts = result[0].points;
    expect(round(pts[pts.length - 1])).toEqual([20, 0]);
  });

  it("S/T with no preceding C/Q respectively falls back to reflecting the current point (a zero-length control)", () => {
    // Per spec: if there's no previous C/S (for S) or Q/T (for T), the
    // control point is coincident with the current point.
    expect(() => parsePathData("M0 0 S10 10 10 0")).not.toThrow();
    expect(() => parsePathData("M0 0 T10 0")).not.toThrow();
  });
});

describe("parsePathData — arcs", () => {
  it("a semicircular arc ends exactly at the specified endpoint", () => {
    const result = parsePathData("M0 0 A5 5 0 0 1 10 0");
    const pts = result[0].points;
    expect(pts.length).toBeGreaterThan(2);
    expect(round(pts[pts.length - 1])).toEqual([10, 0]);
  });

  it("a full circle drawn as two semicircular arcs closes back to the start", () => {
    const result = parsePathData("M0 0 A5 5 0 1 1 10 0 A5 5 0 1 1 0 0 Z");
    expect(result[0].closed).toBe(true);
    const pts = result[0].points;
    // The midpoint of the two arcs should bulge away from the chord — a
    // sanity check that this isn't degenerating to a straight line.
    const ys = pts.map((p) => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(5);
  });

  it("a degenerate arc (zero radius) degrades to a straight line to the endpoint, not a crash", () => {
    const result = parsePathData("M0 0 A0 0 0 0 1 10 0");
    expect(result[0].points.map(round)).toEqual([[0, 0], [10, 0]]);
  });

  it("a degenerate arc (coincident start/end) degrades gracefully", () => {
    expect(() => parsePathData("M0 0 A5 5 0 0 1 0 0")).not.toThrow();
  });
});

describe("parseSvgPaths", () => {
  it("parses every <path> in a document into a flat list of subpaths", () => {
    const svg = `<svg><path d="M0 0 L1 0 Z"/><path d="M2 2 L3 2 L3 3 Z"/></svg>`;
    const result = parseSvgPaths(svg);
    expect(result).toHaveLength(2);
    expect(result[0].closed).toBe(true);
    expect(result[1].points).toHaveLength(3);
  });

  it("a real-shaped multi-subpath single path (e.g. a letter with a hole) yields two subpaths", () => {
    const svg = `<svg><path d="M0 0 L10 0 L10 10 L0 10 Z M3 3 L7 3 L7 7 L3 7 Z"/></svg>`;
    const result = parseSvgPaths(svg);
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.closed)).toBe(true);
  });
});
