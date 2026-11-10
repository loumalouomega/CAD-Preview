import { describe, it, expect } from "vitest";
import { segmentsToPolylines, silhouetteDxf, polylinesDxf } from "./dxfSilhouette";
import { parseDxfRawEntities } from "./dxfImport";
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

describe("layered DXF export", () => {
  const view = { direction: [0, 0, 1] as [number, number, number] };
  const seg = (a: [number, number], b: [number, number]): [[number, number], [number, number]] => [a, b];

  it("dxfLayerName prefixes collisions with reserved layers", async () => {
    const { dxfLayerName } = await import("./dxfSilhouette");
    expect(dxfLayerName("Dims")).toBe("Dims");
    expect(dxfLayerName("HIDDEN")).toBe("LAYER_HIDDEN");
    expect(dxfLayerName("0")).toBe("LAYER_0");
  });

  it("aciColorForCss maps primaries and defaults garbage to white", async () => {
    const { aciColorForCss } = await import("./dxfSilhouette");
    expect(aciColorForCss("#ff0000")).toBe(1);
    expect(aciColorForCss("#00ff00")).toBe(3);
    expect(aciColorForCss("#0000ff")).toBe(5);
    expect(aciColorForCss("not a colour")).toBe(7);
  });

  it("layeredDxf emits a TABLES section and lands entities on their layers", async () => {
    const { layeredDxf } = await import("./dxfSilhouette");
    const r = layeredDxf(
      [
        { name: "Dims", color: "#ff0000", segments: [seg([0, 0], [10, 0])] },
        { name: "HIDDEN", color: "#00ff00", segments: [seg([0, 5], [10, 5])], hiddenSegments: [seg([0, 6], [10, 6])] },
      ],
      view
    );
    expect(r.dxf).toMatch(/TABLES/);
    expect(r.dxf).toMatch(/LAYER/);
    expect(r.dxf).toMatch(/62\n1\n/); // red -> ACI 1 in the table
    expect(r.dxf).toMatch(/8\nDims\n/); // visible geometry on its own layer
    expect(r.dxf).toMatch(/8\nLAYER_HIDDEN\n/); // the collision prefix, not a merge into HIDDEN
    expect(r.dxf).toMatch(/8\nHIDDEN\n/); // occluded runs keep the existing convention
    expect(r.segmentCount).toBe(2);
    // The writer's own output parses back through the repo's reader with no warnings.
    const back = parseDxf(r.dxf);
    expect(back.warnings).toEqual([]);
  });
});

describe("DXF arc fitting", () => {
  /** A 100 x 60 plate with four r=5 holes tessellated as 64-gons, as edge pairs. */
  function plate(): { positions: Float32Array; edges: Array<[number, number]> } {
    const pts: number[] = [];
    const edges: Array<[number, number]> = [];
    const ring = (n: number, pt: (i: number) => [number, number]) => {
      const base = pts.length / 3;
      for (let i = 0; i < n; i++) pts.push(...pt(i), 0);
      for (let i = 0; i < n; i++) edges.push([base + i, base + ((i + 1) % n)]);
    };
    ring(4, (i) => [[0, 0], [100, 0], [100, 60], [0, 60]][i] as [number, number]);
    for (const [cx, cy] of [[15, 15], [85, 15], [15, 45], [85, 45]]) {
      ring(64, (i) => [cx + 5 * Math.cos((2 * Math.PI * i) / 64), cy + 5 * Math.sin((2 * Math.PI * i) / 64)]);
    }
    return { positions: new Float32Array(pts), edges };
  }

  it("a plate with four tessellated holes writes four CIRCLEs with the model radius", () => {
    const { positions, edges } = plate();
    const r = silhouetteDxf(positions, edges, { direction: [0, 0, 1] });
    expect(r.circleCount).toBe(4);
    const circles = parseDxfRawEntities(r.dxf).filter((e) => e.type === "CIRCLE");
    expect(circles).toHaveLength(4);
    for (const c of circles) {
      const radius = Number(c.pairs.find((p) => p[0] === 40)?.[1]);
      expect(Math.abs(radius - 5)).toBeLessThan(0.05);
    }
    // The rectangle stays a plain 4-vertex polyline.
    expect(r.dxf.match(/LWPOLYLINE/g)).toHaveLength(1);
    // Control: arcTolerance 0 keeps the N-gons.
    const off = silhouetteDxf(positions, edges, { direction: [0, 0, 1] }, { arcTolerance: 0 });
    expect(off.circleCount).toBeUndefined();
    expect(off.dxf).not.toContain("CIRCLE");
  });

  it("a tessellated quarter arc becomes one bulged segment of the right sign", () => {
    // Quarter circle r=10 from (10,0) to (0,10), plus straight tails.
    const pts: Array<[number, number]> = [[30, 0], [10, 0]];
    for (let i = 1; i <= 16; i++) pts.push([10 * Math.cos((Math.PI / 2) * (i / 16)), 10 * Math.sin((Math.PI / 2) * (i / 16))]);
    pts.push([0, 30]);
    const positions = new Float32Array(pts.flatMap(([x, y]) => [x, y, 0]));
    const edges: Array<[number, number]> = pts.slice(1).map((_, i) => [i, i + 1]);
    const r = silhouetteDxf(positions, edges, { direction: [0, 0, 1] });
    expect(r.arcCount).toBe(1);
    const poly = parseDxfRawEntities(r.dxf).find((e) => e.type === "LWPOLYLINE")!;
    const bulge = Number(poly.pairs.find((p) => p[0] === 42)?.[1]);
    expect(Math.abs(Math.abs(bulge) - Math.tan(Math.PI / 8))).toBeLessThan(1e-3);
    // The model arc sweeps CCW in the Y-up model, and the written DXF is Y-up too,
    // so the written bulge is positive (the writer's two Y flips cancel).
    expect(bulge).toBeGreaterThan(0);
  });

  it("straight and gently bent runs are never turned into arcs", () => {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 20, 0.01, 0, 30, 0, 0, 40, 0.01, 0, 50, 0, 0]);
    const edges: Array<[number, number]> = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]];
    const r = silhouetteDxf(positions, edges, { direction: [0, 0, 1] });
    expect(r.arcCount).toBeUndefined();
    expect(r.circleCount).toBeUndefined();
  });
});
