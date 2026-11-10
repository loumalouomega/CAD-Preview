/**
 * Circular-arc fitting for DXF export (roadmap "SVG `<use>` and `<text>`, and
 * DXF arcs"). A silhouette of a hole arrives as a tessellated run of short
 * straight segments; written verbatim it is an N-gon in the receiving CAD.
 * This module is pure and Node-free: it turns runs of chain vertices that lie
 * on one circle into a single bulged LWPOLYLINE segment, and a closed chain
 * that is one full circle into a CIRCLE.
 *
 * **Frame.** Everything here works in the input (Y-down screen) frame, the
 * same frame as `Chain.points`; `dxfSilhouette.ts`'s writer negates Y and the
 * bulge sign once at the write boundary, so a bulge here is positive for a
 * counter-clockwise sweep in the INPUT coordinates.
 *
 * **Tolerance, stated plainly.** A run is accepted only when every vertex of it
 * lies within `tol` of the least-squares circle. `tol` is the caller's absolute
 * `arcTolerance` (drawing units) or, by default, {@link DEFAULT_RELATIVE_TOLERANCE}
 * of the fitted radius. A run needs at least {@link MIN_ARC_POINTS} vertices
 * and a sweep of at least {@link MIN_SWEEP_RAD}, so a straight or nearly
 * straight run (whose circle has a huge radius) is never turned into an arc.
 */

export type Pt = [number, number];

export interface ArcChain {
  points: Pt[];
  closed: boolean;
  /** `bulges[i]` is the bulge of the segment starting at vertex `i` (0 = straight). */
  bulges?: number[];
  /** Set when the whole chain is one full circle (written as CIRCLE). */
  circle?: { cx: number; cy: number; r: number };
}

export const DEFAULT_RELATIVE_TOLERANCE = 0.005;
export const MIN_ARC_POINTS = 4;
/** 20 degrees. */
export const MIN_SWEEP_RAD = (20 * Math.PI) / 180;
const MAX_RUN = 4096;
/** Largest angle one tessellation segment may subtend (35 degrees). A square's
 * corners and a hexagon's or octagon's vertices are concyclic but are polygons,
 * not tessellated arcs — their steps are 45 degrees and up. */
const MAX_STEP_RAD = (35 * Math.PI) / 180;

export interface FittedCircle {
  cx: number;
  cy: number;
  r: number;
  /** Largest |distance to centre − r| over the fitted points. */
  maxError: number;
}

/** Kåsa least-squares circle through `pts`; null for fewer than 3 points or a collinear set. */
export function fitCircle(pts: ReadonlyArray<Pt>, from = 0, to = pts.length): FittedCircle | null {
  const n = to - from;
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (let i = from; i < to; i++) {
    mx += pts[i][0];
    my += pts[i][1];
  }
  mx /= n;
  my /= n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = from; i < to; i++) {
    const u = pts[i][0] - mx;
    const v = pts[i][1] - my;
    suu += u * u;
    suv += u * v;
    svv += v * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  const scale = (suu + svv) * (suu + svv);
  if (!Number.isFinite(det) || Math.abs(det) <= 1e-12 * scale) return null;
  const b1 = 0.5 * (suuu + suvv);
  const b2 = 0.5 * (svvv + svuu);
  const uc = (b1 * svv - b2 * suv) / det;
  const vc = (suu * b2 - suv * b1) / det;
  const r2 = uc * uc + vc * vc + (suu + svv) / n;
  if (!(r2 > 0)) return null;
  const cx = mx + uc;
  const cy = my + vc;
  const r = Math.sqrt(r2);
  let maxError = 0;
  for (let i = from; i < to; i++) {
    maxError = Math.max(maxError, Math.abs(Math.hypot(pts[i][0] - cx, pts[i][1] - cy) - r));
  }
  return { cx, cy, r, maxError };
}

