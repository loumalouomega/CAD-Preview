import { describe, it, expect } from "vitest";
import { validateEditOp, BREP_ONLY_OPS, TOPOLOGY_CHANGING_OPS } from "./editOps";

describe("validateEditOp", () => {
  it("accepts well-formed transform ops", () => {
    expect(validateEditOp({ op: "translate", targets: ["solid-0"], vec: [1, 2, 3] }))
      .toEqual({ op: "translate", targets: ["solid-0"], vec: [1, 2, 3] });
    expect(validateEditOp({ op: "scale", targets: ["solid-0"], center: [0, 0, 0], factors: [2, 1, 1] }))
      .toMatchObject({ op: "scale" });
  });

  it("accepts well-formed boolean and fillet/chamfer ops", () => {
    expect(validateEditOp({ op: "boolean", kind: "union", a: ["solid-0"], b: ["solid-1"] }))
      .toMatchObject({ op: "boolean", kind: "union" });
    expect(validateEditOp({ op: "fillet", edges: ["edge-3"], radius: 0.5 }))
      .toEqual({ op: "fillet", edges: ["edge-3"], radius: 0.5 });
    expect(validateEditOp({ op: "chamfer", edges: ["edge-3"], distance: 0.5 }))
      .toEqual({ op: "chamfer", edges: ["edge-3"], distance: 0.5 });
  });

  it("rejects malformed ops", () => {
    expect(validateEditOp(null)).toBeNull();
    expect(validateEditOp({ op: "translate", targets: [], vec: [1, 2, 3] })).toBeNull(); // empty targets
    expect(validateEditOp({ op: "translate", targets: ["a"], vec: [1, 2] })).toBeNull(); // short vec
    expect(validateEditOp({ op: "translate", targets: ["a"], vec: [1, null, 3] })).toBeNull(); // non-finite
    expect(validateEditOp({ op: "boolean", kind: "nope", a: ["a"], b: ["b"] })).toBeNull(); // bad kind
    expect(validateEditOp({ op: "fillet", edges: ["e"] })).toBeNull(); // missing radius
    expect(validateEditOp({ op: "loft", profiles: ["one"] })).toBeNull(); // loft needs ≥2
    expect(validateEditOp({ op: "bogus" })).toBeNull();
  });

  it("classifies B-rep-only and topology-changing ops", () => {
    expect(BREP_ONLY_OPS.has("fillet")).toBe(true);
    expect(BREP_ONLY_OPS.has("translate")).toBe(false);
    expect(TOPOLOGY_CHANGING_OPS.has("boolean")).toBe(true);
    expect(TOPOLOGY_CHANGING_OPS.has("translate")).toBe(false);
  });
});
