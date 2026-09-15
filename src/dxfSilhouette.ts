/**
 * Pure DXF writer for silhouette export — vscode/OCCT/THREE-free (mirror of
 * `svgSilhouette.ts`'s serialize, but producing AutoCAD DXF instead of SVG).
 *
 * Reuses `svgSilhouette.ts`'s `viewBasis` + projection so an SVG and a DXF of
 * the same view are geometrically consistent. 1 DXF drawing unit = 1 model
 * unit, Y-up native (the projection already negates Y for SVG; DXF keeps the
 * negated value — see `project` below).
 *
 * Chained collinear-adjacent segments are grouped into `LWPOLYLINE` entities
 * (with `42` bulge where a circular arc was detected) plus unmatched
 * singletons as `LINE`s — the "Both: LINE + LWPOLYLINE" representation the
 * plan finalized, so the outline is both easy to view (a polyline is one
 * selectable outline) and easy to edit (each `LINE` is an independent
 * segment).
 *
 * Bulge detection is not yet wired for tessellated silhouettes (they are pure
 * straight segments), so all produced polylines currently have zero bulge and
 * are plain polylines — the helper and serialization already carry bulge
 * correctly, so a future arc-aware source can reuse them with no format change.
 */

import { segmentsToPolylines, viewBasis, dimensionDrawings, type Vec3, type ViewSpec, type DimensionSource, type DimensionDrawing } from "./svgSilhouette";
import type { SheetLayout } from "./drawingSheet";

export interface DxfOptions {
  /** Optional DXF header title (written as a comment, not a formal header var). */
  title?: string;
  /**
   * Precomputed 2D dimension glyphs (from `svgSilhouette.ts`'s
   * {@link dimensionDrawings}) baked into the ENTITIES section — `LINE`s for
   * glyph/extension lines, closed 3-vertex `LWPOLYLINE`s for arrowheads, and
   * centered `TEXT` for value labels, all on the `DIMENSIONS` layer so a CAD
   * user can toggle them independently of the outline.
   */
  dimensions?: { drawings: DimensionDrawing[]; textHeight: number };
  /**
   * Pinned annotations to render as dimension glyphs (see
   * {@link dimensionDrawings}). Computed against this export's own view basis;
   * `dimensionScaleHint` sizes the glyphs (model bbox diagonal, drawing units).
   */
  annotations?: ReadonlyArray<DimensionSource>;
  dimensionScaleHint?: number;
}

/** The annotation subset the export path consumes. */
export type { DimensionSource };

export interface DxfResult {
  dxf: string;
  /** Total count of LINE + LWPOLYLINE segment contributions (not entity count). */
  segmentCount: number;
  /** Polyline chains formed (LWPOLYLINE count). */
  chainCount: number;
  /** Singleton LINE count. */
  lineCount: number;
  /** Annotations whose dimension glyphs were rendered (absent when none were supplied). */
  dimensionCount?: number;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function project(point: Vec3, basis: ReturnType<typeof viewBasis>): [number, number] {
  // Same projection as svgSilhouette.ts: SVG Y grows downward, so screen-up is
  // negated — DXF Y is Y-up, but we keep the negated value so a DXF viewed in
  // a Y-up CAD tool matches the SVG viewed in a Y-down browser (the import
  // side's Y-negation history would otherwise require a second flip).
  return [dot(point, basis.right), -dot(point, basis.up)];
}

function fmt(n: number): string {
  // DXF coordinates are decimal; enough significant digits without bloating.
  // Use 6 significant digits logic similar to svgSilhouette's decimalsFor,
  // but simplified here since DXF has no viewBox precision coupling.
  if (!Number.isFinite(n)) return "0";
  return String(Number(n.toFixed(6))).replace(/\.0+$/, "").replace(/\.$/, "") || "0";
}


function serializeDxf(
  chains: Array<{ points: Array<[number, number]>; closed: boolean; bulges?: number[] }>,
  singleLines: Array<[[number, number], [number, number]]>,
  options: DxfOptions,
  dims?: { drawings: DimensionDrawing[]; textHeight: number },
  hidden?: {
    chains: Array<{ points: Array<[number, number]>; closed: boolean }>;
    singleLines: Array<[[number, number], [number, number]]>;
  }
): { dxf: string; dimensionCount?: number } {
  const w = new DxfEntityWriter();
  w.header(options.title);
  w.chains("0", chains);
  w.lines("0", singleLines);
  // Occluded geometry on its own layer.
  //
  // A LAYER, not a dashed linetype: this writer emits no TABLES/LTYPE section
  // at all, so a genuine DASHED linetype would mean adding that machinery. A
  // separate layer is the honest cheap form — a CAD user toggles or restyles it
  // — and it is the same mechanism the DIMENSIONS glyphs already use.
  w.chains("HIDDEN", hidden?.chains ?? []);
  w.lines("HIDDEN", hidden?.singleLines ?? []);
  // Dimension glyphs — a separate layer so a CAD user can toggle them
  // independently of the outline geometry.
  let dimensionCount: number | undefined;
  if (dims && dims.drawings.length > 0) {
    dimensionCount = dims.drawings.length;
    w.dimensions(dims);
  }
  return { dxf: w.finish(), ...(dimensionCount !== undefined ? { dimensionCount } : {}) };
}

type Chain = { points: Array<[number, number]>; closed: boolean; bulges?: number[] };
type Seg = [[number, number], [number, number]];

/**
 * Line-oriented DXF emission shared by every entry point in this file.
 *
 * **Y is negated on the way out, and that is a correctness fix.** Everything
 * upstream works in the SVG's Y-down screen frame (`project()` negates screen
 * up). DXF is Y-UP, so writing those values verbatim drew every drawing
 * vertically MIRRORED in a CAD viewer: world-top maps to the most negative y,
 * which a Y-up viewer puts at the bottom. (An earlier comment here called the
 * verbatim write a deliberate match with the SVG; the arithmetic does not
 * support that.) Mirroring also flips an arc's sweep, so bulges are negated
 * too.
 */
class DxfEntityWriter {
  private readonly out: string[] = [];

