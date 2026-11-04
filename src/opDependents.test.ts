import { describe, it, expect } from "vitest";
import { findOpDependents, describeDependents } from "./opDependents";
import type { EditOp } from "./editOps";

const ops = [
  { op: "addBox", center: [0, 0, 0], size: [1, 1, 1] },
  { op: "fillet", edges: ["edge-3"], radius: 0.1 },
  { op: "addLine", pointRefs: { start: { id: "point-2" } }, start: [0, 0, 0], end: [1, 0, 0] },
] as unknown as EditOp[];

describe("findOpDependents", () => {
  it("names later ops and Parts that mention produced ids", () => {
    const d = findOpDependents(ops, 0, ["edge-3", "point-2", "face-9"], ["face-9", "face-1"]);
    expect(d.laterOps).toEqual([1, 2]);
    expect(d.partIds).toEqual(["face-9"]);
    expect(describeDependents(d)).toBe("mentioned by op 2, 3; 1 Part entity id");
  });
  it("ignores earlier ops and reports none when unreferenced", () => {
    expect(findOpDependents(ops, 2, ["edge-3"]).none).toBe(true);
    expect(findOpDependents(ops, 0, []).none).toBe(true);
  });
});
