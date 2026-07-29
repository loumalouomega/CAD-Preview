import { describe, it, expect } from "vitest";
import { diffSolids, type SolidSignature } from "./modelDiff";

function sig(id: string, centre: [number, number, number], volume: number, diagonal = 10): SolidSignature {
  return { id, centre, diagonal, volume };
}

describe("diffSolids", () => {
  it("matches identical models exactly", () => {
    const a = [sig("solid-0", [0, 0, 0], 100), sig("solid-1", [50, 0, 0], 200)];
    const b = [sig("solid-0", [0, 0, 0], 100), sig("solid-1", [50, 0, 0], 200)];
    const diff = diffSolids(a, b, 1);
    expect(diff.matched).toHaveLength(2);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.matched[0].centreDistance).toBeCloseTo(0);
    expect(diff.matched[0].volumeDeltaPct).toBeCloseTo(0);
  });

  it("matches a solid moved within tolerance and reports the displacement", () => {
    const a = [sig("solid-0", [0, 0, 0], 100)];
    const b = [sig("solid-0", [2, 0, 0], 100)];
    const diff = diffSolids(a, b, 5);
    expect(diff.matched).toHaveLength(1);
    expect(diff.matched[0].centreDistance).toBeCloseTo(2);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("reports added and removed solids beyond tolerance", () => {
    const a = [sig("solid-0", [0, 0, 0], 100)];
    const b = [sig("solid-0", [1000, 0, 0], 100)];
    const diff = diffSolids(a, b, 5);
    expect(diff.matched).toHaveLength(0);
    expect(diff.removed).toEqual(a);
    expect(diff.added).toEqual(b);
  });

  it("reports a genuinely new solid as added and a genuinely deleted one as removed", () => {
    const a = [sig("solid-0", [0, 0, 0], 100), sig("solid-1", [50, 0, 0], 200)];
    const b = [sig("solid-0", [0, 0, 0], 100), sig("solid-2", [500, 500, 500], 300)];
    const diff = diffSolids(a, b, 1);
    expect(diff.matched).toHaveLength(1);
    expect(diff.matched[0].a.id).toBe("solid-0");
    expect(diff.removed.map((s) => s.id)).toEqual(["solid-1"]);
    expect(diff.added.map((s) => s.id)).toEqual(["solid-2"]);
  });

  it("breaks ties between equally-close candidates by volume similarity", () => {
    // Two `a` solids sit at the same distance from one `b` solid; the closer
    // (by volume) `a` solid should win the match, leaving the other unmatched.
    const a = [sig("solid-near-vol", [1, 0, 0], 100), sig("solid-far-vol", [1, 0, 0], 900)];
    const b = [sig("solid-0", [0, 0, 0], 105)];
    const diff = diffSolids(a, b, 5);
    expect(diff.matched).toHaveLength(1);
    expect(diff.matched[0].a.id).toBe("solid-near-vol");
    expect(diff.removed.map((s) => s.id)).toEqual(["solid-far-vol"]);
  });

  it("never double-matches a solid on either side", () => {
    const a = [sig("a0", [0, 0, 0], 100), sig("a1", [0.1, 0, 0], 100)];
    const b = [sig("b0", [0, 0, 0], 100)];
    const diff = diffSolids(a, b, 5);
    expect(diff.matched).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  it("handles empty inputs", () => {
    expect(diffSolids([], [], 1)).toEqual({ added: [], removed: [], matched: [] });
    const a = [sig("solid-0", [0, 0, 0], 100)];
    expect(diffSolids(a, [], 1)).toEqual({ added: [], removed: a, matched: [] });
    expect(diffSolids([], a, 1)).toEqual({ added: a, removed: [], matched: [] });
  });
});