  private push(code: number, value: string): void {
    this.out.push(String(code), value);
  }

  private xy(x: number, y: number, codeX = 10, codeY = 20): void {
    this.push(codeX, fmt(x));
    this.push(codeY, fmt(-y));
  }

  header(title?: string, extents?: { width: number; height: number }): void {
    this.push(0, "SECTION");
    this.push(2, "HEADER");
    this.push(9, "$ACADVER");
    this.push(1, "AC1015");
    if (title) {
      this.push(9, "$COMMENTS");
      this.push(1, title);
    }
    if (extents) {
      // Sheet extents in the written (Y-up) frame: y runs from -height to 0.
      this.push(9, "$EXTMIN");
      this.push(10, "0");
      this.push(20, fmt(-extents.height));
      this.push(30, "0");
      this.push(9, "$EXTMAX");
      this.push(10, fmt(extents.width));
      this.push(20, "0");
      this.push(30, "0");
    }
    this.push(0, "ENDSEC");
    this.push(0, "SECTION");
    this.push(2, "ENTITIES");
  }

  chains(layer: string, chains: ReadonlyArray<Chain>): void {
    for (const ch of chains) {
      if (ch.points.length < 2) continue;
      this.push(0, "LWPOLYLINE");
      this.push(8, layer);
      this.push(90, String(ch.points.length));
      this.push(70, ch.closed ? "1" : "0");
      for (let i = 0; i < ch.points.length; i++) {
        this.xy(ch.points[i][0], ch.points[i][1]);
        // Bulge for the segment starting at this vertex; zero is the default.
        const bulge = ch.bulges?.[i] ?? 0;
        if (bulge !== 0) this.push(42, fmt(-bulge));
      }
    }
  }

  lines(layer: string, segments: ReadonlyArray<Seg>): void {
    for (const [a, b] of segments) {
      this.push(0, "LINE");
      this.push(8, layer);
      this.xy(a[0], a[1]);
      this.push(30, "0");
      this.xy(b[0], b[1], 11, 21);
      this.push(31, "0");
    }
  }

  /** Chains segments (LWPOLYLINE) and keeps unmatched singletons as LINEs. */
  segments(layer: string, segments: ReadonlyArray<Seg>): { chainCount: number; lineCount: number } {
    const { polyChains, singleLines } = splitChains(segments);
    this.chains(layer, polyChains);
    this.lines(layer, singleLines);
    return { chainCount: polyChains.length, lineCount: singleLines.length };
  }

  text(layer: string, x: number, y: number, height: number, text: string, anchor: "start" | "middle"): void {
    this.push(0, "TEXT");
    this.push(8, layer);
    this.xy(x, y); // insertion point (ignored when justified)
    this.push(30, "0");
    this.push(40, fmt(height));
    this.push(1, text);
    if (anchor === "middle") {
      this.push(72, "1"); // horizontal: center
      this.push(73, "2"); // vertical: middle
      this.xy(x, y, 11, 21); // alignment point (used because 72/73 are set)
      this.push(31, "0");
    }
  }

  dimensions(dims: { drawings: DimensionDrawing[]; textHeight: number }): void {
    for (const drawing of dims.drawings) {
      this.lines("DIMENSIONS", drawing.lines);
      this.chains(
        "DIMENSIONS",
        drawing.triangles.map((t) => ({ points: [t[0], t[1], t[2]], closed: true }))
      );
      for (const l of drawing.labels) this.text("DIMENSIONS", l.x, l.y, dims.textHeight, l.text, "middle");
    }
  }

