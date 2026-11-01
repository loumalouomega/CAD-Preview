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
    ? { ok: true, op: { op: "addPolyline", points, closed: op.closed === true, ...guide } }
    : { ok: true, op: { op: "addSpline", points, ...guide } };
}
