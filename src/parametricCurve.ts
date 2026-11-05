/**
 * `addParametricCurve` — a curve given as functions of a parameter `s`
 * (a sinusoidal electrode, an airfoil thickness law, a cam). It is compiled
 * on read, exactly like `exprs`: the stored op keeps the expression text, and
 * every consumer (host replay, webview, headless tools) sees the plain
 * `addSpline`/`addPolyline` it expands to, so the OCCT path is the one already
 * verified for those ops and a changed document variable re-evaluates the
 * curve. Pure and DOM/vscode-free.
 */

import { evalExpr } from "./paramExpr";
import type { AddParametricCurveOp, EditOp, Vec3 } from "./editOps";

const unit = (a: Vec3): Vec3 => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };

export const MAX_CURVE_SAMPLES = 2000;

export type CompileResult = { ok: true; op: EditOp } | { ok: false; error: string };

/** Expand `op` against the document variable `values` (`s` is bound per sample, shadowing a variable of that name). */
export function compileParametricCurve(op: AddParametricCurveOp, values: Record<string, number>): CompileResult {
  const points: Vec3[] = [];
  const exprs: Array<[string, string]> = [["x", op.x], ["y", op.y], ["z", op.z ?? "0"]];
  for (let i = 0; i < op.samples; i++) {
    const s = op.sMin + ((op.sMax - op.sMin) * i) / (op.samples - 1);
    const scope = { ...values, s };
    const p: number[] = [];
    for (const [name, src] of exprs) {
      const r = evalExpr(src, scope);
      if (!r.ok) return { ok: false, error: `${name}(s) = "${src}" at s = ${s}: ${r.error}` };
      p.push(r.value);
    }
    points.push(p as Vec3);
  }
  if (op.plane) {
    const [nx, ny, nz] = unit(op.plane.normal);
    const d = op.plane.up[0] * nx + op.plane.up[1] * ny + op.plane.up[2] * nz;
    const u = unit([op.plane.up[0] - d * nx, op.plane.up[1] - d * ny, op.plane.up[2] - d * nz]);
    const v: Vec3 = [ny * u[2] - nz * u[1], nz * u[0] - nx * u[2], nx * u[1] - ny * u[0]];
    const o = op.plane.origin;
    for (const p of points) {
      const [x, y, z] = p;
      p[0] = o[0] + x * u[0] + y * v[0] + z * nx;
      p[1] = o[1] + x * u[1] + y * v[1] + z * ny;
      p[2] = o[2] + x * u[2] + y * v[2] + z * nz;
    }
  }
  for (let i = 1; i < points.length; i++) {
    if (points[i].every((c, k) => c === points[i - 1][k])) {
      return { ok: false, error: `consecutive samples ${i} and ${i + 1} coincide — the curve is degenerate` };
    }
  }
  const guide = op.guide ? { guide: true as const } : {};
  return op.as === "polyline"
    ? { ok: true, op: { op: "addPolyline", points, closed: op.closed === true && op.close !== true, ...guide } }
    : { ok: true, op: { op: "addSpline", points, ...guide } };
}

/**
 * True when the loop `points[0] … points[n-1]` + the straight closing segment
 * back to `points[0]` touches or crosses itself (within `1e-6 × extent`). Such
 * a loop bounds regions of opposite winding (`y = sin` over a full period
 * touches its own chord at the half period), so the planar face built from it
 * has net-zero signed area — the kernel refuses it by name rather than
 * extruding an empty solid. Works in the world axis plane the points are
 * flattest in (a planar curve in any plane keeps its intersections under that
 * projection); pure, O(n²) with a bounding-box early-out.
 */
export function loopSelfIntersects(points: Vec3[]): boolean {
  const n = points.length;
  if (n < 3) return false;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const drop = ext[0] <= ext[1] && ext[0] <= ext[2] ? 0 : ext[1] <= ext[2] ? 1 : 2;
  const [a, b] = [0, 1, 2].filter((k) => k !== drop);
  const pts = points.map((p) => [p[a], p[b]] as const);
  const eps = 1e-6 * Math.max(ext[a], ext[b], 1e-12);
  const segs = n; // n - 1 curve segments + the closing one
  const at = (i: number): [readonly number[], readonly number[]] => (i < n - 1 ? [pts[i], pts[i + 1]] : [pts[n - 1], pts[0]]);
  const pointSeg = (p: readonly number[], s: readonly (readonly number[])[]): number => {
    const [q, r] = s;
    const dx = r[0] - q[0], dy = r[1] - q[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - q[0]) * dx + (p[1] - q[1]) * dy) / len2));
    return Math.hypot(p[0] - (q[0] + t * dx), p[1] - (q[1] + t * dy));
  };
  const orient = (p: readonly number[], q: readonly number[], r: readonly number[]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  for (let i = 0; i < segs; i++) {
    const s = at(i);
    for (let j = i + 2; j < segs; j++) {
      if (i === 0 && j === segs - 1) continue; // first and closing segment share points[0]
      const t = at(j);
      if (Math.max(s[0][0], s[1][0]) + eps < Math.min(t[0][0], t[1][0]) || Math.max(t[0][0], t[1][0]) + eps < Math.min(s[0][0], s[1][0])) continue;
      if (Math.max(s[0][1], s[1][1]) + eps < Math.min(t[0][1], t[1][1]) || Math.max(t[0][1], t[1][1]) + eps < Math.min(s[0][1], s[1][1])) continue;
      const o1 = orient(s[0], s[1], t[0]), o2 = orient(s[0], s[1], t[1]), o3 = orient(t[0], t[1], s[0]), o4 = orient(t[0], t[1], s[1]);
      if (o1 * o2 < 0 && o3 * o4 < 0) return true;
      if (Math.min(pointSeg(t[0], s), pointSeg(t[1], s), pointSeg(s[0], t), pointSeg(s[1], t)) <= eps) return true;
    }
  }
  return false;
}
