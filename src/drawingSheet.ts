/**
 * Multi-view drawing sheet layout — pure, vscode/OCCT/THREE-free.
 *
 * `export_technical_drawing` produces ONE view per file. A drafting sheet
 * places several (front/top/right/iso) at one shared scale inside a frame with
 * a title block. Everything geometric already exists — `viewBasis`, the named
 * view vocabulary, the hidden-line engine and both writers — so this module is
 * only the part that was missing: a sheet coordinate frame, a translation per
 * view, the shared-scale decision and the title block.
 *
 * **Every view arrives WORLD-projected**, in the same Y-down frame
 * `svgSilhouette.ts`'s `project()` produces. That is what makes alignment a
 * bounds operation: a front and a top view of one model span the same world-x
 * range, so centring both on one column centre IS orthographic alignment.
 * (Hidden-line output was model-centred until that was fixed for exactly this
 * reason — see `hiddenLineRemoval.ts`'s `Projected.originX`.)
 *
 * Output coordinates are literal sheet millimetres, Y-down. The layout
 * transforms points (`p·s + offset`) rather than emitting an SVG `<g
 * transform>`: DXF has no such construct, and a scale transform would also
 * scale stroke widths, which on a sheet must be real print widths.
 */

import { drawingBounds, viewBasis, type DimensionDrawing, type DimensionSource, type Vec3 } from "./svgSilhouette";

export type Pt2 = [number, number];
export type Segment2 = [Pt2, Pt2];

export interface DimensionsPayload {
  drawings: DimensionDrawing[];
  textHeight: number;
}

export interface SheetViewInput {
  /** Canonical view name (e.g. `"front"`, `"iso-ftr"`). Drives slot placement. */
  name: string;
  /** View direction (model → camera). Ortho detection uses it, not the name. */
  direction: Vec3;
  visible: Segment2[];
  hidden: Segment2[];
  dimensions?: DimensionsPayload;
}

export const PAPER_SIZES = ["fit", "A4", "A3", "A2", "A1", "A0"] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];
export const PROJECTION_METHODS = ["first", "third"] as const;
export type ProjectionMethod = (typeof PROJECTION_METHODS)[number];

/** ISO 216 A-series, LANDSCAPE, millimetres. */
const PAPER_MM: Record<Exclude<PaperSize, "fit">, [number, number]> = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
};

/**
 * ISO 5455 recommended scales, largest first. The fit search takes the first
 * that fits, so a small part is enlarged rather than lost in an A3 sheet.
 */
export const STANDARD_SCALES: readonly number[] = [
  50, 20, 10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100, 1 / 200, 1 / 500, 1 / 1000,
];

/** Sheet-mm constants. Text heights follow ISO 3098's 2.5 / 3.5 / 5 series. */
export const SHEET = {
  margin: 10,
  gap: 12,
  labelBand: 8,
  labelHeight: 3.5,
  dimensionTextHeight: 3.5,
  titleBlockWidth: 120,
  titleRowHeight: 9,
  cellRowHeight: 7,
  titleTextHeight: 5,
  cellTextHeight: 2.5,
} as const;

export interface SheetOptions {
  paper?: PaperSize;
  projection?: ProjectionMethod;
  /** Sheet mm per model unit. Overrides the standard-scale search. */
  scale?: number;
  title?: string;
  /** Unit label for the title block (the geometry is already converted). */
  unit?: string;
  /** Date string for the title block; omitted from the block when absent. */
  date?: string;
}

export interface SheetText {
  x: number;
  y: number;
  text: string;
  height: number;
  anchor: "start" | "middle";
}

export interface PlacedView {
  name: string;
  visible: Segment2[];
  hidden: Segment2[];
  dimensions?: DimensionsPayload;
  label: SheetText;
  /** Sheet-mm centre of the view's drawing bounds (useful for tests/callers). */
  centre: Pt2;
}

