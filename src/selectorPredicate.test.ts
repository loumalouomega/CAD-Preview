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

import { validateFacePredicate as vfp, matchesFacePredicate as mfp, applyFaceFilter as aff } from "./selectorPredicate";

describe("rule leaves", () => {
  const face = (over: Partial<FilterableFace>): FilterableFace => ({
    id: "face-0", area: 1, surfaceType: "plane", normal: [1, 0, 0],
    bbox: { min: [-50, -5, -5], max: [-50, 5, 5] }, planeOrigin: [-50, 0, 0], radius: null, ...over,
  });
  const ctx = { diagonal: 100 }; // default tol = 0.1

  it("plane leaf matches coplanar faces in either orientation, rejects offset or tilted ones", () => {
    const leaf = { kind: "plane" as const, point: [-50, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number] };
    expect(mfp(face({}), leaf, ctx)).toBe(true);
    expect(mfp(face({ normal: [-1, 0, 0] }), leaf, ctx)).toBe(true);
    expect(mfp(face({ planeOrigin: [50, 0, 0] }), leaf, ctx)).toBe(false);
    expect(mfp(face({ planeOrigin: [-49.95, 3, 9] }), leaf, ctx)).toBe(true); // within 1e-3 x diagonal, in-plane offsets irrelevant
    expect(mfp(face({ planeOrigin: [-49.5, 0, 0] }), leaf, ctx)).toBe(false);
    expect(mfp(face({ normal: [0, 1, 0] }), leaf, ctx)).toBe(false);
    expect(mfp(face({ surfaceType: "cylinder", normal: null }), leaf, ctx)).toBe(false);
  });

  it("box leaf: inside needs the whole face bbox in, intersects needs any overlap, null limits are open", () => {
    const inside = { kind: "box" as const, mode: "inside" as const, min: [-60, null, null] as [number, null, null], max: [-40, null, null] as [number, null, null] };
    expect(mfp(face({}), inside, ctx)).toBe(true);
    expect(mfp(face({ bbox: { min: [-70, 0, 0], max: [-50, 1, 1] } }), inside, ctx)).toBe(false);
    const hit = { ...inside, mode: "intersects" as const };
    expect(mfp(face({ bbox: { min: [-70, 0, 0], max: [-50, 1, 1] } }), hit, ctx)).toBe(true);
    expect(mfp(face({ bbox: { min: [-90, 0, 0], max: [-70, 1, 1] } }), hit, ctx)).toBe(false);
    expect(mfp(face({ bbox: null }), inside, ctx)).toBe(false);
  });

  it("surfaceType radius leaf matches by radius within tolerance", () => {
    const leaf = { kind: "surfaceType" as const, type: "cylinder" as const, radius: 5 };
    expect(mfp(face({ surfaceType: "cylinder", radius: 5.05 }), leaf, ctx)).toBe(true);
    expect(mfp(face({ surfaceType: "cylinder", radius: 6 }), leaf, ctx)).toBe(false);
    expect(mfp(face({ surfaceType: "cylinder", radius: null }), leaf, ctx)).toBe(false);
    expect(mfp(face({ surfaceType: "sphere", radius: 5 }), leaf, ctx)).toBe(false);
  });

  it("validation drops malformed rule leaves and keeps well-formed ones", () => {
    expect(vfp({ kind: "plane", point: [0, 0, 0], normal: [0, 0, 0] })).toBeNull();
    expect(vfp({ kind: "plane", point: [0, 0], normal: [1, 0, 0] })).toBeNull();
    expect(vfp({ kind: "plane", point: [0, 0, 0], normal: [1, 0, 0], tol: -1 })).toBeNull();
    expect(vfp({ kind: "box", mode: "inside", min: [null, null, null], max: [null, null, null] })).toBeNull();
    expect(vfp({ kind: "box", mode: "inside", min: [5, null, null], max: [1, null, null] })).toBeNull();
    expect(vfp({ kind: "box", mode: "near", min: [0, 0, 0], max: [1, 1, 1] })).toBeNull();
    expect(vfp({ kind: "surfaceType", type: "cylinder", radius: -2 })).toBeNull();
    expect(vfp({ kind: "box", mode: "inside", min: [0, null, null], max: [1, null, null] })).toEqual({
      kind: "box", mode: "inside", min: [0, null, null], max: [1, null, null],
    });
    expect(vfp({ kind: "surfaceType", type: "plane" })).toEqual({ kind: "surfaceType", type: "plane" });
  });

  it("composes with existing leaves in an AND list", () => {
    const faces = [face({ id: "face-1" }), face({ id: "face-2", area: 0.1 })];
    const out = aff(faces, [{ kind: "plane", point: [-50, 0, 0], normal: [1, 0, 0] }, { kind: "areaGte", value: 0.5 }], ctx);
    expect(out.map((f) => f.id)).toEqual(["face-1"]);
  });
});
