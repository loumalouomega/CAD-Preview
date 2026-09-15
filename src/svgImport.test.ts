import { describe, it, expect } from "vitest";
import { extractPathData, parsePathData, parseSvgPaths, parseSvgDocument, svgSubpathsToPolylineOps } from "./svgImport";

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

describe("parseSvgDocument — transform composition", () => {
  it("applies a translate on the path itself", () => {
    const svg = `<svg><path transform="translate(10,20)" d="M0 0 L1 0"/></svg>`;
    const { subpaths } = parseSvgDocument(svg);
    expect(subpaths[0].points.map(round)).toEqual([[10, 20], [11, 20]]);
  });

  it("composes an ancestor <g> transform with the element's own, ancestor applied last (outermost)", () => {
    const svg = `<svg><g transform="translate(100,0)"><path transform="scale(2)" d="M0 0 L1 0"/></g></svg>`;
    const { subpaths } = parseSvgDocument(svg);
    // scale(2) first -> (0,0),(2,0); then translate(100,0) -> (100,0),(102,0)
    expect(subpaths[0].points.map(round)).toEqual([[100, 0], [102, 0]]);
  });

  it("composes NESTED <g> transforms (a real text-to-outlines export shape)", () => {
    const svg = `<svg><g transform="translate(10,10)"><g transform="translate(5,0)"><path d="M0 0 L1 1"/></g></g></svg>`;
    const { subpaths } = parseSvgDocument(svg);
    expect(subpaths[0].points.map(round)).toEqual([[15, 10], [16, 11]]);
  });

  it("rotate(a) about the origin, then rotate(a, cx, cy) about a point", () => {
    const around90 = parseSvgDocument(`<svg><path transform="rotate(90)" d="M1 0 L2 0"/></svg>`).subpaths[0];
    expect(around90.points.map(round)).toEqual([[0, 1], [0, 2]]);

    const aboutPoint = parseSvgDocument(`<svg><path transform="rotate(180,5,0)" d="M6 0 L7 0"/></svg>`).subpaths[0];
    expect(aboutPoint.points.map(round)).toEqual([[4, 0], [3, 0]]);
  });

  it("skewX/skewY transforms shear points", () => {
    const skewed = parseSvgDocument(`<svg><path transform="skewX(45)" d="M0 1 L0 2"/></svg>`).subpaths[0];
    // tan(45deg) = 1, so x' = x + y*1 for skewX
    expect(skewed.points.map(round)).toEqual([[1, 1], [2, 2]]);
  });

  it("an unrecognized/malformed transform function contributes the identity, not a throw", () => {
    expect(() => parseSvgDocument(`<svg><path transform="foo(1,2,3) translate(5,0)" d="M0 0 L1 0"/></svg>`)).not.toThrow();
    const { subpaths } = parseSvgDocument(`<svg><path transform="translate(5,0)" d="M0 0"/></svg>`);
    expect(subpaths[0].points.map(round)).toEqual([[5, 0]]);
  });
});

describe("parseSvgDocument — additional shape elements", () => {
  it("<rect> with no radius produces 4 corner points", () => {
    const { subpaths } = parseSvgDocument(`<svg><rect x="0" y="0" width="10" height="5"/></svg>`);
    expect(subpaths).toHaveLength(1);
    expect(subpaths[0].closed).toBe(true);
    expect(subpaths[0].points.map(round)).toEqual([[0, 0], [10, 0], [10, 5], [0, 5]]);
  });

  it("<rect> with rx/ry produces a rounded outline whose bbox matches the plain rect", () => {
    const { subpaths } = parseSvgDocument(`<svg><rect x="0" y="0" width="10" height="6" rx="2" ry="2"/></svg>`);
    const pts = subpaths[0].points;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(10, 6);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(6, 6);
    expect(subpaths[0].closed).toBe(true);
    // more points than a plain 4-corner rect (rounded corners sampled)
    expect(pts.length).toBeGreaterThan(4);
  });

  it("<rect> rx/ry each default to the other, and clamp to half the box", () => {
    const { subpaths } = parseSvgDocument(`<svg><rect x="0" y="0" width="10" height="10" rx="100"/></svg>`);
    const xs = subpaths[0].points.map((p) => p[0]);
    expect(Math.max(...xs)).toBeCloseTo(10, 6);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
  });

  it("<circle> produces a closed loop with the right radius", () => {
    const { subpaths } = parseSvgDocument(`<svg><circle cx="5" cy="5" r="3"/></svg>`);
    expect(subpaths[0].closed).toBe(true);
    for (const [x, y] of subpaths[0].points) {
      expect(Math.hypot(x - 5, y - 5)).toBeCloseTo(3, 6);
    }
  });

  it("<ellipse> produces a closed loop matching both radii", () => {
    const { subpaths } = parseSvgDocument(`<svg><ellipse cx="0" cy="0" rx="4" ry="2"/></svg>`);
    const xs = subpaths[0].points.map((p) => p[0]);
    const ys = subpaths[0].points.map((p) => p[1]);
    expect(Math.max(...xs)).toBeCloseTo(4, 6);
    expect(Math.max(...ys)).toBeCloseTo(2, 6);
  });

  it("<line> produces a two-point OPEN subpath", () => {
    const { subpaths } = parseSvgDocument(`<svg><line x1="0" y1="0" x2="5" y2="5"/></svg>`);
    expect(subpaths[0].closed).toBe(false);
    expect(subpaths[0].points.map(round)).toEqual([[0, 0], [5, 5]]);
  });

  it("<polyline> is open, <polygon> is closed, both parse comma- or space-separated points", () => {
    const line = parseSvgDocument(`<svg><polyline points="0,0 1,1 2,0"/></svg>`).subpaths[0];
    expect(line.closed).toBe(false);
    expect(line.points.map(round)).toEqual([[0, 0], [1, 1], [2, 0]]);

    const poly = parseSvgDocument(`<svg><polygon points="0 0, 1 1, 2 0"/></svg>`).subpaths[0];
    expect(poly.closed).toBe(true);
    expect(poly.points.map(round)).toEqual([[0, 0], [1, 1], [2, 0]]);
  });

  it("a <rect>/<circle>/etc. with no meaningful size contributes nothing, not a degenerate point", () => {
    expect(parseSvgDocument(`<svg><rect x="0" y="0" width="0" height="5"/></svg>`).subpaths).toHaveLength(0);
    expect(parseSvgDocument(`<svg><circle cx="0" cy="0" r="0"/></svg>`).subpaths).toHaveLength(0);
    expect(parseSvgDocument(`<svg><polyline points="1,1"/></svg>`).subpaths).toHaveLength(0);
  });
});

