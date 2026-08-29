/**
 * Pure dimension-glyph math (roadmap item "Dimension-style rendering for
 * pinned measurements", Phase 1) — extension/witness-line positioning,
 * arrowhead construction, and numeric-value formatting. No DOM, no Three.js;
 * the runtime consumer is `measurementOverlay.ts`, which converts these plain
 * tuples into scene objects. Unit-tested headless.
 *
 * Two layout styles share one implementation, selected by whether
 * {@link DistanceGlyphOptions.offsetDir} is given:
 *
 * - **On-segment** (no `offsetDir`) — the 3D-view default. The dimension line
 *   IS the measured segment; each endpoint gets an outward-pointing arrowhead
 *   plus a short witness stub perpendicular to the segment. Deliberately
 *   view-independent: a pinned annotation's glyph must not re-orient every
 *   frame while the camera orbits, so no screen-facing offset is computed.
 * - **Offset** (`offsetDir` given) — the classic drafting look, affordable
 *   only where the view basis is fixed (the SVG/DXF export path). The
 *   dimension line is displaced from the measured points along `offsetDir`,
 *   and true perpendicular extension lines connect each measured point to it,
 *   overshooting the dimension line slightly the way a drafted dimension does.
 *
 * All sizes derive from `options.scale` (the model bbox diagonal in world
 * units) so a 3 m frame and a 5 mm screw get proportionate glyphs, capped at
 * a fraction of the measured segment's own length so two arrowheads can never
 * overlap mid-line on a short measurement.
 */

export type Vec3 = [number, number, number];

/** One arrowhead. `tip` sits exactly ON the endpoint being marked; `axis` is
 * the UNIT direction the head points (outward, i.e. away from the segment's
 * interior). */
export interface ArrowheadSpec {
  tip: Vec3;
  axis: Vec3;
  length: number;
  halfWidth: number;
}

/** Everything an overlay/export renderer needs to draw one 2-point dimension. */
export interface DimensionGlyph {
  /** The dimension line (on-segment style: the measured segment itself). */
  line: [Vec3, Vec3];
  /** Measured point → dimension line connectors (offset style only). */
  extensionLines: Array<[Vec3, Vec3]>;
  /** Short perpendicular witness stubs at each endpoint (on-segment style only). */
  witnesses: Array<[Vec3, Vec3]>;
  arrowheads: ArrowheadSpec[];
}

export interface DistanceGlyphOptions {
  /** Model-scale reference (bbox diagonal, world units) — sizes everything. */
  scale: number;
  /** Enables offset style: displaces the dimension line along this direction. */
  offsetDir?: Vec3;
  /** Which perpendicular direction witness stubs run along (default `[0,1,0]`). */
  upHint?: Vec3;
}

/** Arrowhead length, as a factor of the scale reference. */
const ARROW_LENGTH_FRAC = 0.04;
/** An arrowhead may never exceed this fraction of the measured segment, so
 * two opposing heads can never overlap on a short measurement. */
const ARROW_MAX_SEGMENT_FRACTION = 1 / 3;
/** Total included angle of the head is twice this half-angle (slender, like
 * mainstream drafting arrowheads). */
const ARROW_HALF_ANGLE_DEG = 15;
/** Witness stub length relative to the matching arrowhead. */
const WITNESS_VS_ARROW = 1.25;
/** Offset-style displacement of the dimension line, as a factor of scale. */
const OFFSET_FRACTION = 0.08;
/** How far an extension line overshoots past the dimension line (offset
 * style), relative to the arrowhead length — standard drafting convention. */
const EXTENSION_OVERSHOOT_VS_ARROW = 0.5;

