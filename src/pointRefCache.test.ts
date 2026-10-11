import { describe, it, expect } from "vitest";
import { validateEditOp, type EditOp } from "./editOps";
import { applyPointRefWriteback, pointRefRebindWarnings, type PointRefHit } from "./pointRefCache";

const line = (): EditOp => validateEditOp({ op: "addLine", start: "point-3", end: { id: "point-7", at: [10, 0, 0] } })!;

describe("applyPointRefWriteback", () => {
  it("fills in a missing `at` from the resolved position, leaving untouched ops by identity", () => {
    const other = validateEditOp({ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] })!;
    const ops = [other, line()];
    const out = applyPointRefWriteback(ops, [{ opIndex: 1, slot: "start", id: "point-3", position: [1, 2, 3] }]);
    expect(out.changed).toBe(true);
    expect(out.ops[0]).toBe(other);
    expect(out.ops[1]).toMatchObject({ start: [1, 2, 3], pointRefs: { start: { id: "point-3", at: [1, 2, 3] }, end: { id: "point-7", at: [10, 0, 0] } } });
    // the caller's list and op are not mutated
    expect(ops[1]).toMatchObject({ start: [0, 0, 0] });
  });

  it("is a no-op once the anchor already matches", () => {
    const ops = [line()];
    const first = applyPointRefWriteback(ops, [{ opIndex: 0, slot: "end", id: "point-7", position: [10, 0, 0] }]);
    expect(first.changed).toBe(false);
    expect(first.ops).toBe(ops);
  });

  it("rewrites a rebound id and applies the replay offset", () => {
    const ops = [validateEditOp({ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] })!, line()];
    const hits: PointRefHit[] = [{ opIndex: 0, slot: "end", id: "point-9", position: [10, 0, 0], rebound: { from: "point-7" } }];
    const out = applyPointRefWriteback(ops, hits, 1);
    expect(out.changed).toBe(true);
    expect((out.ops[1] as EditOp).pointRefs!.end).toEqual({ id: "point-9", at: [10, 0, 0] });
    expect(pointRefRebindWarnings(hits, out.ops, 1)).toEqual([
      "op 1 (addLine): point-7 (end) was no longer at its authored position — re-anchored to point-9 by position.",
    ]);
  });

  it("ignores resolutions for ops/slots that carry no such reference", () => {
    const ops = [line()];
    expect(applyPointRefWriteback(ops, [{ opIndex: 5, slot: "start", id: "point-1", position: [0, 0, 0] }]).changed).toBe(false);
    expect(applyPointRefWriteback(ops, [{ opIndex: 0, slot: "middle", id: "point-1", position: [0, 0, 0] }]).changed).toBe(false);
  });
});
