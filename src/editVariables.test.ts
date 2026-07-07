import { describe, it, expect } from "vitest";
import { validateVariables, evaluateVariables, resolveEditOps, ParamVariable } from "./editVariables";
import { EditOp } from "./editOps";

describe("validateVariables", () => {
  it("keeps well-formed entries in order", () => {
    expect(validateVariables([
      { name: "L", expr: "20", value: 20 },
      { name: "W", expr: "L/2", value: 10 },
    ])).toEqual([
      { name: "L", expr: "20", value: 20 },
      { name: "W", expr: "L/2", value: 10 },
    ]);
  });

  it("drops invalid names, duplicates (first wins), and non-string exprs", () => {
    expect(validateVariables([
      { name: "2L", expr: "1", value: 1 },       // bad name
      { name: "pi", expr: "1", value: 1 },        // reserved
      { name: "L", expr: "20", value: 20 },
      { name: "L", expr: "99", value: 99 },       // duplicate
      { name: "W", expr: 5, value: 5 },           // non-string expr
      { name: "H", expr: "3", value: NaN },       // non-finite cache -> 0
    ])).toEqual([
      { name: "L", expr: "20", value: 20 },
      { name: "H", expr: "3", value: 0 },
    ]);
  });

  it("returns [] for non-arrays", () => {
    expect(validateVariables(undefined)).toEqual([]);
    expect(validateVariables({})).toEqual([]);
  });
});

describe("evaluateVariables", () => {
  it("evaluates in order with derived variables", () => {
    const vars: ParamVariable[] = [
      { name: "L", expr: "20", value: 0 },
      { name: "W", expr: "L/2", value: 0 },
    ];
    const { values, errors } = evaluateVariables(vars);
    expect(values).toEqual({ L: 20, W: 10 });
    expect(errors.size).toBe(0);
    expect(vars[1].value).toBe(10); // cache updated in place
  });

  it("forward/self references fail and keep the cached value", () => {
    const vars: ParamVariable[] = [
      { name: "A", expr: "B+1", value: 7 }, // forward ref -> error, cache kept
      { name: "B", expr: "2", value: 0 },
    ];
    const { values, errors } = evaluateVariables(vars);
    expect(values.A).toBe(7);
    expect(values.B).toBe(2);
    expect(errors.get("A")).toContain("unknown variable");
  });

  it("a failing variable still feeds dependents via its cache", () => {
    const vars: ParamVariable[] = [
      { name: "L", expr: "1/0", value: 20 },
      { name: "W", expr: "L/2", value: 0 },
    ];
    const { values, errors } = evaluateVariables(vars);
    expect(values.L).toBe(20);
    expect(values.W).toBe(10);
    expect(errors.has("L")).toBe(true);
  });
});

describe("resolveEditOps", () => {
  it("patches scalar, vec-component, and point-list fields", () => {
    const ops: EditOp[] = [
      { op: "extrude", profile: "face-1", dir: [0, 0, 1], length: 5, exprs: { "length": "L*2" } },
      { op: "addBox", center: [0, 0, 0], size: [1, 2, 3], exprs: { "size[0]": "L", "size[2]": "L/4" } },
      { op: "addPolyline", points: [[0, 0, 0], [1, 0, 0]], closed: false, exprs: { "points[1][0]": "L" } },
    ];
    const { ops: resolved, issues } = resolveEditOps(ops, { L: 20 });
    expect(issues).toEqual([]);
    expect(resolved[0]).toMatchObject({ length: 40 });
    expect(resolved[1]).toMatchObject({ size: [20, 2, 5] });
    expect(resolved[2]).toMatchObject({ points: [[0, 0, 0], [20, 0, 0]] });
    // originals untouched
    expect(ops[0]).toMatchObject({ length: 5 });
    // exprs survive resolution (they ride on the resolved ops back to the sidecar)
    expect(resolved[0].exprs).toEqual({ "length": "L*2" });
  });

  it("keeps the cached number for a field whose expr fails, applies the rest", () => {
    const ops: EditOp[] = [
      { op: "addBox", center: [0, 0, 0], size: [1, 2, 3], exprs: { "size[0]": "GONE", "size[1]": "L" } },
    ];
    const { ops: resolved, issues } = resolveEditOps(ops, { L: 9 });
    expect(resolved[0]).toMatchObject({ size: [1, 9, 3] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("GONE");
  });

  it("freezes the whole op when resolved values violate a cross-field invariant", () => {
    const ops: EditOp[] = [
      { op: "addTorus", center: [0, 0, 0], axis: [0, 0, 1], majorRadius: 10, minorRadius: 2, exprs: { "minorRadius": "R" } },
    ];
    const { ops: resolved, issues } = resolveEditOps(ops, { R: 50 }); // minor >= major -> invalid
    expect(resolved[0]).toBe(ops[0]); // original by reference, untouched
    expect(resolved[0]).toMatchObject({ minorRadius: 2 });
    expect(issues).toHaveLength(1);
  });

  it("passes ops without exprs through by reference, preserving order", () => {
    const ops: EditOp[] = [
      { op: "translate", targets: ["solid-0"], vec: [1, 2, 3] },
      { op: "addSphere", center: [0, 0, 0], radius: 5, exprs: { "radius": "R" } },
    ];
    const { ops: resolved } = resolveEditOps(ops, { R: 7 });
    expect(resolved[0]).toBe(ops[0]);
    expect(resolved[1]).toMatchObject({ op: "addSphere", radius: 7 });
    expect(resolved.map((o) => o.op)).toEqual(["translate", "addSphere"]);
  });
});
