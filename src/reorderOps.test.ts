import { describe, it, expect } from "vitest";
import { planOpMove, remapIndices, bucketRefsOf } from "./reorderOps";
import { remapSuppressedAfterMove } from "./configurations";
import type { EditOp } from "./editOps";

const T = (x: number): EditOp => ({ op: "translate", targets: ["solid-0"], vec: [x, 0, 0] });
const BOX = (x: number): EditOp => ({ op: "addBox", center: [x, 0, 0], size: [1, 1, 1] });
const query = (op: number) => ({ version: 1, source: { kind: "bucket", op, role: "endCap" } }) as never;

describe("planOpMove", () => {
  it("moves a rigid transform across features and reports the old→new mapping", () => {
    const ops = [BOX(0), BOX(5), T(1)];
    const r = planOpMove(ops, 2, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops.map((o) => o.op)).toEqual(["translate", "addBox", "addBox"]);
    expect(r.mapping).toEqual([1, 2, 0]); // old 0 → 1, old 1 → 2, old 2 → 0
    expect(r.ops).not.toBe(ops); // the input list is never mutated
    expect(ops.map((o) => o.op)).toEqual(["addBox", "addBox", "translate"]);
  });

  it("moves downward too (final index is `to`)", () => {
    const r = planOpMove([T(1), T(2), T(3)], 0, 2);
    expect(r.ok && r.ops.map((o) => (o as { vec: number[] }).vec[0])).toEqual([2, 3, 1]);
    expect(r.ok && r.mapping).toEqual([2, 0, 1]);
  });

  it("refuses two shape-changing ops crossing each other, by name", () => {
    const r = planOpMove([BOX(0), BOX(5)], 1, 0);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/both reshape the model/);
    // Control: the same swap is fine when one side is a rigid transform.
    expect(planOpMove([BOX(0), T(1)], 1, 0).ok).toBe(true);
  });

  it("refuses anything touching the saved prefix, and no-ops / out of range", () => {
    expect(planOpMove([T(1), T(2), T(3)], 2, 0, 1).ok).toBe(false); // lands inside the baked op
    expect(planOpMove([T(1), T(2), T(3)], 0, 2, 1).ok).toBe(false); // moves a baked op
    expect(planOpMove([T(1), T(2), T(3)], 2, 1, 1).ok).toBe(true); // wholly in the tail
    expect(planOpMove([T(1), T(2)], 1, 1).ok).toBe(false);
    expect(planOpMove([T(1), T(2)], 0, 2).ok).toBe(false);
    expect(planOpMove([T(1), T(2)], -1, 0).ok).toBe(false);
    expect(planOpMove([T(1), T(2)], 0.5, 1).ok).toBe(false);
  });

  it("refuses when a stored query names an op in the affected span (any holder), but not outside it", () => {
    const withQuery = { ...T(1), targetQueries: { targets: query(1) } } as EditOp;
    const ops = [T(0), T(5), withQuery, T(9)];
    const crossing = planOpMove(ops, 3, 1);
    expect(crossing.ok).toBe(false);
    expect(!crossing.ok && crossing.reason).toMatch(/names op 2/);
    // The same query is irrelevant to a move that stays clear of op index 1.
    expect(planOpMove(ops, 3, 2).ok).toBe(true);
    // A Part's selector (external) pins its op the same way.
    expect(planOpMove([T(0), T(1), T(2)], 2, 0, 0, [1]).ok).toBe(false);
    expect(planOpMove([T(0), T(1), T(2)], 2, 1, 0, [0]).ok).toBe(true);
  });

  it("keeps display tags and suppression on the moved op", () => {
    const ops = [{ ...T(1), suppressed: true, folder: "F", label: "L" } as EditOp, T(2)];
    const r = planOpMove(ops, 0, 1);
    expect(r.ok && r.ops[1]).toEqual(ops[0]);
  });
});

describe("index helpers", () => {
  it("bucketRefsOf reads only bucket sources", () => {
    const op = { ...T(1), targetQueries: { a: query(3), b: { version: 1, source: { kind: "scene" } } } } as unknown as EditOp;
    expect(bucketRefsOf(op)).toEqual([3]);
    expect(bucketRefsOf(T(1))).toEqual([]);
  });

  it("remapIndices follows a move and stays sorted", () => {
    expect(remapIndices([0, 2], [1, 2, 0])).toEqual([0, 1]);
  });

  it("a configuration's suppressed indices keep naming the same ops", () => {
    const state = { configurations: [{ name: "A", overrides: {}, suppressed: [2] }, { name: "B", overrides: {} }], activeConfiguration: null };
    const next = remapSuppressedAfterMove(state, [1, 2, 0]);
    expect(next.configurations[0].suppressed).toEqual([0]);
    expect(next.configurations[1]).toBe(state.configurations[1]);
    const plain = { configurations: [{ name: "B", overrides: {} }], activeConfiguration: null };
    expect(remapSuppressedAfterMove(plain, [1, 0])).toBe(plain);
  });
});
