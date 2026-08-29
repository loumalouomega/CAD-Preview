/**
 * Pure orthographic projection + SVG serialization — vscode/OCCT/THREE-free.
 *
 * This is the codebase's **first SVG writer**: `svgImport.ts` reads SVG paths
 * (the Import SVG feature) and `toolbarIcons.ts`/`opIcons.ts` embed markup
 * generated offline by the TikZ pipeline, but nothing until now produced SVG
 * at runtime. The output is deliberately minimal — one `<path>`, no `<style>`,
 * no script, no external references — so it embeds anywhere and matches this
 * codebase's asset-free posture.
 *
 * Scale: **1 SVG user unit = 1 model unit**, with the document's physical
 * `width`/`height` given in millimetres. A drawing exported from a native (mm)
 * model therefore prints 1:1 in any vector tool, which is worth having for a
 * CAD tool and costs nothing. Converting to another unit is a real coordinate
 * scale applied before projection (via `lengthUnits.ts`'s `unitScaleFactor`),
 * the same mechanism every other export in this codebase uses.
 */

import { computeDistanceGlyph } from "./webview/dimensionGlyph";
import { annotatedLabelText, type AnnotatedTolerance } from "./toleranceBand";
import { resolveNamedView } from "./viewDirections";

export type Vec3 = readonly [number, number, number];
type Pt2 = [number, number];

export interface ViewBasis {
  /** Screen right, unit length. */
  right: Vec3;
  /** Screen up, unit length. */
  up: Vec3;
  /** Normalized view direction (model → camera). */
  forward: Vec3;
}

export interface SvgOptions {
  /**
   * Occluded segments, rendered dashed beneath the visible ones — the output of
   * `hiddenLineRemoval.ts`. Already projected 2D, in the same Y-down space
   * `project()` produces, because the hidden-line engine has to project anyway
   * to do its depth test.
   */
  hiddenSegments?: Array<[[number, number], [number, number]]>;
  /** Stroke width in OUTPUT units (i.e. after any unit conversion). Defaults
   * to `max(width, height) / 500`, which keeps lines proportionate at any
   * model scale — a fixed default would vanish on a large model and swamp a
   * small one, and the same applies across converted units. */
  strokeWidth?: number;
  /** Blank margin around the drawing, as a fraction of its larger dimension. */
  marginFrac?: number;
  stroke?: string;
  /** Optional `<title>` — provenance for a reviewer opening the file cold. */
  title?: string;
  /**
   * Precomputed 2D dimension glyphs baked into the drawing below the outline
   * — thinner strokes for glyph lines, filled arrowhead triangles, and value
   * labels. Bounds include them, so a drawing is never clipped by its own
   * dimensions. Prefer passing {@link SvgOptions.annotations} and letting the
   * writer compute this; `dimensions` exists for callers that already hold a
   * computed payload.
   */
  dimensions?: { drawings: DimensionDrawing[]; textHeight: number };
  /**
   * Pinned annotations to render as dimension glyphs (see
   * {@link dimensionDrawings}), computed against this export's own view
   * basis. `dimensionScaleHint` sizes them (model bbox diagonal in drawing
   * units — pass the SAME scale the geometry was converted to).
   */
  annotations?: ReadonlyArray<DimensionSource>;
  dimensionScaleHint?: number;
}

export interface SvgResult {
  svg: string;
  segmentCount: number;
  /** Occluded segments drawn dashed (absent when none were supplied). */
  hiddenSegmentCount?: number;
  /** Annotations whose dimension glyphs were rendered (absent when none were supplied). */
  dimensionCount?: number;
}

const DEFAULT_MARGIN_FRAC = 0.02;
const DEFAULT_STROKE = "#000000";

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length === 0) return [0, 0, 1];
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Builds an orthonormal screen basis for a view direction.
 *
 * The `up` hint falls back to `[0, 0, 1]` when it is (anti-)parallel to the
 * view direction — the gimbal case a straight-down TOP view hits with the
 * default `[0, 1, 0]` up, the same hazard `renderService.ts`'s `DEFAULT_VIEWS`
 * already carries an explicit `up` for.
 */
export function viewBasis(direction: Vec3, up: Vec3 = [0, 1, 0]): ViewBasis {
  const forward = normalize(direction);
  let hint = up;
  if (Math.hypot(...cross(hint, forward)) < 1e-6) hint = [0, 0, 1];
  const right = normalize(cross(hint, forward));
  // `forward` and `right` are unit and perpendicular, so this is already unit.
  const screenUp = cross(forward, right);
  return { right, up: screenUp, forward };
}

