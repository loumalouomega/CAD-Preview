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
  const lines: string[] = [];
  const push = (code: number, value: string) => { lines.push(String(code)); lines.push(value); };
  // Minimal HEADER
  push(0, "SECTION");
  push(2, "HEADER");
  push(9, "$ACADVER");
  push(1, "AC1015");
  if (options.title) {
    push(9, "$COMMENTS");
    push(1, options.title);
  }
  push(0, "ENDSEC");
  push(0, "SECTION");
  push(2, "ENTITIES");

  // Emit chains as LWPOLYLINE
  for (const ch of chains) {
    if (ch.points.length < 2) continue;
    // Chains of exactly 2 points could be emitted as LINE instead; we keep
    // them as LWPOLYLINE so the file has a consistent polyline representation
    // for chained outlines. The caller may split singletons separately.
    push(0, "LWPOLYLINE");
    push(8, "0");
    push(90, String(ch.points.length));
    push(70, ch.closed ? "1" : "0");
    // Constant width / elevation not needed
    for (let i = 0; i < ch.points.length; i++) {
      const [x, y] = ch.points[i];
      push(10, fmt(x));
      push(20, fmt(y));
      // Bulge for segment starting at this vertex (last vertex's bulge is for
      // closing segment when closed, otherwise irrelevant)
      const bulge = ch.bulges?.[i] ?? 0;
      if (bulge !== 0) push(42, fmt(bulge));
    }
  }

  for (const [a, b] of singleLines) {
    push(0, "LINE");
    push(8, "0");
    push(10, fmt(a[0]));
    push(20, fmt(a[1]));
    push(30, "0");
    push(11, fmt(b[0]));
    push(21, fmt(b[1]));
    push(31, "0");
  }
  // Occluded geometry on its own layer.
  //
  // A LAYER, not a dashed linetype: this writer emits no TABLES/LTYPE section
  // at all, so a genuine DASHED linetype would mean adding that machinery. A
  // separate layer is the honest cheap form — a CAD user toggles or restyles it
  // — and it is the same mechanism the DIMENSIONS glyphs already use.
  for (const ch of hidden?.chains ?? []) {
    if (ch.points.length < 2) continue;
    push(0, "LWPOLYLINE");
    push(8, "HIDDEN");
    push(90, String(ch.points.length));
    push(70, ch.closed ? "1" : "0");
    for (const p of ch.points) {
      push(10, fmt(p[0]));
      push(20, fmt(p[1]));
      push(42, "0");
    }
  }
  for (const [a, b] of hidden?.singleLines ?? []) {
    push(0, "LINE");
    push(8, "HIDDEN");
    push(10, fmt(a[0]));
    push(20, fmt(a[1]));
    push(11, fmt(b[0]));
    push(21, fmt(b[1]));
  }


  // Dimension glyphs — a separate layer so a CAD user can toggle them
  // independently of the outline geometry.
  let dimensionCount: number | undefined;
  if (dims && dims.drawings.length > 0) {
    dimensionCount = dims.drawings.length;
    for (const drawing of dims.drawings) {
      for (const [a, b] of drawing.lines) {
        push(0, "LINE");
        push(8, "DIMENSIONS");
        push(10, fmt(a[0]));
        push(20, fmt(a[1]));
        push(30, "0");
        push(11, fmt(b[0]));
        push(21, fmt(b[1]));
        push(31, "0");
      }
      for (const t of drawing.triangles) {
        push(0, "LWPOLYLINE");
        push(8, "DIMENSIONS");
        push(90, "3");
        push(70, "1"); // closed
        for (const p of t) {
          push(10, fmt(p[0]));
          push(20, fmt(p[1]));
        }
      }
      for (const l of drawing.labels) {
        push(0, "TEXT");
        push(8, "DIMENSIONS");
        push(10, fmt(l.x)); // insertion point (ignored when justified)
        push(20, fmt(l.y));
        push(30, "0");
        push(40, fmt(dims.textHeight));
        push(1, l.text);
        push(72, "1"); // horizontal: center
        push(73, "2"); // vertical: middle
        push(11, fmt(l.x)); // alignment point (used because 72/73 are set)
        push(21, fmt(l.y));
        push(31, "0");
      }
    }
  }

  push(0, "ENDSEC");
  push(0, "EOF");
  return { dxf: lines.join("\n") + "\n", ...(dimensionCount !== undefined ? { dimensionCount } : {}) };
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
