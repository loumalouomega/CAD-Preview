import { describe, it, expect } from "vitest";
import { viewBasis, silhouetteSvg, polylinesSvg, scalePositions } from "./svgSilhouette";
import { parseSvgPaths } from "./svgImport";
import { silhouetteEdges } from "./silhouetteEdges";
import { weldTriangleSoup } from "./meshComponents";

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** A closed 10×10×10 cube at the origin corner. */
function bigCube() {
  const v = [
    [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
    [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
  ];
  const faces = [
    [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const soup: number[] = [];
  for (const f of faces) for (const i of f) soup.push(...v[i]);
  return weldTriangleSoup(new Float32Array(soup));
}

describe("viewBasis", () => {
  it("produces an orthonormal right-handed basis", () => {
    const { right, up, forward } = viewBasis([1, 0.8, 1]);
    for (const v of [right, up, forward]) expect(Math.hypot(...v)).toBeCloseTo(1, 10);
    expect(dot(right, up)).toBeCloseTo(0, 10);
    expect(dot(right, forward)).toBeCloseTo(0, 10);
    expect(dot(up, forward)).toBeCloseTo(0, 10);
  });

  it("falls back to a different up hint when the given one is parallel to the view", () => {
    // The straight-down TOP view: the default [0,1,0] up is parallel to it.
    const basis = viewBasis([0, 1, 0]);
    for (const v of [basis.right, basis.up, basis.forward]) {
      for (const c of v) expect(Number.isFinite(c)).toBe(true);
      expect(Math.hypot(...v)).toBeCloseTo(1, 10);
    }
  });

  it("honours an explicit up hint", () => {
    const basis = viewBasis([0, 1, 0], [0, 0, -1]);
    expect(Math.hypot(...basis.right)).toBeCloseTo(1, 10);
    expect(dot(basis.forward, [0, 1, 0])).toBeCloseTo(1, 10);
  });
});

describe("silhouetteSvg", () => {
  it("renders a cube's front view as a 4-segment square with a matching viewBox", () => {
    const { positions, indices } = bigCube();
    const edges = silhouetteEdges(positions, indices, [0, 0, 1]);
    const { svg, segmentCount } = silhouetteSvg(positions, edges, { direction: [0, 0, 1] });

    expect(segmentCount).toBe(4);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');

    const viewBox = /viewBox="([^"]+)"/.exec(svg)![1].split(" ").map(Number);
    // 10 units across plus the default 2% margin on each side.
    expect(viewBox[2]).toBeCloseTo(10.4, 4);
    expect(viewBox[3]).toBeCloseTo(10.4, 4);
    expect(svg).toContain('width="10.4mm"');
    expect(svg).toContain('height="10.4mm"');
  });

  it("scales the stroke width with the drawing so it stays proportionate", () => {
    const { positions, indices } = bigCube();
    const edges = silhouetteEdges(positions, indices, [0, 0, 1]);
    const width = (svg: string) => Number(/stroke-width="([^"]+)"/.exec(svg)![1]);

    const native = silhouetteSvg(positions, edges, { direction: [0, 0, 1] });
    const inches = silhouetteSvg(scalePositions(positions, 1 / 25.4), edges, { direction: [0, 0, 1] });
    expect(width(native.svg) / width(inches.svg)).toBeCloseTo(25.4, 3);
  });

  it("keeps ~6 significant digits regardless of the drawing's scale", () => {
    // A 10-unit drawing scaled to feet has an extent of ~0.034; fixed 4-decimal
    // coordinates would leave it barely two significant digits and visibly
    // distort the outline.
    const { positions, indices } = bigCube();
    const edges = silhouetteEdges(positions, indices, [0, 0, 1]);
    const width = (svg: string) => Number(/viewBox="([^"]+)"/.exec(svg)![1].split(" ")[2]);

    const native = silhouetteSvg(positions, edges, { direction: [0, 0, 1] });
    const feet = silhouetteSvg(scalePositions(positions, 1 / 304.8), edges, { direction: [0, 0, 1] });
    expect(width(native.svg) / width(feet.svg)).toBeCloseTo(304.8, 1);
  });

  it("never rounds the stroke width down to zero on a tiny drawing", () => {
    // A sub-millimetre model (or the same model converted to feet) would make
    // a fixed-4-decimal stroke width round to "0", rendering nothing at all.
    const positions = new Float32Array([0, 0, 0, 0.001, 0.001, 0]);
    const { svg } = silhouetteSvg(positions, [[0, 1]], { direction: [0, 0, 1] });
    const strokeWidth = Number(/stroke-width="([^"]+)"/.exec(svg)![1]);
    expect(strokeWidth).toBeGreaterThan(0);
  });

  it("honours an explicit strokeWidth, margin, stroke colour and title", () => {
    const { positions, indices } = bigCube();
    const edges = silhouetteEdges(positions, indices, [0, 0, 1]);
    const { svg } = silhouetteSvg(positions, edges, { direction: [0, 0, 1] }, {
      strokeWidth: 0.25,
      marginFrac: 0,
      stroke: "#ff0000",
      title: "bull <front>",
    });
    expect(svg).toContain('stroke-width="0.25"');
    expect(svg).toContain('stroke="#ff0000"');
    expect(svg).toContain("<title>bull &lt;front&gt;</title>");
    const viewBox = /viewBox="([^"]+)"/.exec(svg)![1].split(" ").map(Number);
    expect(viewBox[2]).toBeCloseTo(10, 6);
  });

  it("emits a valid, empty document when there is nothing to draw", () => {
    const { svg, segmentCount } = silhouetteSvg(new Float32Array(0), [], { direction: [0, 0, 1] });
    expect(segmentCount).toBe(0);
    expect(svg).toContain('viewBox="0 0 1 1"');
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("Infinity");
  });

  it("emits a valid document when everything projects to a single point", () => {
    const positions = new Float32Array([1, 2, 3, 1, 2, 3]);
    const { svg } = silhouetteSvg(positions, [[0, 1]], { direction: [0, 0, 1] });
    expect(svg).not.toContain("NaN");
    const viewBox = /viewBox="([^"]+)"/.exec(svg)![1].split(" ").map(Number);
    for (const n of viewBox) expect(Number.isFinite(n)).toBe(true);
  });

  it("never emits a negative-zero coordinate", () => {
    const positions = new Float32Array([-0, -0, 0, 1, 1, 0]);
    const { svg } = silhouetteSvg(positions, [[0, 1]], { direction: [0, 0, 1] });
    const d = /\sd="([^"]+)"/.exec(svg)![1];
    // A standalone "-0" token, as opposed to a genuine value like "-0.02".
    expect(/(^|\s)-0(\s|$)/.test(d)).toBe(false);
    expect(d.startsWith("M 0 0 ")).toBe(true);
  });

  it("skips a segment with a non-finite coordinate rather than corrupting the viewBox", () => {
    const positions = new Float32Array([0, 0, 0, 1, 1, 0, NaN, 0, 0, 2, 2, 0]);
    const { svg, segmentCount } = silhouetteSvg(positions, [[0, 1], [2, 3]], { direction: [0, 0, 1] });
    expect(segmentCount).toBe(1);
    expect(svg).not.toContain("NaN");
  });
});