/** Projects a world point onto the screen plane. SVG's Y axis grows DOWNWARD,
 * so screen-up is negated — the same flip `svgImport.ts` applies on the way
 * in, since every coordinate this codebase shows the user is Y-up. */
function project(point: Vec3, basis: ViewBasis): [number, number] {
  return [dot(point, basis.right), -dot(point, basis.up)];
}

/** Default coordinate precision, used before the drawing's extent is known
 * (and by the degenerate/empty paths, where it can't matter). */
const DEFAULT_DECIMALS = 4;

/**
 * Decimal places that keep roughly `SIGNIFICANT_DIGITS` significant figures
 * for a drawing of the given extent.
 *
 * A fixed decimal count is wrong at both ends: 4 decimals is generous for a
 * 100 mm part but leaves a 10 mm part exported in FEET (extent ≈ 0.034) with
 * barely two significant digits, visibly distorting the outline. Scaling the
 * precision to the drawing keeps small-unit exports accurate without bloating
 * the `d` attribute for large ones.
 */
const SIGNIFICANT_DIGITS = 6;
function decimalsFor(extent: number): number {
  if (!Number.isFinite(extent) || extent <= 0) return DEFAULT_DECIMALS;
  return Math.min(12, Math.max(0, SIGNIFICANT_DIGITS - Math.ceil(Math.log10(extent))));
}

/** Trims trailing zeros and normalizes `-0` to `0`. */
function fmt(n: number, decimals = DEFAULT_DECIMALS): string {
  return String(Number(n.toFixed(decimals)));
}

/** Stroke width needs SIGNIFICANT digits, not fixed decimals: it is derived
 * from the drawing's own extent, so on a small model — or the same model
 * converted to inches or feet — `toFixed(4)` rounds it down toward zero, and
 * a `stroke-width="0"` path renders as nothing at all. There is exactly one
 * of these per document, so the extra digits cost nothing. */
function fmtStrokeWidth(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "1";
  return String(Number(n.toPrecision(6)));
}

