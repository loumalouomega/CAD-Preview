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

import { viewBasis, dimensionDrawings, type Vec3, type ViewSpec, type DimensionSource, type DimensionDrawing } from "./svgSilhouette";

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

/**
 * Groups unordered line segments into chains (polylines) by endpoint
 * coincidence. Returns an ordered list of chains; each chain is an ordered
 * list of points (no duplicate closing point when closed). Remaining
 * singletons are kept separate by the caller when it matters, but this helper
 * itself produces only the chains — the caller decides whether a chain of
 * length 2 stays a LINE or becomes an LWPOLYLINE.
 *
 * Tolerance: exact string-key match on `x,y` (projected coordinates derived
 * from the same Float32 positions produce bitwise-identical doubles for shared
 * vertices, so tolerance is not needed for the silhouette path; it also keeps
 * the helper deterministic).
 */
export function segmentsToPolylines(segments: Array<[[number, number], [number, number]]>): Array<{ points: Array<[number, number]>; closed: boolean }> {
  if (segments.length === 0) return [];
  const key = (p: [number, number]): string => `${p[0]},${p[1]}`;
  // Map point key -> segment indices incident at that point (either endpoint)
  const pointToSegs = new Map<string, number[]>();
  for (let i = 0; i < segments.length; i++) {
    for (const p of segments[i] as [number, number][]) {
      const k = key(p);
      const arr = pointToSegs.get(k);
      if (arr) arr.push(i);
      else pointToSegs.set(k, [i]);
    }
  }
  const used = new Array<boolean>(segments.length).fill(false);
  const chains: Array<{ points: Array<[number, number]>; closed: boolean }> = [];

  const pointEqual = (a: [number, number], b: [number, number]): boolean => a[0] === b[0] && a[1] === b[1];

  for (let s = 0; s < segments.length; s++) {
    if (used[s]) continue;
    const seg = segments[s];
    used[s] = true;
    const chain: Array<[number, number]> = [seg[0], seg[1]];

    const extend = (): boolean => {
      let extended = false;
      // Extend tail
      const tail = chain[chain.length - 1];
      const tailKey = key(tail);
      const candidates = pointToSegs.get(tailKey) ?? [];
      for (const idx of candidates) {
        if (used[idx]) continue;
        const cand = segments[idx];
        if (pointEqual(cand[0], tail)) {
          chain.push(cand[1]);
          used[idx] = true;
          extended = true;
          break;
        } else if (pointEqual(cand[1], tail)) {
          chain.push(cand[0]);
          used[idx] = true;
          extended = true;
          break;
        }
      }
      if (extended) return true;
      // Extend head
      const head = chain[0];
      const headKey = key(head);
      const headCandidates = pointToSegs.get(headKey) ?? [];
      for (const idx of headCandidates) {
        if (used[idx]) continue;
        const cand = segments[idx];
        if (pointEqual(cand[1], head)) {
          chain.unshift(cand[0]);
          used[idx] = true;
          return true;
        } else if (pointEqual(cand[0], head)) {
          chain.unshift(cand[1]);
          used[idx] = true;
          return true;
        }
      }
      return false;
    };

    while (extend()) {}
    // Detect closure: first point equals last point => closed loop, remove duplicate tail
    const isClosed = chain.length > 2 && pointEqual(chain[0], chain[chain.length - 1]);
    if (isClosed) chain.pop();
    chains.push({ points: chain, closed: isClosed });
  }
  return chains;
}

function serializeDxf(
  chains: Array<{ points: Array<[number, number]>; closed: boolean; bulges?: number[] }>,
  singleLines: Array<[[number, number], [number, number]]>,
  options: DxfOptions,
  dims?: { drawings: DimensionDrawing[]; textHeight: number }
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