describe("parseSvgDocument — skipped subtrees and warnings", () => {
  it("skips <defs>/<clipPath>/<mask>/<symbol>/<marker>/<pattern> subtrees entirely", () => {
    const svg = `<svg>
      <defs><path d="M0 0 L1 1"/></defs>
      <clipPath id="c"><rect x="0" y="0" width="1" height="1"/></clipPath>
      <mask id="m"><circle cx="0" cy="0" r="1"/></mask>
      <path d="M5 5 L6 6"/>
    </svg>`;
    const { subpaths, warnings } = parseSvgDocument(svg);
    expect(subpaths).toHaveLength(1);
    expect(subpaths[0].points.map(round)).toEqual([[5, 5], [6, 6]]);
    expect(warnings).toEqual([]);
  });

  it("a real element AFTER a skipped subtree still inherits the correct (unaffected) ancestor transform", () => {
    const svg = `<svg><g transform="translate(1,0)"><defs><path d="M0 0 L1 1"/></defs><path d="M0 0 L1 0"/></g></svg>`;
    const { subpaths } = parseSvgDocument(svg);
    expect(subpaths).toHaveLength(1);
    expect(subpaths[0].points.map(round)).toEqual([[1, 0], [2, 0]]);
  });

  it("<use> is recognized and warned about, not silently ignored or dereferenced", () => {
    const svg = `<svg><use href="#thing" x="5" y="5"/></svg>`;
    const { subpaths, warnings } = parseSvgDocument(svg);
    expect(subpaths).toHaveLength(0);
    expect(warnings.some((w) => w.includes("<use>"))).toBe(true);
  });

  it("<text> is recognized and warned about, and its subtree (e.g. <tspan>) is skipped", () => {
    const svg = `<svg><text x="0" y="0"><tspan>hello</tspan></text><path d="M0 0 L1 0"/></svg>`;
    const { subpaths, warnings } = parseSvgDocument(svg);
    expect(subpaths).toHaveLength(1); // only the real path, not any tspan geometry
    expect(warnings.some((w) => w.includes("<text>") && w.includes("outlines"))).toBe(true);
  });

  it("a repeated <use>/<text> warns only once each, not once per occurrence", () => {
    const svg = `<svg><use href="#a"/><use href="#b"/><text>a</text><text>b</text></svg>`;
    const { warnings } = parseSvgDocument(svg);
    expect(warnings).toHaveLength(2);
  });

  it("comments are stripped and never confused for tags", () => {
    const svg = `<svg><!-- <path d="M0 0 L99 99"/> --><path d="M1 1 L2 2"/></svg>`;
    const { subpaths } = parseSvgDocument(svg);
    expect(subpaths).toHaveLength(1);
    expect(subpaths[0].points.map(round)).toEqual([[1, 1], [2, 2]]);
  });

  it("an unbalanced/malformed close tag never throws", () => {
    expect(() => parseSvgDocument(`<svg></g><path d="M0 0 L1 1"/></svg>`)).not.toThrow();
  });
});

describe("svgSubpathsToPolylineOps", () => {
  it("Y-flips into the XY plane at z=0 by default", () => {
    const [placed] = svgSubpathsToPolylineOps([{ points: [[0, 0], [1, 2], [3, 4]], closed: false }]);
    expect(placed.points).toEqual([[0, 0, 0], [1, -2, 0], [3, -4, 0]]);
    expect(placed.closed).toBe(false);
  });

  it("applies scale after the Y-flip, and an origin offset after scaling", () => {
    const [placed] = svgSubpathsToPolylineOps(
      [{ points: [[1, 1], [2, 2]], closed: false }],
      { scale: 10, origin: [100, 200, 5] }
    );
    expect(placed.points).toEqual([[110, 190, 5], [120, 180, 5]]);
  });

  it("drops a degenerate subpath (fewer than 2 points)", () => {
    expect(svgSubpathsToPolylineOps([{ points: [[0, 0]], closed: false }])).toEqual([]);
  });

  it("drops a closed subpath whose first/last point coincide after the flip, or that has fewer than 3 points", () => {
    expect(svgSubpathsToPolylineOps([{ points: [[0, 0], [1, 0]], closed: true }])).toEqual([]);
    expect(svgSubpathsToPolylineOps([{ points: [[0, 0], [1, 0], [0, 0]], closed: true }])).toEqual([]);
  });

  it("keeps a genuine closed triangle", () => {
    const result = svgSubpathsToPolylineOps([{ points: [[0, 0], [1, 0], [0, 1]], closed: true }]);
    expect(result).toHaveLength(1);
    expect(result[0].closed).toBe(true);
  });
});