function isFiniteVec(v: Vec3): boolean {
  return v.every((c) => Number.isFinite(c));
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scaled(a: Vec3, f: number): Vec3 {
  // `+ 0` folds −0 into +0 (negation is the only −0 producer here) so the
  // returned tuples compare structurally equal to plain zeros.
  return [a[0] * f + 0, a[1] * f + 0, a[2] * f + 0];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function lengthOf(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalized(v: Vec3): Vec3 | null {
  const n = lengthOf(v);
  // Component-wise division (not scaling by 1/n): keeps axis-aligned inputs
  // exact (100/100 === 1), so arrowhead axes on an axis-aligned measurement
  // are exact unit vectors rather than 1±ε.
  return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

/**
 * A unit vector perpendicular to `dir`, lying in the plane spanned by `dir`
 * and the `upHint` — i.e. `upHint` projected off `dir` and normalized. Falls
 * back through fixed hints when the projection degenerates (`upHint` parallel
 * to `dir`), so the result is always deterministic for a given input.
 */
function perpendicularInPlane(dir: Vec3, upHint: Vec3): Vec3 {
  const candidates: Vec3[] = [upHint, [0, 0, 1], [1, 0, 0]];
  for (const hint of candidates) {
    if (!isFiniteVec(hint)) continue;
    const t = normalized(sub(hint, scaled(dir, dot(hint, dir))));
    if (t) return t;
  }
  return [0, 1, 0]; // unreachable in practice: some fixed hint is never parallel to a unit dir
}

/**
 * Computes the complete glyph spec for a 2-point distance dimension.
 *
 * Degenerate input (non-finite coordinates, or the two points effectively
 * coincident) yields a VALID empty-bodied glyph — the measured line only, no
 * arrowheads/stubs — never `NaN` geometry, so callers can still attach a
 * value label without special-casing.
 */
export function computeDistanceGlyph(p0: Vec3, p1: Vec3, options: DistanceGlyphOptions): DimensionGlyph {
  const empty: DimensionGlyph = { line: [[...p0], [...p1]], extensionLines: [], witnesses: [], arrowheads: [] };
  if (!isFiniteVec(p0) || !isFiniteVec(p1) || !(options.scale > 0) || !Number.isFinite(options.scale)) return empty;

  const seg = sub(p1, p0);
  const segLength = lengthOf(seg);
  if (!(segLength > 1e-9)) return empty;
  const dir = scaled(seg, 1 / segLength);

  const arrowLength = Math.max(1e-6, Math.min(options.scale * ARROW_LENGTH_FRAC, segLength * ARROW_MAX_SEGMENT_FRACTION));
  const halfWidth = arrowLength * Math.tan((ARROW_HALF_ANGLE_DEG * Math.PI) / 180);
  const witnessHalf = (arrowLength * WITNESS_VS_ARROW) / 2;
  const arrowheads: ArrowheadSpec[] = [
    { tip: [...p0], axis: scaled(dir, -1), length: arrowLength, halfWidth },
    { tip: [...p1], axis: [...dir], length: arrowLength, halfWidth },
  ];

  const offsetDir = options.offsetDir ? normalized(options.offsetDir) : null;
  if (!offsetDir) {
    // On-segment style: dimension line IS the segment; witness stubs mark the endpoints.
    const perp = perpendicularInPlane(dir, options.upHint ?? [0, 1, 0]);
    return {
      line: [[...p0], [...p1]],
      extensionLines: [],
      witnesses: [
        [add(p0, scaled(perp, -witnessHalf)), add(p0, scaled(perp, witnessHalf))],
        [add(p1, scaled(perp, -witnessHalf)), add(p1, scaled(perp, witnessHalf))],
      ],
      arrowheads,
    };
  }

  // Offset style: displace the dimension line, connect with perpendicular
  // extension lines that overshoot past it (drafting convention).
  const offset = options.scale * OFFSET_FRACTION;
  const q0 = add(p0, scaled(offsetDir, offset));
  const q1 = add(p1, scaled(offsetDir, offset));
  const overshoot = arrowLength * EXTENSION_OVERSHOOT_VS_ARROW;
  return {
    line: [q0, q1],
    extensionLines: [
      [p0, add(q0, scaled(offsetDir, overshoot))],
      [p1, add(q1, scaled(offsetDir, overshoot))],
    ],
    witnesses: [],
    arrowheads: [
      { tip: q0, axis: scaled(dir, -1), length: arrowLength, halfWidth },
      { tip: q1, axis: [...dir], length: arrowLength, halfWidth },
    ],
  };
}

/**
 * Formats a numeric measurement value for a dimension label — enough
 * significant figures to stay readable across scales, never exponential
 * notation for everyday magnitudes, never a fixed-decimal formatter that
 * quantizes a small-unit value into one or two significant digits (the exact
 * defect `svgSilhouette.ts`'s adaptive-precision work fixed for coordinates).
 */
export function formatMeasureValue(value: number): string {
  if (Number.isNaN(value) || !Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e7 || abs < 1e-6) return value.toExponential(3);
  // `Number(...)` strips `toPrecision`'s trailing zeros: 10 → "10", not "10.0000".
  return String(Number(value.toPrecision(6)));
}