export interface SheetLayout {
  width: number;
  height: number;
  scale: number;
  scaleLabel: string;
  paper: PaperSize;
  projection: ProjectionMethod;
  views: PlacedView[];
  /** Sheet border (heavier line). */
  frame: Segment2[];
  titleBlock: { lines: Segment2[]; texts: SheetText[] };
  warnings: string[];
}

/** Formats a scale as a drafting ratio: `2:1`, `1:1`, `1:50`. */
export function scaleLabel(scale: number): string {
  if (!(scale > 0) || !Number.isFinite(scale)) return "1:1";
  if (scale >= 1) return `${trimNumber(scale)}:1`;
  return `1:${trimNumber(1 / scale)}`;
}

function trimNumber(n: number): string {
  return String(Number(n.toPrecision(4)));
}

/** True for a view direction along exactly one world axis. */
export function isOrthographic(direction: Vec3): boolean {
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(len > 0)) return false;
  let axes = 0;
  for (const c of direction) if (Math.abs(c / len) > 1e-9) axes++;
  return axes === 1;
}

type Cell = [number, number]; // [column, row], row grows DOWN the sheet

/**
 * Grid cell per principal view, relative to FRONT at [0, 0].
 *
 * First angle (ISO E): each view is placed on the side OPPOSITE the one it
 * was seen from — top below the front, the right-side view on the left.
 * Third angle (ASME): the mirror of that. The back view sits at the far right
 * in both, the common choice.
 */
const ORTHO_CELLS: Record<ProjectionMethod, Record<string, Cell>> = {
  first: { front: [0, 0], top: [0, 1], bottom: [0, -1], right: [-1, 0], left: [1, 0], back: [2, 0] },
  third: { front: [0, 0], top: [0, -1], bottom: [0, 1], right: [1, 0], left: [-1, 0], back: [2, 0] },
};

/** Cells tried, in order, for a non-principal view (iso, or a displaced duplicate). */
const FREE_CELLS: Cell[] = [
  [1, -1], [-1, -1], [1, 1], [-1, 1], [2, -1], [2, 1], [-2, -1], [-2, 1], [2, 0], [-2, 0], [0, 2], [0, -2],
];

/**
 * Assigns each view a grid cell. Exported for unit testing the slot rules.
 */
export function assignCells(views: ReadonlyArray<{ name: string }>, projection: ProjectionMethod): Cell[] {
  const taken = new Set<string>();
  const key = (c: Cell): string => `${c[0]},${c[1]}`;
  const cells: Array<Cell | undefined> = new Array(views.length);
  // Principal views first, so an iso listed before "top" cannot steal its cell.
  views.forEach((v, i) => {
    const cell = ORTHO_CELLS[projection][v.name.toLowerCase()];
    if (cell && !taken.has(key(cell))) {
      cells[i] = cell;
      taken.add(key(cell));
    }
  });
  let extraRow = 3;
  views.forEach((v, i) => {
    if (cells[i]) return;
    let cell = FREE_CELLS.find((c) => !taken.has(key(c)));
    if (!cell) {
      // Out of named free cells: start new rows below everything.
      let col = 0;
      while (taken.has(key([col, extraRow]))) col++;
      cell = [col, extraRow];
      if (col > 3) extraRow++;
    }
    cells[i] = cell;
    taken.add(key(cell));
  });
  return cells as Cell[];
}

/**
 * Picks, for each annotation, the single view it is drawn in: the orthographic
 * view where its measured line reads truest (largest projected-to-true length
 * ratio), ties to the earlier view. A pin without a measured line goes to the
 * first candidate view. Iso views are candidates only when there is no
 * orthographic view at all — a dimension drawn in iso reads foreshortened.
 *
 * Returns, per view, the indices of the annotations assigned to it.
 */
