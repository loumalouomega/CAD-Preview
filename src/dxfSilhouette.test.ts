import { describe, it, expect } from "vitest";
import { segmentsToPolylines, silhouetteDxf, polylinesDxf } from "./dxfSilhouette";
import { parseDxf } from "./dxfImport";

describe("segmentsToPolylines", () => {
  it("chains two connected segments into one polyline", () => {
    const segs: Array<[[number, number],[number, number]]> = [[[0,0],[1,0]], [[1,0],[1,1]]];
    const chains = segmentsToPolylines(segs);
    expect(chains.length).toBe(1);
    expect(chains[0].points).toEqual([[0,0],[1,0],[1,1]]);
    expect(chains[0].closed).toBe(false);
  });

  it("leaves two disconnected segments as two chains", () => {
    const segs: Array<[[number, number],[number, number]]> = [[[0,0],[1,0]], [[10,10],[11,10]]];
    const chains = segmentsToPolylines(segs);
    expect(chains.length).toBe(2);
  });

  it("detects closed loop", () => {
    const segs: Array<[[number, number],[number, number]]> = [[[0,0],[1,0]], [[1,0],[1,1]], [[1,1],[0,1]], [[0,1],[0,0]]];
    const chains = segmentsToPolylines(segs);
    expect(chains.length).toBe(1);
    expect(chains[0].closed).toBe(true);
    expect(chains[0].points).toEqual([[0,0],[1,0],[1,1],[0,1]]);
  });

  it("handles reverse-wired segment", () => {
    const segs: Array<[[number, number],[number, number]]> = [[[0,0],[1,0]], [[2,0],[1,0]]];
    const chains = segmentsToPolylines(segs);
    expect(chains.length).toBe(1);
    expect(chains[0].points.length).toBe(3);
    expect(chains[0].closed).toBe(false);
  });

  it("returns empty for empty input", () => {
    expect(segmentsToPolylines([])).toEqual([]);
  });
});

describe("silhouetteDxf / polylinesDxf", () => {
  it("produces valid DXF with HEADER and ENTITIES", () => {
    const positions = new Float32Array([0,0,0, 10,0,0, 10,10,0, 0,10,0]);
    const edges: Array<[number, number]> = [[0,1],[1,2],[2,3],[3,0]];
    const result = silhouetteDxf(positions, edges, { direction:[0,0,1] });
    expect(result.dxf).toContain("SECTION");
    expect(result.dxf).toContain("ENTITIES");
    expect(result.dxf).toContain("EOF");
    expect(result.segmentCount).toBe(4);
    // Square outline should chain into one closed polyline
    expect(result.chainCount).toBe(1);
    expect(result.lineCount).toBe(0);
    expect(result.dxf).toContain("LWPOLYLINE");
  });

  it("round-trips through parseDxf (LINEs)", () => {
    const positions = new Float32Array([0,0,0, 5,0,0]);
    const edges: Array<[number, number]> = [[0,1]];
    const result = silhouetteDxf(positions, edges, { direction:[0,0,1] });
    // Single segment => LINE (not LWPOLYLINE) per the "Both" decision
    expect(result.lineCount).toBe(1);
    expect(result.chainCount).toBe(0);
    expect(result.dxf).toContain("LINE");
    const { ops } = parseDxf(result.dxf);
    expect(ops.length).toBe(1);
    expect(ops[0].op).toBe("addLine");
  });

  it("round-trips a closed square as one polyline", () => {
    const positions = new Float32Array([0,0,0, 10,0,0, 10,10,0, 0,10,0]);
    const edges: Array<[number, number]> = [[0,1],[1,2],[2,3],[3,0]];
    const result = silhouetteDxf(positions, edges, { direction:[0,0,1] });
    const { ops } = parseDxf(result.dxf);
    // Closed square as LWPOLYLINE => one addPolyline closed
    expect(ops.length).toBe(1);
    expect(ops[0]).toMatchObject({ op:"addPolyline", closed:true });
  });

  it("polylinesDxf handles polyline input", () => {
    const poly = new Float32Array([0,0,0, 10,0,0, 10,10,0]);
    const result = polylinesDxf([poly], { direction:[0,0,1] });
    expect(result.segmentCount).toBe(2);
    expect(result.dxf).toContain("LWPOLYLINE");
  });

  it("handles empty inputs", () => {
    const result = silhouetteDxf(new Float32Array([]), [], { direction:[0,0,1] });
    expect(result.segmentCount).toBe(0);
    expect(result.dxf).toContain("EOF");
  });

  it("isolated segments become LINEs", () => {
    const segs: Array<[number, number]> = [[0,1]] as unknown as Array<[number, number]>;
    // Use silhouetteDxf with two far apart segments
    const positions = new Float32Array([0,0,0, 1,0,0, 100,100,0, 101,100,0]);
    const edges: Array<[number, number]> = [[0,1],[2,3]];
    const result = silhouetteDxf(positions, edges, { direction:[0,0,1] });
    expect(result.lineCount).toBe(2);
    expect(result.chainCount).toBe(0);
    expect(result.dxf.match(/LINE/g)?.length).toBe(2);
  });
});