function wrapPi(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Signed total sweep around the circle's centre over `pts[from..to)`, or null
 * when the angular steps are not all the same sign and under {@link MAX_STEP_RAD}
 * (a run that doubles back, or a coarse polygon, is not one arc).
 */
function sweepOf(pts: ReadonlyArray<Pt>, from: number, to: number, c: FittedCircle): number | null {
  let total = 0;
  let sign = 0;
  for (let i = from + 1; i < to; i++) {
    const a0 = Math.atan2(pts[i - 1][1] - c.cy, pts[i - 1][0] - c.cx);
    const a1 = Math.atan2(pts[i][1] - c.cy, pts[i][0] - c.cx);
    const d = wrapPi(a1 - a0);
    if (d === 0 || Math.abs(d) > MAX_STEP_RAD) return null;
    const s = d > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return null;
    total += d;
  }
  return total;
}

function toleranceFor(c: FittedCircle, absolute: number | undefined): number {
  return absolute !== undefined && absolute > 0 ? absolute : DEFAULT_RELATIVE_TOLERANCE * c.r;
}

function acceptRun(pts: ReadonlyArray<Pt>, from: number, to: number, absolute: number | undefined): { c: FittedCircle; sweep: number } | null {
  const c = fitCircle(pts, from, to);
  if (!c || c.maxError > toleranceFor(c, absolute)) return null;
  const sweep = sweepOf(pts, from, to, c);
  if (sweep === null) return null;
  return { c, sweep };
}

/**
 * Replaces arc-like runs of one chain with bulged segments, or the whole chain
 * with a circle. A chain with nothing to fit is returned unchanged (same
 * object), so a straight drawing stays byte-identical.
 */
export function fitArcsInChain(chain: ArcChain, absoluteTolerance?: number): ArcChain {
  const pts = chain.points;
  const n = pts.length;
  if (n < MIN_ARC_POINTS) return chain;

  // A closed loop that is one circle.
  if (chain.closed && n >= 8) {
    const whole = acceptRun([...pts, pts[0]], 0, n + 1, absoluteTolerance);
    if (whole && Math.abs(Math.abs(whole.sweep) - 2 * Math.PI) < 1e-6 + 0.02) {
      return { points: pts, closed: true, circle: { cx: whole.c.cx, cy: whole.c.cy, r: whole.c.r } };
    }
  }

  const outPts: Pt[] = [];
  const bulges: number[] = [];
  let any = false;
  let i = 0;
  while (i < n) {
    let bestEnd = -1;
    let best: { c: FittedCircle; sweep: number } | null = null;
    if (i + MIN_ARC_POINTS <= n) {
      // Grow the run while it still fits; keep the longest accepted end.
      for (let j = i + MIN_ARC_POINTS; j <= Math.min(n, i + MAX_RUN); j++) {
        const fit = acceptRun(pts, i, j, absoluteTolerance);
        if (!fit) break; // a longer window cannot rescue a failed one
        best = fit;
        bestEnd = j;
      }
    }
    if (best && Math.abs(best.sweep) >= MIN_SWEEP_RAD && Math.abs(best.sweep) < 2 * Math.PI - 1e-3) {
      outPts.push(pts[i]);
      bulges.push(Math.tan(best.sweep / 4));
      any = true;
      // The run's last vertex starts the next piece (shared endpoint).
      i = bestEnd - 1;
    } else {
      outPts.push(pts[i]);
      bulges.push(0);
      i++;
    }
  }
  if (!any) return chain;
  return { points: outPts, closed: chain.closed, bulges };
}

export function fitArcsInChains(chains: ReadonlyArray<ArcChain>, absoluteTolerance?: number): ArcChain[] {
  return chains.map((c) => fitArcsInChain(c, absoluteTolerance));
}

export function countArcs(chains: ReadonlyArray<ArcChain>): { arcCount: number; circleCount: number } {
  let arcCount = 0;
  let circleCount = 0;
  for (const c of chains) {
    if (c.circle) circleCount++;
    else if (c.bulges) for (const b of c.bulges) if (b !== 0) arcCount++;
  }
  return { arcCount, circleCount };
}