function serialize(segments: Array<[[number, number], [number, number]]>, options: SvgOptions): SvgResult {
  const marginFrac = options.marginFrac ?? DEFAULT_MARGIN_FRAC;
  const stroke = options.stroke ?? DEFAULT_STROKE;
  const titleTag = options.title ? `<title>${escapeXml(options.title)}</title>` : "";
  const dims = options.dimensions;
  const drawings = dims?.drawings ?? [];
  const hiddenSegments = options.hiddenSegments ?? [];

  // Bounds must cover the dimension glyphs too, so a drawing is never clipped
  // by its own annotations. Label points contribute their anchor (the text
  // extends around it; the margin covers the overflow).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const [a, b] of segments) {
    grow(a[0], a[1]);
    grow(b[0], b[1]);
  }
  // Hidden lines are geometry too — a drawing whose bounds ignored them would
  // clip them at the margin.
  for (const [a, b] of hiddenSegments) {
    grow(a[0], a[1]);
    grow(b[0], b[1]);
  }
  for (const drawing of drawings) {
    for (const [a, b] of drawing.lines) {
      grow(a[0], a[1]);
      grow(b[0], b[1]);
    }
    for (const t of drawing.triangles) {
      for (const p of t) grow(p[0], p[1]);
    }
    for (const l of drawing.labels) grow(l.x, l.y);
  }

  // A model that projects to a single point, or produces no segments at all,
  // must still yield a VALID document — never a viewBox full of NaN/Infinity.
  if (!Number.isFinite(minX)) {
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1mm" height="1mm" viewBox="0 0 1 1">${titleTag}</svg>\n`,
      segmentCount: 0,
    };
  }

  let width = maxX - minX;
  let height = maxY - minY;
  if (!(width > 0) && !(height > 0)) {
    // Degenerate (everything projects to one point) — give it a unit box so
    // the document is still well-formed and openable.
    width = 1;
    height = 1;
  }
  const pad = marginFrac * Math.max(width, height);
  const boxWidth = width + 2 * pad;
  const boxHeight = height + 2 * pad;
  const strokeWidth = options.strokeWidth ?? Math.max(boxWidth, boxHeight) / 500;
  const decimals = decimalsFor(Math.max(boxWidth, boxHeight));

  const d = segments
    .map(([a, b]) => `M ${fmt(a[0], decimals)} ${fmt(a[1], decimals)} L ${fmt(b[0], decimals)} ${fmt(b[1], decimals)}`)
    .join(" ");

  // Occluded edges, dashed, drawn FIRST so the solid outline wins wherever the
  // two coincide.
  //
  // The dash pattern is derived from `strokeWidth`, never hardcoded: `serialize`
  // works in MODEL units, so a literal `stroke-dasharray="4 2"` renders solid on
  // a 0.03-unit-wide drawing (a 10 mm part exported in feet) and as a single
  // dash on a 10000-unit one. Formatted with `fmtStrokeWidth`'s significant-digit
  // path for exactly the reason that function documents.
  let hiddenContent = "";
  if (hiddenSegments.length > 0) {
    // CHAINED into polylines first, and that is a correctness fix rather than a
    // size optimization. An SVG subpath restarts the dash pattern at zero, so a
    // segment shorter than one dash renders fully "on" — and a tessellated
    // hidden curve (a hole rim is dozens of short segments) then draws SOLID,
    // indistinguishable from a visible edge. Caught by looking at the output,
    // not by any assertion: every count was correct while the drawing lied.
    const hiddenD = segmentsToPolylines(hiddenSegments)
      .map((chain) => {
        const pts = chain.closed ? [...chain.points, chain.points[0]] : chain.points;
        return pts
          .map((p, i) => `${i === 0 ? "M" : "L"} ${fmt(p[0], decimals)} ${fmt(p[1], decimals)}`)
          .join(" ");
      })
      .join(" ");
    const dash = `${fmtStrokeWidth(strokeWidth * 12)} ${fmtStrokeWidth(strokeWidth * 6)}`;
    hiddenContent =
      `<path fill="none" stroke="${stroke}" stroke-width="${fmtStrokeWidth(strokeWidth)}" ` +
      `stroke-linecap="butt" stroke-dasharray="${dash}" d="${hiddenD}"/>`;
  }

  // Dimension glyphs render BELOW (after) the outline path: thinner strokes
  // for glyph lines so they read as annotation rather than geometry, filled
  // arrowhead triangles, then value labels.
  let dimContent = "";
  let dimensionCount: number | undefined;
  if (dims && drawings.length > 0) {
    dimensionCount = drawings.length;
    const glyphWidth = strokeWidth * 0.6;
    const lineD = drawings
      .flatMap((dr) => dr.lines)
      .map(([a, b]) => `M ${fmt(a[0], decimals)} ${fmt(a[1], decimals)} L ${fmt(b[0], decimals)} ${fmt(b[1], decimals)}`)
      .join(" ");
    if (lineD) {
      dimContent += `<path fill="none" stroke="${stroke}" stroke-width="${fmtStrokeWidth(glyphWidth)}" stroke-linecap="round" d="${lineD}"/>`;
    }
    const triD = drawings
      .flatMap((dr) => dr.triangles)
      .map((t) => `M ${fmt(t[0][0], decimals)} ${fmt(t[0][1], decimals)} L ${fmt(t[1][0], decimals)} ${fmt(t[1][1], decimals)} L ${fmt(t[2][0], decimals)} ${fmt(t[2][1], decimals)} Z`)
      .join(" ");
    if (triD) {
      dimContent += `<path fill="${stroke}" stroke="none" d="${triD}"/>`;
    }
    const fontSize = fmtStrokeWidth(dims.textHeight);
    for (const l of drawings.flatMap((dr) => dr.labels)) {
      dimContent += `<text x="${fmt(l.x, decimals)}" y="${fmt(l.y, decimals)}" font-family="sans-serif" font-size="${fontSize}" fill="${stroke}" text-anchor="middle">${escapeXml(l.text)}</text>`;
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(boxWidth, decimals)}mm" height="${fmt(boxHeight, decimals)}mm" ` +
    `viewBox="${fmt(minX - pad, decimals)} ${fmt(minY - pad, decimals)} ${fmt(boxWidth, decimals)} ${fmt(boxHeight, decimals)}">` +
    titleTag +
    hiddenContent +
    `<path fill="none" stroke="${stroke}" stroke-width="${fmtStrokeWidth(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round" d="${d}"/>` +
    dimContent +
    `</svg>\n`;

  return {
    svg,
    segmentCount: segments.length,
    ...(options.hiddenSegments !== undefined ? { hiddenSegmentCount: hiddenSegments.length } : {}),
    ...(dimensionCount !== undefined ? { dimensionCount } : {}),
  };
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** Named view directions, sharing `renderService.ts`'s `DEFAULT_VIEWS` values
 * where they overlap so an SVG view and a `render_snapshot` view of the same
 * name mean the same thing. TOP/BOTTOM carry an explicit `up` because the
 * default `[0,1,0]` is parallel to their direction (the gimbal case). */
// Derived from `viewDirections.ts`'s full vocabulary rather than declared
// separately, so this curated list and the tool-facing one cannot drift.
// Deliberately kept SHORT: `provider.ts` builds the Export Silhouette QuickPick
// from these keys, so every entry added here becomes a menu row.
export const SVG_VIEWS: Record<string, { direction: [number, number, number]; up?: [number, number, number] }> = {
  FRONT: named("front"),
  BACK: named("back"),
  TOP: named("top"),
  BOTTOM: named("bottom"),
  RIGHT: named("right"),
  LEFT: named("left"),
  ISO: named("iso"),
};

function named(name: string): { direction: [number, number, number]; up?: [number, number, number] } {
  const v = resolveNamedView(name);
  if (!v) throw new Error(`Unknown named view: ${name}`); // unreachable: these are canonical
  return v.up ? { direction: v.direction, up: v.up } : { direction: v.direction };
}

export interface ViewSpec {
  direction: Vec3;
  up?: Vec3;
}

/**
 * Projects pinned annotations into the view plane and computes their
 * dimension-glyph geometry IN PROJECTED 2D (roadmap "Dimension-style rendering",
 * Phase 2) — where the classic offset-dimension drafting look is correct,
 * because the view basis is fixed unlike the orbitable 3D viewer.
 *
 * Reuses the SAME pure math as the 3D overlay (`webview/dimensionGlyph.ts`'s
 * {@link computeDistanceGlyph}, run in its offset style with an up-screen
 * offset direction), so the two renderers cannot drift. The value label
 * composes the annotation's frozen measurement text and tolerance band via
 * `toleranceBand.ts`'s shared helper. A pin whose measured line degenerates
 * (or never had one — radius/edgeLength pins carry no `linePoints`) renders
 * as a bare value label at its projected anchor, which is still worth having
 * on a review drawing.
 *
 * Returns the exact payload shape `SvgOptions.dimensions` /
 * `DxfOptions.dimensions` take, so callers thread it straight through.
 */
export interface DimensionSource {
  anchorPoint: Vec3;
  linePoints?: ReadonlyArray<Vec3>;
  /** Frozen measurement readout, e.g. `"12.5 mm"` or `"R = 3 mm"`. */
  text: string;
  /** Optional frozen tolerance band — decorates the label, drives nothing here. */
  tolerance?: AnnotatedTolerance;
}

export interface DimensionDrawing {
  lines: Array<[Pt2, Pt2]>;
  triangles: Array<[Pt2, Pt2, Pt2]>;
  labels: Array<{ x: number; y: number; text: string }>;
}

export function dimensionDrawings(
  sources: ReadonlyArray<DimensionSource>,
  view: ViewSpec,
  scale: number
): { drawings: DimensionDrawing[]; textHeight: number } {
  const basis = viewBasis(view.direction, view.up);
  const effectiveScale = Number.isFinite(scale) && scale > 0 ? scale : 100;
  const textHeight = effectiveScale * 0.03;
  const project = (p: Vec3): Pt2 => [dot(p, basis.right), -dot(p, basis.up)];
  const finitePt = (p: Pt2): boolean => Number.isFinite(p[0]) && Number.isFinite(p[1]);

  const drawings: DimensionDrawing[] = [];
  for (const src of sources) {
    const label = annotatedLabelText(src.text, src.tolerance);
    const drawing: DimensionDrawing = { lines: [], triangles: [], labels: [] };

    const lp = src.linePoints;
    if (lp && lp.length === 2) {
      const a = project(lp[0]);
      const b = project(lp[1]);
      if (finitePt(a) && finitePt(b)) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len = Math.hypot(dx, dy);
        if (len > 1e-9) {
          // Rotate the projected direction −90°: in SVG's Y-down space that
          // points UP the screen, so the dimension line sits above the
          // measurement like a drafted dimension.
          const offsetDir: [number, number, number] = [dy / len, -dx / len, 0];
          const glyph = computeDistanceGlyph([a[0], a[1], 0], [b[0], b[1], 0], {
            scale: effectiveScale,
            offsetDir,
          });
          for (const seg of [glyph.line, ...glyph.extensionLines]) {
            drawing.lines.push([
              [seg[0][0], seg[0][1]],
              [seg[1][0], seg[1][1]],
            ]);
          }
          for (const head of glyph.arrowheads) {
            const tip: Pt2 = [head.tip[0], head.tip[1]];
            const axis: Pt2 = [head.axis[0], head.axis[1]];
            const base: Pt2 = [tip[0] - axis[0] * head.length, tip[1] - axis[1] * head.length];
            const perp: Pt2 = [-axis[1], axis[0]];
            drawing.triangles.push([
              tip,
              [base[0] + perp[0] * head.halfWidth, base[1] + perp[1] * head.halfWidth],
              [base[0] - perp[0] * head.halfWidth, base[1] - perp[1] * head.halfWidth],
            ]);
          }
          if (drawing.lines.length > 0) {
            const [q0, q1] = drawing.lines[0]; // the displaced dimension line
            drawing.labels.push({
              x: (q0[0] + q1[0]) / 2 + offsetDir[0] * textHeight * 0.7,
              y: (q0[1] + q1[1]) / 2 + offsetDir[1] * textHeight * 0.7,
              text: label,
            });
          }
        }
      }
    }

    if (drawing.lines.length === 0) {
      // No drawable measured line (degenerate, or a 1-point tool's pin).
      const anchor = project(src.anchorPoint);
      if (finitePt(anchor)) drawing.labels.push({ x: anchor[0], y: anchor[1], text: label });
    }

    if (drawing.lines.length > 0 || drawing.triangles.length > 0 || drawing.labels.length > 0) {
      drawings.push(drawing);
    }
  }
  return { drawings, textHeight };
}

