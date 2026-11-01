import { describe, expect, it } from "vitest";
import { describeRule, ruleFromFaceFacts, type RuleFaceFacts } from "./ruleFromSelection";
import { matchesFacePredicate, type FilterableFace } from "./selectorPredicate";

const planar = (id: string, x: number): RuleFaceFacts => ({
  entityId: id,
  bbox: { min: [x, -5, -5], max: [x, 5, 5], diagonal: 100 },
  normal: [1, 0, 0],
  planeOrigin: [x, 0, 0],
  surfaceType: "plane",
  surfaceParams: { kind: "plane", origin: [x, 0, 0], normal: [1, 0, 0] },
});
const cyl = (id: string, r: number): RuleFaceFacts => ({
  entityId: id, bbox: null, normal: null, planeOrigin: null, surfaceType: "cylinder",
  surfaceParams: { kind: "cylinder", radius: r, axisLocation: [0, 0, 0], axisDirection: [0, 0, 1] },
});

describe("ruleFromFaceFacts", () => {
  it("plane rule keeps matching the end face after the model is lengthened", () => {
    const r = ruleFromFaceFacts([planar("face-3", -50)], "plane");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const leaf = (r.query.source.filter as { kind: "plane" });
    const at = (x: number): FilterableFace => ({ id: "f", area: 1, surfaceType: "plane", normal: [-1, 0, 0], bbox: { min: [x, -5, -5], max: [x, 5, 5] }, planeOrigin: [x, 0, 0] });
    expect(matchesFacePredicate(at(-50), leaf as never, { diagonal: 100 })).toBe(true);
    expect(matchesFacePredicate(at(-80), leaf as never, { diagonal: 100 })).toBe(false);
  });
  it("refuses non-coplanar faces and non-planar input with the face named", () => {
    const r = ruleFromFaceFacts([planar("face-1", 0), planar("face-2", 10)], "plane");
    expect(r).toEqual({ ok: false, reason: "face-2 does not lie on the same plane as face-1." });
    expect(ruleFromFaceFacts([cyl("face-9", 3)], "plane").ok).toBe(false);
    expect(ruleFromFaceFacts([], "box").ok).toBe(false);
  });
  it("box rule covers the union of the selected faces", () => {
    const r = ruleFromFaceFacts([planar("a", 0), planar("b", 10)], "box");
    expect(r.ok && r.query.source.filter).toEqual({ kind: "box", min: [0, -5, -5], max: [10, 5, 5], mode: "inside" });
  });
  it("type rule needs one analytic type and radius", () => {
    const ok = ruleFromFaceFacts([cyl("a", 3), cyl("b", 3)], "type");
    expect(ok.ok && ok.query.source.filter).toEqual({ kind: "surfaceType", type: "cylinder", radius: 3 });
    expect(ruleFromFaceFacts([cyl("a", 3), cyl("b", 4)], "type").ok).toBe(false);
    expect(ruleFromFaceFacts([planar("a", 0)], "type").ok).toBe(false);
  });
  it("describes a stored rule", () => {
    const r = ruleFromFaceFacts([cyl("a", 3)], "type");
    expect(r.ok && describeRule(r.query)).toBe("cylinder r=3");
    expect(describeRule(undefined)).toBeNull();
  });
});