describe("polylinesSvg", () => {
  it("chains each polyline's points into consecutive segments", () => {
    const polyline = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    const { segmentCount } = polylinesSvg([polyline], { direction: [0, 0, 1] });
    expect(segmentCount).toBe(2);
  });

  it("breaks the chain around a non-finite point instead of bridging it", () => {
    const polyline = new Float32Array([0, 0, 0, NaN, 0, 0, 1, 1, 0, 2, 2, 0]);
    const { segmentCount } = polylinesSvg([polyline], { direction: [0, 0, 1] });
    expect(segmentCount).toBe(1); // only the final (1,1)→(2,2) pair survives
  });
});

describe("round trip through this repo's own SVG reader", () => {
  // The strongest cheap check on the `d` syntax: feed the writer's output to
  // `svgImport.ts`'s parser (the Import SVG feature) and confirm it recovers
  // exactly the segments that went in.
  it("svgImport recovers every segment the writer emitted", () => {
    const { positions, indices } = bigCube();
    const edges = silhouetteEdges(positions, indices, [1, 1, 1]);
    const { svg, segmentCount } = silhouetteSvg(positions, edges, { direction: [1, 1, 1] });

    const subpaths = parseSvgPaths(svg);
    expect(subpaths).toHaveLength(segmentCount);
    for (const subpath of subpaths) {
      expect(subpath.points).toHaveLength(2);
      expect(subpath.closed).toBe(false);
      for (const [x, y] of subpath.points) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
      }
    }
  });

  it("recovers the exact coordinates, not just the right count", () => {
    const positions = new Float32Array([0, 0, 0, 3, 4, 0]);
    const { svg } = silhouetteSvg(positions, [[0, 1]], { direction: [0, 0, 1] });
    const [subpath] = parseSvgPaths(svg);
    // Front view: x maps to screen x, y maps to NEGATED screen y (SVG is Y-down).
    expect(subpath.points[0][0]).toBeCloseTo(0, 4);
    expect(subpath.points[0][1]).toBeCloseTo(0, 4);
    expect(subpath.points[1][0]).toBeCloseTo(3, 4);
    expect(subpath.points[1][1]).toBeCloseTo(-4, 4);
  });
});

describe("scalePositions", () => {
  it("returns the same array untouched for a factor of 1", () => {
    const positions = new Float32Array([1, 2, 3]);
    expect(scalePositions(positions, 1)).toBe(positions);
  });

  it("scales every coordinate", () => {
    expect(Array.from(scalePositions(new Float32Array([1, 2, 3]), 2))).toEqual([2, 4, 6]);
  });
});
