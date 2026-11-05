import { describe, expect, it } from "vitest";
import { compileParametricCurve, loopSelfIntersects } from "./parametricCurve";
import { resolveEditOps } from "./editVariables";
import { validateEditOp, type AddParametricCurveOp } from "./editOps";

const wave = (over: Record<string, unknown> = {}) =>
  validateEditOp({ op: "addParametricCurve", x: "s", y: "A*sin(360*s)", sMin: 0, sMax: 1, samples: 5, ...over }) as AddParametricCurveOp;

describe("addParametricCurve", () => {
  it("samples x(s), y(s) evenly and expands to an addSpline", () => {
    const r = compileParametricCurve(wave(), { A: 0.1 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.op.op !== "addSpline") throw new Error("expected spline");
    expect(r.op.points).toHaveLength(5);
    expect(r.op.points[1][0]).toBeCloseTo(0.25);
    expect(r.op.points[1][1]).toBeCloseTo(0.1); // sin(90°)
    expect(r.op.points[2][1]).toBeCloseTo(0, 12);
    expect(r.op.points[4]).toEqual([1, expect.closeTo(0, 12), 0]);
  });
  it("resolve-on-read keeps the op and refreshes its cached samples when a variable changes", () => {
    const a = resolveEditOps([wave()], { A: 0.1 }).ops[0] as AddParametricCurveOp;
    const b = resolveEditOps([a], { A: 0.3 }).ops[0] as AddParametricCurveOp;
    expect(a.op).toBe("addParametricCurve");
    expect(a.points![1][1]).toBeCloseTo(0.1);
    expect(b.points![1][1]).toBeCloseTo(0.3);
    expect(b.x).toBe("s");
  });
  it("polyline form can be closed; spline cannot", () => {
    const r = compileParametricCurve(wave({ as: "polyline", closed: true, samples: 6, y: "s*(1-s)" }), {});
    expect(r.ok && r.op.op === "addPolyline" && r.op.closed).toBe(true);
    expect(wave({ closed: true })).toBeNull();
  });
  it("places the sketch on a plane: x along up, y along normal × up", () => {
    // Plane z = 5 faced +Z, up = +X: identity mapping lifted to z = 5.
    const up = compileParametricCurve(wave({ plane: { origin: [0, 0, 5], normal: [0, 0, 1], up: [1, 0, 0] } }), { A: 1 });
    expect(up.ok && up.op.op === "addSpline" && up.op.points[1].map((c) => Math.round(c * 1e9) / 1e9)).toEqual([0.25, 1, 5]);
    // Plane x = 2 faced +X, up = +Y: sketch x -> world Y, sketch y -> world Z (X × Y = Z).
    const side = compileParametricCurve(wave({ plane: { origin: [2, 0, 0], normal: [1, 0, 0], up: [0, 1, 0] } }), { A: 1 });
    expect(side.ok && side.op.op === "addSpline" && side.op.points[1].map((c) => Math.round(c * 1e9) / 1e9)).toEqual([2, 0.25, 1]);
    expect(wave({ plane: { origin: [0, 0, 0], normal: [0, 0, 1], up: [0, 0, 2] } })).toBeNull();
  });
  it("is gated: bad expressions, ranges and sample counts are dropped", () => {
    expect(wave({ sMax: 0 })).toBeNull();
    expect(wave({ samples: 1 })).toBeNull();
    expect(wave({ samples: 5000 })).toBeNull();
    expect(wave({ x: "" })).toBeNull();
  });
  it("an unresolved variable is reported and the previous samples are kept", () => {
    const good = resolveEditOps([wave()], { A: 0.1 }).ops[0] as AddParametricCurveOp;
    const { ops, issues } = resolveEditOps([good], {});
    expect((ops[0] as AddParametricCurveOp).points).toEqual(good.points);
    expect(issues[0]).toMatch(/unknown variable 'A'.*keeping the previous curve/);
  });
  it("a degenerate curve is refused rather than fed to the spline fit", () => {
    const r = compileParametricCurve(wave({ x: "1", y: "1" }), {});
    expect(r.ok).toBe(false);
  });
  it("close keeps the op, round-trips through validation, and is gated", () => {
    const c = wave({ close: true, samples: 8, y: "s*(1-s)" });
    expect(c.close).toBe(true);
    expect(validateEditOp(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(wave({ close: true, samples: 2 })).toBeNull(); // curve + chord would be a line
    expect(wave({ close: true, guide: true })).toBeNull(); // a face is not construction geometry
    expect(wave({ close: false })).not.toHaveProperty("close");
    // close supersedes a polyline's own `closed`: the kernel adds the chord itself, so the polyline stays open
    const poly = { as: "polyline", closed: true, close: true, samples: 6, y: "s*(1-s)" };
    const r = compileParametricCurve(wave(poly), {});
    expect(r.ok && r.op.op === "addPolyline" && r.op.closed).toBe(false);
    expect(wave(poly).closed).toBeUndefined();
  });
  it("loopSelfIntersects: a one-lobe loop is simple, a full sine period touches its chord", () => {
    const pts = (n: number, f: (s: number) => number, s1: number) =>
      Array.from({ length: n }, (_, i) => { const s = (s1 * i) / (n - 1); return [s, f(s), 0] as [number, number, number]; });
    const sine = (s: number) => 0.1 * Math.sin(2 * Math.PI * s);
    expect(loopSelfIntersects(pts(41, sine, 0.5))).toBe(false); // half period: one hump over its chord
    expect(loopSelfIntersects(pts(41, sine, 1))).toBe(true); // full period: figure-8 about the chord
    expect(loopSelfIntersects(pts(40, sine, 1))).toBe(true); // even count: no sample on the touch point, still crosses
    expect(loopSelfIntersects(pts(24, (s) => 0.5 + 0.3 * s * (1 - s), 1))).toBe(false);
    // a bow-tie in a vertical plane (y constant) crosses itself; a triangle there does not
    expect(loopSelfIntersects([[0, 0, 0], [1, 0, 1], [1, 0, 0], [0, 0, 1]])).toBe(true);
    expect(loopSelfIntersects([[0, 0, 0], [1, 0, 0], [1, 0, 1]])).toBe(false);
  });
});
