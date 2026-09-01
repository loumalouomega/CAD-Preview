import { describe, it, expect } from "vitest";
import { validateEditOp } from "./editOps";
import { resolvePlaneRefs } from "./planeRefs";
import type { ConstructionPlane } from "./protocol";

const plane = (over: Partial<ConstructionPlane> = {}): ConstructionPlane => ({
  id: "plane-0",
  name: "Plane 0",
  point: [1, 2, 3],
  normal: [0, 0, 1],
  ...over,
});

describe("resolvePlaneRefs", () => {
  it("resolves a planeId to its point and normal", () => {
    const ops = [validateEditOp({ op: "mirror", targets: ["solid-0"], planeId: "plane-0" })!];
    const { ops: resolved, issues } = resolvePlaneRefs(ops, [plane({ id: "plane-0", point: [5, 5, 5], normal: [1, 0, 0] })]);
    expect(resolved[0]).toMatchObject({ planeId: "plane-0", planePoint: [5, 5, 5], planeNormal: [1, 0, 0] });
    expect(issues).toHaveLength(0);
  });

  it("overwrites cached vectors with the plane's current vectors", () => {
    const ops = [validateEditOp({ op: "mirror", targets: ["solid-0"], planeId: "plane-0", planePoint: [9, 9, 9], planeNormal: [0, 1, 0] })!];
    const { ops: resolved } = resolvePlaneRefs(ops, [plane({ id: "plane-0", point: [0, 0, 0], normal: [0, 0, 1] })]);
    expect(resolved[0]).toMatchObject({ planePoint: [0, 0, 0], planeNormal: [0, 0, 1] });
  });

  it("leaves ops without planeId untouched", () => {
    const ops = [validateEditOp({ op: "mirror", targets: ["solid-0"], planePoint: [0, 0, 0], planeNormal: [0, 0, 1] })!];
    const { ops: resolved, issues } = resolvePlaneRefs(ops, [plane({ id: "plane-0" })]);
    expect(resolved[0]).toEqual(ops[0]);
    expect(issues).toHaveLength(0);
  });

  it("keeps cached vectors and reports an issue when plane not found", () => {
    const ops = [validateEditOp({ op: "splitByPlane", targets: ["solid-0"], planeId: "plane-99", planePoint: [1, 1, 1], planeNormal: [0, 0, 1], keep: "both" })!];
    const { ops: resolved, issues } = resolvePlaneRefs(ops, [plane({ id: "plane-0" })]);
    expect(resolved[0]).toEqual(ops[0]);
    expect(issues[0]).toMatch(/plane-99 not found.*keeping last position/);
  });

  it("reports missing cache when plane not found and no vectors", () => {
    const ops = [validateEditOp({ op: "mirror", targets: ["solid-0"], planeId: "plane-99" })!];
    const { ops: resolved, issues } = resolvePlaneRefs(ops, []);
    expect(resolved[0]).toEqual(ops[0]);
    expect(issues[0]).toMatch(/plane-99 not found.*no cached plane/);
  });

  it("handles draft with omitted plane (no planeId) unchanged", () => {
    const ops = [validateEditOp({ op: "draft", faces: ["face-0"], angleDeg: 5 })!];
    const { ops: resolved } = resolvePlaneRefs(ops, [plane({ id: "plane-0" })]);
    expect(resolved[0]).toEqual(ops[0]);
  });

  it("resolves draft with planeId", () => {
    const ops = [validateEditOp({ op: "draft", faces: ["face-0"], angleDeg: 5, planeId: "plane-0" })!];
    const { ops: resolved } = resolvePlaneRefs(ops, [plane({ id: "plane-0", point: [2, 2, 2], normal: [0, 1, 0] })]);
    expect(resolved[0]).toMatchObject({ planeId: "plane-0", planePoint: [2, 2, 2], planeNormal: [0, 1, 0] });
  });

  it("resolves splitByPlane and section via planeId", () => {
    const s = validateEditOp({ op: "splitByPlane", targets: ["solid-0"], planeId: "plane-0", keep: "both" })!;
    const c = validateEditOp({ op: "section", targets: ["solid-0"], planeId: "plane-0" })!;
    const planes = [plane({ id: "plane-0", point: [7, 7, 7], normal: [1, 0, 0] })];
    const { ops: rs } = resolvePlaneRefs([s, c], planes);
    expect(rs[0]).toMatchObject({ planePoint: [7, 7, 7], planeNormal: [1, 0, 0] });
    expect(rs[1]).toMatchObject({ planePoint: [7, 7, 7], planeNormal: [1, 0, 0] });
  });

  it("is idempotent: resolving twice yields same result", () => {
    const ops = [validateEditOp({ op: "mirror", targets: ["solid-0"], planeId: "plane-0" })!];
    const planes = [plane({ id: "plane-0", point: [3, 3, 3], normal: [0, 0, 1] })];
    const first = resolvePlaneRefs(ops, planes);
    const second = resolvePlaneRefs(first.ops, planes);
    expect(second.ops).toEqual(first.ops);
    expect(second.issues).toHaveLength(0);
  });

  it("handles multiple ops, only those with planeId resolved", () => {
    const a = validateEditOp({ op: "mirror", targets: ["solid-0"], planePoint: [0, 0, 0], planeNormal: [1, 0, 0] })!;
    const b = validateEditOp({ op: "mirror", targets: ["solid-0"], planeId: "plane-0" })!;
    const c = validateEditOp({ op: "translate", targets: ["solid-0"], vec: [1, 0, 0] })!;
    const { ops: resolved } = resolvePlaneRefs([a, b, c], [plane({ id: "plane-0", point: [9, 0, 0], normal: [0, 1, 0] })]);
    expect(resolved[0]).toEqual(a);
    expect(resolved[1]).toMatchObject({ planePoint: [9, 0, 0] });
    expect(resolved[2]).toEqual(c);
  });
});
