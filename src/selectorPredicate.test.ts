import { describe, expect, it } from "vitest";
import {
  SELECTOR_DIRECTION_TOLERANCE_DEG,
  applyFaceFilter,
  filterFaces,
  matchesFacePredicate,
  rankFaces,
  validateFacePredicate,
  validateSelectorRank,
  type FilterableFace,
} from "./selectorPredicate";

const plane = (id: string, area: number | null, normal: [number, number, number] | null = [0, 0, 1]): FilterableFace => ({
  id,
  area,
  surfaceType: normal ? "plane" : "cylinder",
  normal,
});
const curved = (id: string, area: number): FilterableFace => ({ id, area, surfaceType: "cylinder", normal: null });

describe("selectorPredicate: validateFacePredicate", () => {
  it("accepts every leaf shape and round-trips through JSON", () => {
    const leaves = [
      { kind: "planar" },
      { kind: "surfaceType", type: "cylinder" },
      { kind: "normal", dir: [0, 0, 1] },
      { kind: "normal", dir: [1, 0, 0], toleranceDeg: 10 },
      { kind: "areaGte", value: 5 },
      { kind: "areaLte", value: 5 },
    ];
    for (const leaf of leaves) {
      const parsed = validateFacePredicate(JSON.parse(JSON.stringify(leaf)));
      expect(parsed, JSON.stringify(leaf)).toEqual(leaf);
    }
  });

  it("rejects malformed leaves without throwing", () => {
    expect(validateFacePredicate(null)).toBeNull();
    expect(validateFacePredicate({ kind: "alongX" })).toBeNull(); // edge leaf: no host field
    expect(validateFacePredicate({ kind: "surfaceType", type: "hyperbolic" })).toBeNull();
    expect(validateFacePredicate({ kind: "normal", dir: [0, 0, 0] })).toBeNull();
    expect(validateFacePredicate({ kind: "normal", dir: [0, 0, "x"] })).toBeNull();
    expect(validateFacePredicate({ kind: "normal", dir: [0, 0, 1], toleranceDeg: 0 })).toBeNull();
    expect(validateFacePredicate({ kind: "normal", dir: [0, 0, 1], toleranceDeg: 91 })).toBeNull();
    expect(validateFacePredicate({ kind: "areaGte", value: NaN })).toBeNull();
    expect(validateFacePredicate({ kind: "areaGte", value: Infinity })).toBeNull();
    expect(validateFacePredicate({ kind: "areaLte" })).toBeNull();
  });
});

describe("selectorPredicate: validateSelectorRank", () => {
  it("accepts a well-formed rank", () => {
    expect(validateSelectorRank({ by: "area", order: "max", n: 1 })).toEqual({ by: "area", order: "max", n: 1 });
  });

  it("rejects malformed ranks", () => {
    expect(validateSelectorRank({ by: "length", order: "max", n: 1 })).toBeNull(); // edge-side: out of scope
    expect(validateSelectorRank({ by: "area", order: "up", n: 1 })).toBeNull();
    expect(validateSelectorRank({ by: "area", order: "max", n: 0 })).toBeNull();
    expect(validateSelectorRank({ by: "area", order: "max", n: 1.5 })).toBeNull();
    expect(validateSelectorRank({ by: "area", order: "max", n: 1001 })).toBeNull();
    expect(validateSelectorRank(null)).toBeNull();
  });
});

