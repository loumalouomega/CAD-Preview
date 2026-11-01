import { describe, expect, it } from "vitest";
import { compileParametricCurve } from "./parametricCurve";
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
  it("re-evaluates when a document variable changes (resolve-on-read)", () => {
    const a = resolveEditOps([wave()], { A: 0.1 }).ops[0];
    const b = resolveEditOps([wave()], { A: 0.3 }).ops[0];
    expect(a.op === "addSpline" && b.op === "addSpline" && a.points[1][1] * 3).toBeCloseTo((b as { points: number[][] }).points[1][1]);
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
  it("an unresolved variable is reported and leaves the op for the kernel to skip", () => {
    const { ops, issues } = resolveEditOps([wave()], {});
    expect(ops[0].op).toBe("addParametricCurve");
    expect(issues[0]).toMatch(/unknown variable 'A'.*not drawn/);
  });
  it("a degenerate curve is refused rather than fed to the spline fit", () => {
    const r = compileParametricCurve(wave({ x: "1", y: "1" }), {});
    expect(r.ok).toBe(false);
  });
});