describe("dimension glyphs in DXF export", () => {
  /** A 10×10 square in the z=0 plane, viewed down +Z. */
  function squareDxf(options: Parameters<typeof silhouetteDxf>[3]) {
    const positions = new Float32Array([0,0,0, 10,0,0, 10,10,0, 0,10,0]);
    const edges: Array<[number, number]> = [[0,1],[1,2],[2,3],[3,0]];
    return silhouetteDxf(positions, edges, { direction: [0, 0, 1] }, options);
  }

  it("emits DIMENSIONS-layer LINE/LWPOLYLINE/TEXT entities for a pinned annotation", () => {
    const result = squareDxf({
      annotations: [{ anchorPoint: [5, 0, 10], linePoints: [[0, 0, 0], [10, 0, 0]], text: "10 mm" }],
      dimensionScaleHint: 14.2,
    });
    expect(result.dimensionCount).toBe(1);
    expect(result.dxf).toContain("DIMENSIONS");
    expect(result.dxf).toContain("TEXT");
    expect(result.dxf).toContain("10 mm");
    // Arrowheads are closed 3-vertex LWPOLYLINEs on the dimensions layer.
    expect(result.dxf).toMatch(/LWPOLYLINE\n8\nDIMENSIONS/);
    // Outline geometry stays on layer "0".
    expect(result.dxf).toContain("LWPOLYLINE\n8\n0");
    expect(result.segmentCount).toBe(4);
  });

  it("round-trips through the repo's own DXF reader without warnings", () => {
    const result = squareDxf({
      annotations: [{ anchorPoint: [5, 0, 10], linePoints: [[0, 0, 0], [10, 0, 0]], text: "10 mm" }],
      dimensionScaleHint: 14.2,
    });
    const parsed = parseDxf(result.dxf);
    expect(parsed.ops.length).toBeGreaterThan(0);
    expect(parsed.warnings).toEqual([]);
  });

  it("decorates toleranced labels and escapes XML-hostile text", () => {
    const result = squareDxf({
      annotations: [{ anchorPoint: [5, 0, 10], linePoints: [[0, 0, 0], [10, 0, 0]], text: "10 mm", tolerance: { nominal: 10, plus: 0.1, minus: 0.02, measured: 10.05 } }],
      dimensionScaleHint: 14.2,
    });
    expect(result.dxf).toContain("[10 +0.1/−0.02]");
  });

  it("renders a lineless pin as a bare TEXT label at its anchor", () => {
    const result = squareDxf({
      annotations: [{ anchorPoint: [20, 20, 0], linePoints: [], text: "R = 5 mm" }],
      dimensionScaleHint: 14.2,
    });
    expect(result.dimensionCount).toBe(1);
    expect(result.dxf).toContain("R = 5 mm");
    expect(result.dxf).not.toMatch(/LINE\n8\nDIMENSIONS/);
  });

  it("degenerate pins are skipped — no NaN ever reaches the file", () => {
    const result = squareDxf({
      annotations: [{ anchorPoint: [NaN, 0, 0], linePoints: [[0, 0, 0], [0, 0, 0]], text: "?" }],
      dimensionScaleHint: 14.2,
    });
    expect(result.dimensionCount).toBeUndefined();
    expect(result.dxf).not.toMatch(/NaN|Infinity/);
  });
});
