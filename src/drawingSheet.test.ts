import { describe, expect, it } from "vitest";
import {
  assignCells,
  assignDimensionsToViews,
  isOrthographic,
  layoutSheet,
  scaleLabel,
  STANDARD_SCALES,
  type SheetViewInput,
  type Segment2,
} from "./drawingSheet";
import { sheetSvg } from "./svgSilhouette";
import { sheetDxf } from "./dxfSilhouette";
import { parseSvgPaths } from "./svgImport";
import { parseDxfRawEntities } from "./dxfImport";

/** An axis-aligned w×h rectangle outline centred at (cx, cy), Y-down frame. */
function rectView(name: string, direction: [number, number, number], cx: number, cy: number, w: number, h: number): SheetViewInput {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  const visible: Segment2[] = [
    [[x0, y0], [x1, y0]],
    [[x1, y0], [x1, y1]],
    [[x1, y1], [x0, y1]],
    [[x0, y1], [x0, y0]],
  ];
  return { name, direction, visible, hidden: [] };
}

/** A 30 (x) × 20 (y) × 10 (z) box, world-projected per view. Its bbox sits
 * off-origin on purpose, so a layout that ignored the bounds centre would
 * misplace views. */
function boxViews(): SheetViewInput[] {
  return [
    rectView("front", [0, 0, 1], 115, -210, 30, 20), // x across, y (neg) down
    rectView("top", [0, 1, 0], 115, -305, 30, 10), // x across, z down
    rectView("right", [1, 0, 0], -305, -210, 10, 20), // z across, y down
    rectView("iso-ftr", [1, 0.8, 1], 0, 0, 25, 25),
  ];
}

const centreOf = (layout: ReturnType<typeof layoutSheet>, name: string) =>
  layout.views.find((v) => v.name === name)!.centre;

describe("assignCells", () => {
  it("first angle: top BELOW front, right view on the LEFT", () => {
    const cells = assignCells(boxViews(), "first");
    expect(cells[0]).toEqual([0, 0]);
    expect(cells[1]).toEqual([0, 1]);
    expect(cells[2]).toEqual([-1, 0]);
  });

  it("third angle: top ABOVE front, right view on the RIGHT", () => {
    const cells = assignCells(boxViews(), "third");
    expect(cells[1]).toEqual([0, -1]);
    expect(cells[2]).toEqual([1, 0]);
  });

  it("an iso listed BEFORE the principal views cannot steal their cells", () => {
    const views = [{ name: "iso" }, { name: "top" }, { name: "front" }];
    const cells = assignCells(views, "first");
    expect(cells[1]).toEqual([0, 1]);
    expect(cells[2]).toEqual([0, 0]);
    expect(cells[0]).not.toEqual([0, 1]);
  });

  it("gives every view a distinct cell, duplicates included", () => {
    const views = [{ name: "front" }, { name: "front" }, { name: "iso" }, { name: "iso" }];
    const keys = assignCells(views, "first").map((c) => c.join(","));
    expect(new Set(keys).size).toBe(4);
  });
});

describe("layoutSheet — placement", () => {
  it("aligns front/top on x and front/right on y, in first angle", () => {
    const layout = layoutSheet(boxViews(), { projection: "first" });
    const front = centreOf(layout, "front");
    const top = centreOf(layout, "top");
    const right = centreOf(layout, "right");
    expect(top[0]).toBeCloseTo(front[0], 9);
    expect(top[1]).toBeGreaterThan(front[1]); // below (Y-down sheet)
    expect(right[1]).toBeCloseTo(front[1], 9);
    expect(right[0]).toBeLessThan(front[0]); // left
  });

  it("mirrors the placement in third angle", () => {
    const layout = layoutSheet(boxViews(), { projection: "third" });
    expect(centreOf(layout, "top")[1]).toBeLessThan(centreOf(layout, "front")[1]);
    expect(centreOf(layout, "right")[0]).toBeGreaterThan(centreOf(layout, "front")[0]);
  });

  it("keeps each view's geometry at the shared scale, centred on its cell", () => {
    const layout = layoutSheet(boxViews(), { paper: "fit", scale: 2 });
    const front = layout.views.find((v) => v.name === "front")!;
    const xs = front.visible.flat().map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(60, 9); // 30 × 2
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(front.centre[0], 9);
  });

  it("keeps every view and the title block inside the sheet", () => {
    for (const paper of ["fit", "A4", "A3"] as const) {
      const layout = layoutSheet(boxViews(), { paper });
      const pts = [
        ...layout.views.flatMap((v) => [...v.visible, ...v.hidden].flat()),
        ...layout.titleBlock.lines.flat(),
      ];
      for (const [x, y] of pts) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(layout.width);
        expect(y).toBeLessThanOrEqual(layout.height);
      }
    }
  });

  it("omits an empty view with a warning, and throws when every view is empty", () => {
    const empty: SheetViewInput = { name: "back", direction: [0, 0, -1], visible: [], hidden: [] };
    const layout = layoutSheet([...boxViews(), empty]);
    expect(layout.views.map((v) => v.name)).not.toContain("back");
    expect(layout.warnings.join(" ")).toMatch(/back/);
    expect(() => layoutSheet([empty])).toThrow(/produced any geometry/i);
  });
});

