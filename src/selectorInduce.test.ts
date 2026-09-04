import { describe, expect, it } from "vitest";
import { executeInducedLayer, induceSelector } from "./selectorInduce";
import type { FacePredicate, FilterableFace, SelectorRank } from "./selectorPredicate";
import type { OpRole } from "./opBuckets";

const F = (id: string, area: number, surfaceType: "plane" | "cylinder" = "plane", normal: [number, number, number] | null = [0, 0, 1]): FilterableFace => ({
  id,
  area,
  surfaceType,
  normal,
});

const box = (): FilterableFace[] => [
  // 10×20×30 box body: ±X faces area 600, ±Y area 300, ±Z area 200.
  F("face-0", 600, "plane", [1, 0, 0]),
  F("face-1", 600, "plane", [-1, 0, 0]),
  F("face-2", 300, "plane", [0, 1, 0]),
  F("face-3", 300, "plane", [0, -1, 0]),
  F("face-4", 200, "plane", [0, 0, 1]),
  F("face-5", 200, "plane", [0, 0, -1]),
];

const induce = (universe: FilterableFace[], targets: string[], role: OpRole = "body") =>
  induceSelector({ op: 0, role, universe, targets });

describe("selectorInduce: degenerate input", () => {
  it("returns null for empty targets, empty universe, or targets outside the universe", () => {
    expect(induce(box(), [])).toBeNull();
    expect(induce([], ["face-0"])).toBeNull();
    expect(induce(box(), ["face-9"])).toBeNull();
    expect(induce(box(), ["face-0", "face-9"])).toBeNull();
  });

  it("returns the bare bucket when the targets span the universe (nothing to induce)", () => {
    const universe = box();
    expect(induce(universe, universe.map((f) => f.id))).toEqual({ version: 1, source: { kind: "bucket", op: 0, role: "body" } });
  });
});

describe("selectorInduce: constant-free-first ordering", () => {
  it("prefers a snapped axis over rank when both resolve exactly", () => {
    // face-0 (+X, 600) is also rank-max-n1 by tie-break — the snapped +X must win.
    const q = induce(box(), ["face-0"]);
    expect(q?.source).toEqual({ kind: "bucket", op: 0, role: "body", filter: { kind: "normal", dir: [1, 0, 0] } });
  });

  it("prefers a qualitative leaf over an area literal with the same extension", () => {
    // Only planar face in a curved universe: planar AND areaGte(42) both exact — planar wins.
    const universe: FilterableFace[] = [F("face-0", 42), F("face-1", 42, "cylinder", null), F("face-2", 42, "cylinder", null)];
    const q = induce(universe, ["face-0"]);
    expect(q?.source).toEqual({ kind: "bucket", op: 0, role: "body", filter: { kind: "planar" } });
  });

  it("falls back to the exact picked normal for an off-axis face", () => {
    const off: FilterableFace = { id: "face-2", area: 5, surfaceType: "plane", normal: [0.3, 0, 0.9539] };
    const universe: FilterableFace[] = [F("face-0", 10, "plane", [0, 0, 1]), F("face-1", 5, "plane", [0, 1, 0]), off];
    // Ranks cannot isolate face-2 (min-n1 ties face-1 with the lower suffix; max-n1 hits face-0),
    // no snapped axis is within tolerance — the exact normal is the honest fallback.
    const q = induce(universe, ["face-2"]);
    expect(q?.source).toMatchObject({ kind: "bucket", op: 0, role: "body", filter: { kind: "normal" } });
    expect(q && "filter" in q.source && (q.source.filter as { dir: number[] }).dir).toEqual([0.3, 0, 0.9539]);
  });

  it("uses the axis-snapped normal where it isolates the target", () => {
    // face-4 (+Z, 200) vs face-5 (−Z, 200): snapped +Z matches face-4 alone.
    const q = induce(box(), ["face-4"]);
    expect(q?.source).toEqual({ kind: "bucket", op: 0, role: "body", filter: { kind: "normal", dir: [0, 0, 1] } });
  });

  it("uses rank where no qualitative leaf isolates the target", () => {
    // Two faces sharing one axis direction: +Z matches both, smallest-n1 picks face-4 by tie-break.
    const universe: FilterableFace[] = [F("face-4", 200, "plane", [0, 0, 1]), F("face-5", 200, "plane", [0, 0, 1])];
    const q = induce(universe, ["face-4"]);
    expect(q?.source).toEqual({ kind: "bucket", op: 0, role: "body", rank: { by: "area", order: "max", n: 1 } });
  });
});

describe("selectorInduce: pairs and honest nulls", () => {
  it("finds an exact query for a pair and re-executes to exactly the picked set", () => {
    // {face-0, face-1} (areas 10/20) among face-2 (area 20): min-area-n2 covers
    // the pair; the contract is exact re-execution, whichever form wins.
    const universe: FilterableFace[] = [
      F("face-0", 10, "plane", [1, 0, 0]),
      F("face-1", 20, "plane", [0, 1, 0]),
      F("face-2", 20, "plane", [0, 0, 1]),
    ];
    const q = induce(universe, ["face-0", "face-1"]);
    expect(q).not.toBeNull();
    const source = q!.source as { filter?: FacePredicate | FacePredicate[]; rank?: SelectorRank };
    expect(new Set(executeInducedLayer(universe, source.filter, source.rank))).toEqual(new Set(["face-0", "face-1"]));
    // Deterministic: inducing twice yields the same query.
    expect(induce(universe, ["face-0", "face-1"])).toEqual(q);
  });

  it("returns null when the set is inexpressible (no union in the language)", () => {
    // {face-1, face-2} with facts identical to face-0: every leaf matches all
    // three, and rank tie-breaks (lowest suffix first) can only ever yield
    // face-0-prefixed sets — never this one.
    const universe: FilterableFace[] = [F("face-0", 10), F("face-1", 10), F("face-2", 10)];
    expect(induce(universe, ["face-1", "face-2"])).toBeNull();
  });
});

describe("selectorInduce: executeInducedLayer", () => {
  it("applies filter-then-rank in the resolver's order", () => {
    expect(executeInducedLayer(box(), { kind: "planar" }, { by: "area", order: "max", n: 2 })).toEqual(["face-0", "face-1"]);
    expect(executeInducedLayer(box(), undefined, undefined)).toEqual(box().map((f) => f.id));
  });
});