export function assignDimensionsToViews(
  annotations: ReadonlyArray<DimensionSource>,
  views: ReadonlyArray<{ direction: Vec3; up?: Vec3 }>
): number[][] {
  const out: number[][] = views.map(() => []);
  if (views.length === 0) return out;
  const ortho = views.map((v, i) => (isOrthographic(v.direction) ? i : -1)).filter((i) => i >= 0);
  const candidates = ortho.length > 0 ? ortho : views.map((_, i) => i);
  const bases = views.map((v) => viewBasis(v.direction, v.up));

  annotations.forEach((a, ai) => {
    const lp = a.linePoints;
    let best = candidates[0];
    if (lp && lp.length === 2) {
      const d: Vec3 = [lp[1][0] - lp[0][0], lp[1][1] - lp[0][1], lp[1][2] - lp[0][2]];
      const true3 = Math.hypot(d[0], d[1], d[2]);
      if (true3 > 0 && Number.isFinite(true3)) {
        let bestRatio = -1;
        for (const vi of candidates) {
          const b = bases[vi];
          const px = d[0] * b.right[0] + d[1] * b.right[1] + d[2] * b.right[2];
          const py = d[0] * b.up[0] + d[1] * b.up[1] + d[2] * b.up[2];
          const ratio = Math.hypot(px, py) / true3;
          if (ratio > bestRatio + 1e-6) {
            bestRatio = ratio;
            best = vi;
          }
        }
      }
    }
    out[best].push(ai);
  });
  return out;
}

interface Measured {
  input: SheetViewInput;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  cell: Cell;
}

/**
 * Lays several projected views out on one sheet.
 *
 * Views with no drawable geometry are omitted with a warning (an empty view
 * would otherwise claim a cell and a label). Throws only when NO view has
 * geometry — a sheet of empty boxes is not a drawing.
 */