describe("layoutSheet — shared scale", () => {
  it("fit paper uses 1:1 by default and sizes the sheet to the content", () => {
    const layout = layoutSheet(boxViews());
    expect(layout.scale).toBe(1);
    expect(layout.scaleLabel).toBe("1:1");
  });

  it("A4 picks the LARGEST standard scale that fits, and the sheet is A4 landscape", () => {
    const layout = layoutSheet(boxViews(), { paper: "A4" });
    expect([layout.width, layout.height]).toEqual([297, 210]);
    expect(STANDARD_SCALES).toContain(layout.scale);
    // A small part is enlarged, not left tiny: the next scale up must NOT fit.
    const i = STANDARD_SCALES.indexOf(layout.scale);
    expect(i).toBeGreaterThan(0);
    const bigger = layoutSheet(boxViews(), { paper: "A4", scale: STANDARD_SCALES[i - 1] });
    expect(bigger.warnings.join(" ")).toMatch(/do not fit/);
    expect(layout.warnings).toEqual([]);
  });

  it("reduces a large part on paper", () => {
    const huge = boxViews().map((v) => ({
      ...v,
      visible: v.visible.map(([a, b]) => [[a[0] * 100, a[1] * 100], [b[0] * 100, b[1] * 100]] as Segment2),
    }));
    const layout = layoutSheet(huge, { paper: "A3" });
    expect(layout.scale).toBeLessThan(1);
    expect(layout.warnings).toEqual([]);
  });

  it("warns — never silently clips — when nothing on the ladder fits", () => {
    const enormous = boxViews().map((v) => ({
      ...v,
      visible: v.visible.map(([a, b]) => [[a[0] * 1e6, a[1] * 1e6], [b[0] * 1e6, b[1] * 1e6]] as Segment2),
    }));
    const layout = layoutSheet(enormous, { paper: "A4" });
    expect(layout.scale).toBe(STANDARD_SCALES[STANDARD_SCALES.length - 1]);
    expect(layout.warnings.join(" ")).toMatch(/larger paper/);
  });

  it("formats ratios", () => {
    expect(scaleLabel(2)).toBe("2:1");
    expect(scaleLabel(1)).toBe("1:1");
    expect(scaleLabel(1 / 50)).toBe("1:50");
  });
});

describe("assignDimensionsToViews", () => {
  const views = [
    { direction: [0, 0, 1] as [number, number, number] }, // front
    { direction: [0, 1, 0] as [number, number, number], up: [0, 0, -1] as [number, number, number] }, // top
    { direction: [1, 0.8, 1] as [number, number, number] }, // iso
  ];

  it("draws a dimension once, in the orthographic view where it reads at true length", () => {
    // Along Z: foreshortened to a point in front, true length in top.
    const a = { anchorPoint: [0, 0, 5] as const, linePoints: [[0, 0, 0], [0, 0, 10]] as const, text: "10" };
    // Along Y: true length in front, a point in top.
    const b = { anchorPoint: [0, 5, 0] as const, linePoints: [[0, 0, 0], [0, 10, 0]] as const, text: "10" };
    expect(assignDimensionsToViews([a, b], views)).toEqual([[1], [0], []]);
  });

  it("never prefers iso while an orthographic view exists; a pin with no line goes to the first", () => {
    const pin = { anchorPoint: [1, 2, 3] as const, text: "R 3" };
    expect(assignDimensionsToViews([pin], views)).toEqual([[0], [], []]);
    expect(assignDimensionsToViews([pin], [views[2]])).toEqual([[0]]);
  });

  it("classifies orthographic directions", () => {
    expect(isOrthographic([0, 0, -3])).toBe(true);
    expect(isOrthographic([1, 0.8, 1])).toBe(false);
  });
});

describe("sheet writers", () => {
  const withHidden = (): SheetViewInput[] => {
    const v = boxViews();
    v[0].hidden = [[[105, -210], [125, -210]]];
    v[0].dimensions = {
      textHeight: 1,
      drawings: [{ lines: [[[100, -200], [130, -200]]], triangles: [[[100, -200], [101, -199], [101, -201]]], labels: [{ x: 115, y: -201, text: "30 <mm>" }] }],
    };
    return v;
  };

  it("sheetSvg: one group per view, the frame, a title block, and parseable paths", () => {
    const layout = layoutSheet(withHidden(), { paper: "A4", title: "box.step", date: "2026-09-14" });
    const svg = sheetSvg(layout);
    for (const name of ["front", "top", "right", "iso-ftr"]) expect(svg).toContain(`<g id="view-${name}">`);
    expect(svg).toContain('id="title-block"');
    expect(svg).toContain('viewBox="0 0 297 210"');
    expect(svg).toContain("First-angle projection");
    expect(svg).toContain(`Scale ${layout.scaleLabel}`);
    expect(svg).toContain("30 &lt;mm&gt;"); // label escaped
    expect(svg).toMatch(/stroke-dasharray/);
    expect(svg).not.toMatch(/NaN|Infinity/);
    expect(parseSvgPaths(svg).length).toBeGreaterThan(0);
  });

  it("sheetDxf: separate BORDER/TITLE/HIDDEN/DIMENSIONS layers, Y-up coordinates", () => {
    const layout = layoutSheet(withHidden(), { paper: "A4", title: "box.step" });
    const { dxf } = sheetDxf(layout);
    const entities = parseDxfRawEntities(dxf);
    const layers = new Set(entities.map((e) => e.pairs.find(([code]) => code === 8)?.[1]));
    for (const l of ["0", "HIDDEN", "DIMENSIONS", "BORDER", "TITLE"]) expect(layers.has(l), l).toBe(true);
    expect(dxf).toContain("$EXTMAX");
    expect(dxf).not.toMatch(/NaN|Infinity/);
    // Everything lies in the Y-up sheet quadrant y ∈ [-height, 0].
    const ys = [...dxf.matchAll(/\n20\n(-?[\d.]+)\n/g)].map((m) => Number(m[1]));
    expect(ys.length).toBeGreaterThan(0);
    for (const y of ys) {
      expect(y).toBeLessThanOrEqual(1e-9);
      expect(y).toBeGreaterThanOrEqual(-layout.height - 1e-9);
    }
  });
});