/** Renders a mesh's silhouette (see `silhouetteEdges.ts`) as an SVG drawing. */
export function silhouetteSvg(
  positions: Float32Array,
  edges: Array<[number, number]>,
  view: ViewSpec,
  options: SvgOptions = {}
): SvgResult {
  const basis = viewBasis(view.direction, view.up);
  const dims = options.dimensions ?? computeDimensions(options.annotations, view, options.dimensionScaleHint);
  const segments: Array<[[number, number], [number, number]]> = [];
  for (const [a, b] of edges) {
    const pa = project([positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]], basis);
    const pb = project([positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]], basis);
    if (!isFinitePoint(pa) || !isFinitePoint(pb)) continue;
    segments.push([pa, pb]);
  }
  return serialize(segments, { ...options, dimensions: dims });
}

/**
 * Renders already-3D polylines (e.g. OCCT edge discretizations) as an SVG
 * drawing — the counterpart used when the outline comes from the kernel
 * rather than from triangle adjacency. Each polyline is a flat `[x,y,z,…]`
 * run, the same shape `edgeEnumeration.ts`'s `polylineFromDiscretizer`
 * produces.
 */
/**
 * A technical drawing: already-projected visible and hidden 2D segments.
 *
 * Distinct from {@link silhouetteSvg}, which projects internally from
 * positions + vertex-index edge pairs. The hidden-line engine has to project
 * anyway to run its depth test, so re-projecting here would be both wasteful
 * and a second place for the projection convention to drift.
 */
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