export function layoutSheet(inputs: ReadonlyArray<SheetViewInput>, options: SheetOptions = {}): SheetLayout {
  const warnings: string[] = [];
  const paper: PaperSize = options.paper ?? "fit";
  const projection: ProjectionMethod = options.projection ?? "first";

  const cells = assignCells(inputs, projection);
  const measured: Measured[] = [];
  inputs.forEach((input, i) => {
    const b = drawingBounds(input.visible, input.hidden, input.dimensions?.drawings ?? []);
    if (!b) {
      warnings.push(`View "${input.name}" produced no geometry and was omitted from the sheet.`);
      return;
    }
    measured.push({ input, bounds: b, cell: cells[i] });
  });
  if (measured.length === 0) throw new Error("No view produced any geometry — nothing to lay out on a sheet.");

  // Compact the grid: only columns/rows that actually hold a view take space.
  const cols = [...new Set(measured.map((m) => m.cell[0]))].sort((a, b) => a - b);
  const rows = [...new Set(measured.map((m) => m.cell[1]))].sort((a, b) => a - b);

  /** Sheet-mm content size at scale `s`, plus per-column/row sizes. */
  const sizeAt = (s: number) => {
    const colW = cols.map((c) =>
      Math.max(...measured.filter((m) => m.cell[0] === c).map((m) => (m.bounds.maxX - m.bounds.minX) * s))
    );
    const rowH = rows.map(
      (r) =>
        Math.max(...measured.filter((m) => m.cell[1] === r).map((m) => (m.bounds.maxY - m.bounds.minY) * s)) +
        SHEET.labelBand
    );
    const width = colW.reduce((a, b) => a + b, 0) + SHEET.gap * (cols.length - 1);
    const height = rowH.reduce((a, b) => a + b, 0) + SHEET.gap * (rows.length - 1);
    return { colW, rowH, width, height };
  };

  const titleBlockHeight = SHEET.titleRowHeight + 3 * SHEET.cellRowHeight;
  let scale: number;
  let sheetW: number;
  let sheetH: number;
  let regionX: number; // content region, sheet mm
  let regionY: number;
  let regionW: number;
  let regionH: number;

  if (paper === "fit") {
    scale = options.scale && options.scale > 0 && Number.isFinite(options.scale) ? options.scale : 1;
    const size = sizeAt(scale);
    sheetW = Math.max(size.width, SHEET.titleBlockWidth) + 2 * SHEET.margin;
    sheetH = size.height + SHEET.gap + titleBlockHeight + 2 * SHEET.margin;
    regionX = SHEET.margin;
    regionY = SHEET.margin;
    regionW = sheetW - 2 * SHEET.margin;
    regionH = size.height;
  } else {
    [sheetW, sheetH] = PAPER_MM[paper];
    regionX = SHEET.margin;
    regionY = SHEET.margin;
    regionW = sheetW - 2 * SHEET.margin;
    regionH = sheetH - 2 * SHEET.margin - titleBlockHeight - SHEET.gap;
    const fits = (s: number): boolean => {
      const size = sizeAt(s);
      return size.width <= regionW + 1e-9 && size.height <= regionH + 1e-9;
    };
    if (options.scale && options.scale > 0 && Number.isFinite(options.scale)) {
      scale = options.scale;
      if (!fits(scale)) {
        warnings.push(`The views do not fit on ${paper} at ${scaleLabel(scale)} — they overrun the drawing area.`);
      }
    } else {
      const found = STANDARD_SCALES.find(fits);
      if (found === undefined) {
        scale = STANDARD_SCALES[STANDARD_SCALES.length - 1];
        warnings.push(
          `The views do not fit on ${paper} even at ${scaleLabel(scale)} — they overrun the drawing area; choose a larger paper size.`
        );
      } else {
        scale = found;
      }
    }
  }

  const size = sizeAt(scale);
  // Centre the grid within the content region.
  const originX = regionX + Math.max(0, (regionW - size.width) / 2);
  const originY = regionY + Math.max(0, (regionH - size.height) / 2);
  const colX: number[] = [];
  let cursor = originX;
  for (const w of size.colW) {
    colX.push(cursor);
    cursor += w + SHEET.gap;
  }
  const rowY: number[] = [];
  cursor = originY;
  for (const h of size.rowH) {
    rowY.push(cursor);
    cursor += h + SHEET.gap;
  }

  const views: PlacedView[] = measured.map((m) => {
    const ci = cols.indexOf(m.cell[0]);
    const ri = rows.indexOf(m.cell[1]);
    const cx = colX[ci] + size.colW[ci] / 2;
    const drawH = size.rowH[ri] - SHEET.labelBand;
    const cy = rowY[ri] + drawH / 2;
    const bcx = (m.bounds.minX + m.bounds.maxX) / 2;
    const bcy = (m.bounds.minY + m.bounds.maxY) / 2;
    const tp = (p: Pt2): Pt2 => [(p[0] - bcx) * scale + cx, (p[1] - bcy) * scale + cy];
    const ts = (s: Segment2): Segment2 => [tp(s[0]), tp(s[1])];
    const halfH = ((m.bounds.maxY - m.bounds.minY) * scale) / 2;
    const dims = m.input.dimensions;
    return {
      name: m.input.name,
      visible: m.input.visible.map(ts),
      hidden: m.input.hidden.map(ts),
      ...(dims && dims.drawings.length > 0
        ? {
            dimensions: {
              textHeight: SHEET.dimensionTextHeight,
              drawings: dims.drawings.map((d) => ({
                lines: d.lines.map(ts),
                triangles: d.triangles.map((t) => [tp(t[0]), tp(t[1]), tp(t[2])] as [Pt2, Pt2, Pt2]),
                labels: d.labels.map((l) => {
                  const [x, y] = tp([l.x, l.y]);
                  return { x, y, text: l.text };
                }),
              })),
            },
          }
        : {}),
      label: {
        x: cx,
        y: cy + halfH + SHEET.labelBand * 0.75,
        text: m.input.name.toUpperCase(),
        height: SHEET.labelHeight,
        anchor: "middle" as const,
      },
      centre: [cx, cy],
    };
  });

  const label = scaleLabel(scale);
  const frame = rect(SHEET.margin, SHEET.margin, sheetW - 2 * SHEET.margin, sheetH - 2 * SHEET.margin);
  const titleBlock = buildTitleBlock(
    sheetW - SHEET.margin - SHEET.titleBlockWidth,
    sheetH - SHEET.margin - titleBlockHeight,
    {
      title: options.title ?? "",
      scale: label,
      unit: options.unit ?? "mm",
      projection,
      date: options.date,
      views: views.map((v) => v.name.toUpperCase()).join(", "),
    }
  );

  return {
    width: sheetW,
    height: sheetH,
    scale,
    scaleLabel: label,
    paper,
    projection,
    views,
    frame,
    titleBlock,
    warnings,
  };
}