  finish(): string {
    this.push(0, "ENDSEC");
    this.push(0, "EOF");
    return this.out.join("\n") + "\n";
  }
}

function splitChains(segments: ReadonlyArray<Seg>): { polyChains: Chain[]; singleLines: Seg[] } {
  const polyChains: Chain[] = [];
  const singleLines: Seg[] = [];
  for (const ch of segmentsToPolylines(segments as Seg[])) {
    if (!ch.closed && ch.points.length === 2) singleLines.push([ch.points[0], ch.points[1]]);
    else polyChains.push(ch);
  }
  return { polyChains, singleLines };
}

/**
 * Serializes a laid-out drawing sheet (`drawingSheet.ts`'s `layoutSheet`) as
 * DXF in sheet millimetres. Layers: `0` visible, `HIDDEN`, `DIMENSIONS`,
 * `BORDER` (frame), `TITLE` (title block + view labels).
 *
 * Views are chained PER VIEW and per visibility: `segmentsToPolylines` joins by
 * exact endpoint, so one concatenated list could chain a run of one view into a
 * run of another that merely touches it.
 */
export function sheetDxf(layout: SheetLayout, options: { title?: string } = {}): { dxf: string; chainCount: number; lineCount: number } {
  const w = new DxfEntityWriter();
  w.header(options.title, { width: layout.width, height: layout.height });
  let chainCount = 0;
  let lineCount = 0;
  for (const view of layout.views) {
    const vis = w.segments("0", view.visible);
    const hid = w.segments("HIDDEN", view.hidden);
    chainCount += vis.chainCount + hid.chainCount;
    lineCount += vis.lineCount + hid.lineCount;
    if (view.dimensions && view.dimensions.drawings.length > 0) w.dimensions(view.dimensions);
    w.text("TITLE", view.label.x, view.label.y, view.label.height, view.label.text, view.label.anchor);
  }
  w.segments("BORDER", layout.frame);
  w.lines("TITLE", layout.titleBlock.lines);
  for (const t of layout.titleBlock.texts) w.text("TITLE", t.x, t.y, t.height, t.text, t.anchor);
  return { dxf: w.finish(), chainCount, lineCount };
}

/** Computes the dimensions payload for a view, shared by both DXF entry points. */
function computeDimensions(
  annotations: ReadonlyArray<DimensionSource> | undefined,
  view: ViewSpec,
  scaleHint: number | undefined
): { drawings: DimensionDrawing[]; textHeight: number } | undefined {
  if (!annotations || annotations.length === 0) return undefined;
  return dimensionDrawings(annotations, view, scaleHint ?? 100);
}

/**
 * Renders already-3D polylines as a DXF drawing.
 */
export function polylinesDxf(polylines: Float32Array[], view: ViewSpec, options: DxfOptions = {}): DxfResult {
  const basis = viewBasis(view.direction, view.up);
  const dims = computeDimensions(options.annotations, view, options.dimensionScaleHint);
  const segs: Array<[[number, number], [number, number]]> = [];
  for (const polyline of polylines) {
    const n = Math.floor(polyline.length / 3);
    let prev: [number, number] | null = null;
    for (let i = 0; i < n; i++) {
      const pt: Vec3 = [polyline[i * 3], polyline[i * 3 + 1], polyline[i * 3 + 2]];
      const proj: [number, number] = [dot(pt, basis.right), -dot(pt, basis.up)];
      if (!Number.isFinite(proj[0]) || !Number.isFinite(proj[1])) { prev = null; continue; }
      if (prev) segs.push([prev, proj]);
      prev = proj;
    }
  }
  if (segs.length === 0) {
    // Even with no outline geometry, dimensions alone still make a valid
    // drawing — a pinned annotation on an empty view is worth writing.
    const { dxf, dimensionCount } = serializeDxf([], [], options, dims);
    return { dxf, segmentCount: 0, chainCount: 0, lineCount: 0, ...(dimensionCount !== undefined ? { dimensionCount } : {}) };
  }
  const chains = segmentsToPolylines(segs);
  // Per finalized plan "Both: LINE + LWPOLYLINE" — chains of length >=2 become
  // LWPOLYLINE, singletons remain LINE. Since segmentsToPolylines already
  // produces chains (each chain is at least one segment => >=2 points), we
  // treat chains with exactly 2 points that were originally a single segment
  // and could not chain further as LINE candidates? But distinguishing is not
  // needed: a single segment as an LWPOLYLINE with 2 vertices is valid and
  // equivalent to a LINE, yet the plan explicitly wants singletons as LINEs
  // when they could not chain. segmentsToPolylines merges singletons that are
  // isolated anyway as chains of length 1 segment (2 points). To honor "LINE for
  // unmatched", we emit chains with exactly one segment (2 points, open) as LINEs.
  const polyChains: Array<{ points: Array<[number, number]>; closed: boolean }> = [];
  const singleLines: Array<[[number, number], [number, number]]> = [];
  for (const ch of chains) {
    if (!ch.closed && ch.points.length === 2) {
      singleLines.push([ch.points[0], ch.points[1]]);
    } else {
      polyChains.push(ch);
    }
  }
  const { dxf, dimensionCount } = serializeDxf(polyChains, singleLines, options, dims);
  return { dxf, segmentCount: segs.length, chainCount: polyChains.length, lineCount: singleLines.length, ...(dimensionCount !== undefined ? { dimensionCount } : {}) };
}

/**
 * Renders a mesh silhouette (triangle silhouette edges) as DXF.
 */
/**
 * A technical drawing as DXF: visible geometry on layer `0`, occluded geometry
 * on layer `HIDDEN`.
 *
 * **Visible and hidden runs are chained SEPARATELY, and that is load-bearing.**
 * `segmentsToPolylines` joins segments by exact endpoint match, so handing it
 * one concatenated list would chain a visible run straight into the hidden run
 * it meets — producing a single polyline that is half a lie, on one layer.
 */
export function technicalDrawingDxf(
  visible: Array<[[number, number], [number, number]]>,
  hidden: Array<[[number, number], [number, number]]>,
  view: ViewSpec,
  options: DxfOptions = {}
): DxfResult & { hiddenSegmentCount: number } {
  const dims = computeDimensions(options.annotations, view, options.dimensionScaleHint);
  const split = (segs: Array<[[number, number], [number, number]]>) => {
    const chains = segmentsToPolylines(segs);
    const polyChains: Array<{ points: Array<[number, number]>; closed: boolean }> = [];
    const singleLines: Array<[[number, number], [number, number]]> = [];
    for (const ch of chains) {
      if (!ch.closed && ch.points.length === 2) singleLines.push([ch.points[0], ch.points[1]]);
      else polyChains.push(ch);
    }
    return { polyChains, singleLines };
  };
  const vis = split(visible);
  const hid = split(hidden);
  const { dxf, dimensionCount } = serializeDxf(vis.polyChains, vis.singleLines, options, dims, {
    chains: hid.polyChains,
    singleLines: hid.singleLines,
  });
  return {
    dxf,
    segmentCount: visible.length,
    hiddenSegmentCount: hidden.length,
    chainCount: vis.polyChains.length,
    lineCount: vis.singleLines.length,
    ...(dimensionCount !== undefined ? { dimensionCount } : {}),
  };
}

export function silhouetteDxf(
  positions: Float32Array,
  edges: Array<[number, number]>,
  view: ViewSpec,
  options: DxfOptions = {}
): DxfResult {
  const basis = viewBasis(view.direction, view.up);
  const dims = computeDimensions(options.annotations, view, options.dimensionScaleHint);
  const segs: Array<[[number, number], [number, number]]> = [];
  for (const [a, b] of edges) {
    const pa: Vec3 = [positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]];
    const pb: Vec3 = [positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]];
    const projA: [number, number] = [dot(pa, basis.right), -dot(pa, basis.up)];
    const projB: [number, number] = [dot(pb, basis.right), -dot(pb, basis.up)];
    if (!Number.isFinite(projA[0]) || !Number.isFinite(projA[1]) || !Number.isFinite(projB[0]) || !Number.isFinite(projB[1])) continue;
    segs.push([projA, projB]);
  }
  if (segs.length === 0) {
    const { dxf, dimensionCount } = serializeDxf([], [], options, dims);
    return { dxf, segmentCount: 0, chainCount: 0, lineCount: 0, ...(dimensionCount !== undefined ? { dimensionCount } : {}) };
  }
  const chains = segmentsToPolylines(segs);
  const polyChains: Array<{ points: Array<[number, number]>; closed: boolean }> = [];
  const singleLines: Array<[[number, number], [number, number]]> = [];
  for (const ch of chains) {
    if (!ch.closed && ch.points.length === 2) singleLines.push([ch.points[0], ch.points[1]]);
    else polyChains.push(ch);
  }
  const { dxf, dimensionCount } = serializeDxf(polyChains, singleLines, options, dims);
  return { dxf, segmentCount: segs.length, chainCount: polyChains.length, lineCount: singleLines.length, ...(dimensionCount !== undefined ? { dimensionCount } : {}) };
}

/** Re-exported for backward compatibility — it moved to `svgSilhouette.ts` so
 * the SVG writer could chain hidden runs without an import cycle. */
export { segmentsToPolylines };