export function technicalDrawingSvg(
  visible: Array<[[number, number], [number, number]]>,
  hidden: Array<[[number, number], [number, number]]>,
  view: ViewSpec,
  options: SvgOptions = {}
): SvgResult {
  const dims = options.dimensions ?? computeDimensions(options.annotations, view, options.dimensionScaleHint);
  return serialize(visible, { ...options, dimensions: dims, hiddenSegments: hidden });
}

export function polylinesSvg(polylines: Float32Array[], view: ViewSpec, options: SvgOptions = {}): SvgResult {
  const basis = viewBasis(view.direction, view.up);
  const dims = options.dimensions ?? computeDimensions(options.annotations, view, options.dimensionScaleHint);
  const segments: Array<[[number, number], [number, number]]> = [];
  for (const polyline of polylines) {
    const pointCount = Math.floor(polyline.length / 3);
    let previous: [number, number] | null = null;
    for (let i = 0; i < pointCount; i++) {
      const point = project([polyline[i * 3], polyline[i * 3 + 1], polyline[i * 3 + 2]], basis);
      if (!isFinitePoint(point)) {
        previous = null;
        continue;
      }
      if (previous) segments.push([previous, point]);
      previous = point;
    }
  }
  return serialize(segments, { ...options, dimensions: dims });
}

function computeDimensions(
  annotations: ReadonlyArray<DimensionSource> | undefined,
  view: ViewSpec,
  scaleHint: number | undefined
): { drawings: DimensionDrawing[]; textHeight: number } | undefined {
  if (!annotations || annotations.length === 0) return undefined;
  return dimensionDrawings(annotations, view, scaleHint ?? 100);
}

function isFinitePoint(p: [number, number]): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

/** Scales every position by `factor`, for unit conversion before projection.
 * Returns the input unchanged when the factor is 1, so the native-mm path
 * allocates nothing. */
export function scalePositions(positions: Float32Array, factor: number): Float32Array {
  if (factor === 1) return positions;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i++) out[i] = positions[i] * factor;
  return out;
}