function rect(x: number, y: number, w: number, h: number): Segment2[] {
  return [
    [[x, y], [x + w, y]],
    [[x + w, y], [x + w, y + h]],
    [[x + w, y + h], [x, y + h]],
    [[x, y + h], [x, y]],
  ];
}

/** Truncates text to the characters that fit a width, at ~0.6 em per glyph. */
function fitText(text: string, width: number, height: number): string {
  const max = Math.max(1, Math.floor(width / (height * 0.6)));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Title block: a full-width title row over three rows of cells.
 *
 * ```
 * | TITLE                           |
 * | Scale 1:2       | Unit mm       |
 * | First angle     | Date …        |
 * | Views FRONT, TOP, …             |
 * ```
 */
function buildTitleBlock(
  x: number,
  y: number,
  f: { title: string; scale: string; unit: string; projection: ProjectionMethod; date?: string; views: string }
): { lines: Segment2[]; texts: SheetText[] } {
  const w = SHEET.titleBlockWidth;
  const r0 = SHEET.titleRowHeight;
  const r = SHEET.cellRowHeight;
  const h = r0 + 3 * r;
  const half = w / 2;
  const pad = 2;
  const lines: Segment2[] = [
    ...rect(x, y, w, h),
    [[x, y + r0], [x + w, y + r0]],
    [[x, y + r0 + r], [x + w, y + r0 + r]],
    [[x, y + r0 + 2 * r], [x + w, y + r0 + 2 * r]],
    [[x + half, y + r0], [x + half, y + r0 + 2 * r]],
  ];
  const cellBase = (row: number): number => y + r0 + row * r + r / 2 + SHEET.cellTextHeight * 0.35;
  const ct = SHEET.cellTextHeight;
  const texts: SheetText[] = [
    {
      x: x + pad,
      y: y + r0 / 2 + SHEET.titleTextHeight * 0.35,
      text: fitText(f.title || "Untitled", w - 2 * pad, SHEET.titleTextHeight),
      height: SHEET.titleTextHeight,
      anchor: "start",
    },
    { x: x + pad, y: cellBase(0), text: fitText(`Scale ${f.scale}`, half - 2 * pad, ct), height: ct, anchor: "start" },
    { x: x + half + pad, y: cellBase(0), text: fitText(`Unit ${f.unit}`, half - 2 * pad, ct), height: ct, anchor: "start" },
    {
      x: x + pad,
      y: cellBase(1),
      text: f.projection === "first" ? "First-angle projection" : "Third-angle projection",
      height: ct,
      anchor: "start",
    },
    ...(f.date
      ? [{ x: x + half + pad, y: cellBase(1), text: fitText(`Date ${f.date}`, half - 2 * pad, ct), height: ct, anchor: "start" as const }]
      : []),
    { x: x + pad, y: cellBase(2), text: fitText(`Views ${f.views}`, w - 2 * pad, ct), height: ct, anchor: "start" },
  ];
  return { lines, texts };
}