describe("selectorPredicate: matchesFacePredicate", () => {
  it("planar matches only analytic planes", () => {
    expect(matchesFacePredicate(plane("face-0", 10), { kind: "planar" })).toBe(true);
    expect(matchesFacePredicate(curved("face-1", 10), { kind: "planar" })).toBe(false);
  });

  it("normal matches within tolerance and misses outside it", () => {
    expect(matchesFacePredicate(plane("face-0", 10, [0, 0, 1]), { kind: "normal", dir: [0, 0, 1] })).toBe(true);
    // Tilted 10°: misses at the default 5°, hits at 11°.
    expect(matchesFacePredicate(plane("face-0", 10, [0, Math.sin(0.1745), Math.cos(0.1745)]), { kind: "normal", dir: [0, 0, 1] })).toBe(false);
    expect(
      matchesFacePredicate(plane("face-0", 10, [0, Math.sin(0.1745), Math.cos(0.1745)]), {
        kind: "normal",
        dir: [0, 0, 1],
        toleranceDeg: 11,
      })
    ).toBe(true);
  });

  it("normal on a curved face is no-match, never a fabrication", () => {
    expect(matchesFacePredicate(curved("face-1", 10), { kind: "normal", dir: [0, 0, 1] })).toBe(false);
  });

  it("area thresholds apply the ±1e-9 epsilon convention", () => {
    expect(matchesFacePredicate(plane("face-0", 5), { kind: "areaGte", value: 5 })).toBe(true);
    expect(matchesFacePredicate(plane("face-0", 5 - 5e-10), { kind: "areaGte", value: 5 })).toBe(true);
    expect(matchesFacePredicate(plane("face-0", 4), { kind: "areaGte", value: 5 })).toBe(false);
    expect(matchesFacePredicate(plane("face-0", null), { kind: "areaGte", value: 0 })).toBe(false);
    expect(matchesFacePredicate(plane("face-0", 5), { kind: "areaLte", value: 5 })).toBe(true);
  });

  it("surfaceType matches exactly", () => {
    expect(matchesFacePredicate(curved("face-1", 10), { kind: "surfaceType", type: "cylinder" })).toBe(true);
    expect(matchesFacePredicate(plane("face-0", 10), { kind: "surfaceType", type: "cylinder" })).toBe(false);
  });

  it("default tolerance equals the shared registry constant", () => {
    expect(SELECTOR_DIRECTION_TOLERANCE_DEG).toBe(5);
  });
});

describe("selectorPredicate: filterFaces + rankFaces", () => {
  const faces = [plane("face-0", 100), plane("face-1", 25), curved("face-2", 50)];

  it("filterFaces preserves input order", () => {
    expect(filterFaces(faces, { kind: "areaGte", value: 20 }).map((f) => f.id)).toEqual(["face-0", "face-1", "face-2"]);
  });

  it("applyFaceFilter intersects a conjunction (AND semantics)", () => {
    expect(applyFaceFilter(faces, [{ kind: "planar" }, { kind: "areaGte", value: 20 }]).map((f) => f.id)).toEqual([
      "face-0",
      "face-1",
    ]);
    expect(applyFaceFilter(faces, [{ kind: "planar" }, { kind: "areaGte", value: 1e12 }])).toEqual([]);
    expect(applyFaceFilter(faces, { kind: "planar" }).map((f) => f.id)).toEqual(["face-0", "face-1"]);
  });

  it("rankFaces picks largest/smallest with deterministic tie-break", () => {
    expect(rankFaces(faces, { by: "area", order: "max", n: 1 }).map((f) => f.id)).toEqual(["face-0"]);
    expect(rankFaces(faces, { by: "area", order: "min", n: 2 }).map((f) => f.id)).toEqual(["face-1", "face-2"]);
    expect(rankFaces(faces, { by: "area", order: "max", n: 10 }).map((f) => f.id)).toEqual(["face-0", "face-2", "face-1"]);
    const tied = [plane("face-5", 10), plane("face-3", 10)];
    expect(rankFaces(tied, { by: "area", order: "max", n: 2 }).map((f) => f.id)).toEqual(["face-3", "face-5"]);
  });

  it("null areas sort last in either order", () => {
    const withNull = [plane("face-0", null), plane("face-1", 25)];
    expect(rankFaces(withNull, { by: "area", order: "max", n: 2 }).map((f) => f.id)).toEqual(["face-1", "face-0"]);
    expect(rankFaces(withNull, { by: "area", order: "min", n: 2 }).map((f) => f.id)).toEqual(["face-1", "face-0"]);
  });
});
