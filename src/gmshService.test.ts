import { describe, it, expect } from "vitest";
import {
  buildIndices,
  computeQualityAndWorstElements,
  WORST_ELEMENT_QUALITY_THRESHOLD,
  MAX_WORST_ELEMENTS,
} from "./gmshService";
import type { PartGroupInfo, PartGroupMaps } from "./gmshPartsMap";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GmshElementsResult = { elementTypes: number[]; nodeTags: number[][] };

/** A minimal fake GmshApi covering only what `buildIndices` calls:
 * `model.getEntities(dim)` and `model.mesh.getElements(dim, tag?)`. Volumes
 * and surfaces are described independently so a test can place a hex (or
 * any other 3D cell) and its boundary's matching 2D surface mesh without a
 * real gmsh/WASM instance — see `gmshService.ts`'s own doc comment on why
 * this is the one function here exported for a fake-object unit test. */
function fakeGmsh(opts: {
  volumes: Record<number, GmshElementsResult>;
  surfaces?: Record<number, GmshElementsResult>;
}): unknown {
  const volumeTags = Object.keys(opts.volumes).map(Number);
  return {
    model: {
      getEntities: (dim: number) => {
        if (dim === 3) return { dimTags: volumeTags.flatMap((t) => [3, t]) };
        return { dimTags: [] };
      },
      mesh: {
        getElements: (dim: number, tag?: number): GmshElementsResult => {
          if (dim === 3) {
            if (tag === undefined) {
              // whole-model call: concatenate every volume's elements
              const merged: GmshElementsResult = { elementTypes: [], nodeTags: [] };
              for (const t of volumeTags) {
                merged.elementTypes.push(...opts.volumes[t].elementTypes);
                merged.nodeTags.push(...opts.volumes[t].nodeTags);
              }
              return merged;
            }
            return opts.volumes[tag] ?? { elementTypes: [], nodeTags: [] };
          }
          if (dim === 2 && tag !== undefined) {
            return opts.surfaces?.[tag] ?? { elementTypes: [], nodeTags: [] };
          }
          return { elementTypes: [], nodeTags: [] };
        },
      },
    },
  };
}

/** Identity tag->index map covering 0..maxTag (compacted positions aren't
 * under test here, only the grouping/classification logic). */
const identityMap = (maxTag: number): Map<number, number> => {
  const m = new Map<number, number>();
  for (let i = 0; i <= maxTag; i++) m.set(i, i);
  return m;
};

// A unit hex's standard corner numbering: bottom 0,1,2,3; top 4,5,6,7 (same
// fixture shape gmshElementTypes.test.ts's boundaryTriangles tests use).
const hex = (base: number): GmshElementsResult => ({
  elementTypes: [5],
  nodeTags: [[base, base + 1, base + 2, base + 3, base + 4, base + 5, base + 6, base + 7]],
});
const topFaceOf = (base: number): GmshElementsResult => ({
  elementTypes: [3],
  nodeTags: [[base + 4, base + 5, base + 6, base + 7]],
});

const emptyMaps = (): PartGroupMaps => ({
  volumeTagToPart: new Map(),
  surfaceTagToPart: new Map(),
  curveTagToPart: new Map(),
  pointTagToPart: new Map(),
});

describe("buildIndices (dimension 3) — part-scoped overlay grouping", () => {
  it("no parts: single ungrouped range covering the whole boundary", () => {
    const gmsh = fakeGmsh({ volumes: { 100: hex(0) } });
    const { indices, elementGroups } = buildIndices(gmsh, 3, identityMap(7), null);
    expect(indices.length).toBe(6 * 2 * 3); // 6 quad faces * 2 tris * 3 indices
    expect(elementGroups).toEqual([{ name: null, color: null, indexStart: 0, indexCount: indices.length }]);
  });

  it("volume-scoped part: unchanged pre-existing behavior", () => {
    const gmsh = fakeGmsh({ volumes: { 100: hex(0) } });
    const pv: PartGroupInfo = { name: "PV", color: "#ff0000" };
    const maps = emptyMaps();
    maps.volumeTagToPart.set(100, pv);
    const { indices, elementGroups } = buildIndices(gmsh, 3, identityMap(7), maps);
    expect(elementGroups).toEqual([{ name: "PV", color: "#ff0000", indexStart: 0, indexCount: indices.length }]);
  });

  it("surface-scoped part on an otherwise-ungrouped volume gets its own overlay range (the roadmap gap)", () => {
    const gmsh = fakeGmsh({ volumes: { 100: hex(0) }, surfaces: { 10: topFaceOf(0) } });
    const ps: PartGroupInfo = { name: "PS", color: "#00ff00" };
    const maps = emptyMaps();
    maps.surfaceTagToPart.set(10, ps);
    const { indices, elementGroups } = buildIndices(gmsh, 3, identityMap(7), maps);

    expect(elementGroups).toHaveLength(2);
    const psGroup = elementGroups.find((g) => g.name === "PS")!;
    const ungrouped = elementGroups.find((g) => g.name === null)!;
    expect(psGroup.indexCount).toBe(2 * 3); // the one quad face -> 2 triangles
    expect(ungrouped.indexCount).toBe(5 * 2 * 3); // the other 5 faces
    expect(psGroup.indexCount + ungrouped.indexCount).toBe(indices.length);
  });

  it("a surface-scoped part wins over its own volume's volume-scoped part (more specific)", () => {
    const gmsh = fakeGmsh({ volumes: { 100: hex(0) }, surfaces: { 10: topFaceOf(0) } });
    const pv: PartGroupInfo = { name: "PV", color: "#ff0000" };
    const ps: PartGroupInfo = { name: "PS", color: "#00ff00" };
    const maps = emptyMaps();
    maps.volumeTagToPart.set(100, pv);
    maps.surfaceTagToPart.set(10, ps);
    const { indices, elementGroups } = buildIndices(gmsh, 3, identityMap(7), maps);

    expect(elementGroups).toHaveLength(2); // no trailing ungrouped range: every face claimed
    expect(elementGroups.map((g) => g.name)).toEqual(["PV", "PS"]); // volume-part precedence order
    const pvGroup = elementGroups.find((g) => g.name === "PV")!;
    const psGroup = elementGroups.find((g) => g.name === "PS")!;
    expect(pvGroup.indexCount).toBe(5 * 2 * 3);
    expect(psGroup.indexCount).toBe(2 * 3);
    expect(pvGroup.indexCount + psGroup.indexCount).toBe(indices.length);
  });

  it("two volumes: a surface part on the ungrouped one doesn't bleed into the grouped one", () => {
    const gmsh = fakeGmsh({
      volumes: { 100: hex(0), 200: hex(1000) },
      surfaces: { 10: topFaceOf(0) },
    });
    const pv: PartGroupInfo = { name: "PV", color: "#ff0000" };
    const ps: PartGroupInfo = { name: "PS", color: "#00ff00" };
    const maps = emptyMaps();
    maps.volumeTagToPart.set(200, pv);
    maps.surfaceTagToPart.set(10, ps);
    const { indices, elementGroups } = buildIndices(gmsh, 3, identityMap(1007), maps);

    expect(elementGroups).toHaveLength(3);
    const names = elementGroups.map((g) => g.name);
    expect(names).toEqual(["PV", "PS", null]);
    const pvGroup = elementGroups.find((g) => g.name === "PV")!;
    const psGroup = elementGroups.find((g) => g.name === "PS")!;
    const ungrouped = elementGroups.find((g) => g.name === null)!;
    expect(pvGroup.indexCount).toBe(6 * 2 * 3); // whole of volume 200
    expect(psGroup.indexCount).toBe(2 * 3); // the one claimed face of volume 100
    expect(ungrouped.indexCount).toBe(5 * 2 * 3); // the rest of volume 100
    expect(pvGroup.indexCount + psGroup.indexCount + ungrouped.indexCount).toBe(indices.length);
  });
});

/** A single element definition for `fakeQualityGmsh` — a plain tet4 (type 4)
 * with 4 node tags and its `minSICN`-style quality value. */
interface FakeElement {
  nodeTags: [number, number, number, number];
  quality: number;
}

/** A minimal fake GmshApi covering only what `computeQualityAndWorstElements`
 * calls: `model.mesh.getElements(dim, -1)` (all tet4 elements, tags assigned
 * sequentially) and `model.mesh.getElementQualities(tags, "minSICN")`. */
function fakeQualityGmsh(elements: FakeElement[]): unknown {
  const elementTags: number[] = [];
  const nodeTags: number[] = [];
  const tagToQuality = new Map<number, number>();
  elements.forEach((el, i) => {
    const tag = i + 1;
    elementTags.push(tag);
    nodeTags.push(...el.nodeTags);
    tagToQuality.set(tag, el.quality);
  });
  return {
    model: {
      mesh: {
        getElements: (_dim: number, tag?: number) => {
          if (tag !== -1) return { elementTypes: [], elementTags: [], nodeTags: [] };
          return elements.length === 0
            ? { elementTypes: [], elementTags: [], nodeTags: [] }
            : { elementTypes: [4], elementTags: [elementTags], nodeTags: [nodeTags] };
        },
        getElementQualities: (tags: number[]) => ({
          elementsQuality: tags.map((t) => tagToQuality.get(t)!),
        }),
      },
    },
  };
}

/** Identity `tagToIndex` that never actually allocates a lookup table — the
 * cap test below uses node tags up into the millions to keep "distinctive"
 * elements unambiguously identifiable, which a real `Map` covering every tag
 * up to that value would make needlessly slow to build. */
const identityLookup = { get: (tag: number) => tag } as unknown as Map<number, number>;

describe("computeQualityAndWorstElements", () => {
  it("no elements below threshold: quality is computed, worstElements is absent", () => {
    const gmsh = fakeQualityGmsh([{ nodeTags: [0, 1, 2, 3], quality: 0.9 }]);
    const { quality, worstElements } = computeQualityAndWorstElements(gmsh, 3, identityLookup);
    expect(quality).toBeDefined();
    expect(quality!.min).toBeCloseTo(0.9);
    expect(worstElements).toBeUndefined();
  });

  it("dimension !== 3 never computes worstElements, even with bad elements present", () => {
    const gmsh = fakeQualityGmsh([{ nodeTags: [0, 1, 2, 3], quality: 0.01 }]);
    const { quality, worstElements } = computeQualityAndWorstElements(gmsh, 2, identityLookup);
    expect(quality).toBeDefined();
    expect(worstElements).toBeUndefined();
  });

  it("two adjacent bad tets: their shared face dedups away, only the cluster's outer surface remains", () => {
    // tetA corners 0,1,2,3 ; tetB corners 1,2,3,4 ; shared face = {1,2,3} —
    // same fixture shape as gmshElementTypes.test.ts's boundaryTriangles test.
    const gmsh = fakeQualityGmsh([
      { nodeTags: [0, 1, 2, 3], quality: 0.05 },
      { nodeTags: [1, 2, 3, 4], quality: 0.02 },
    ]);
    const { worstElements } = computeQualityAndWorstElements(gmsh, 3, identityLookup);
    expect(worstElements).toBeDefined();
    expect(worstElements!.shownCount).toBe(2);
    expect(worstElements!.belowThresholdCount).toBe(2);
    expect(worstElements!.threshold).toBe(WORST_ELEMENT_QUALITY_THRESHOLD);
    // 2 tets * 4 faces = 8, shared {1,2,3} appears twice and cancels -> 6 kept faces * 3 = 18 indices.
    expect(worstElements!.indices.length).toBe(18);
    for (let i = 0; i < worstElements!.indices.length; i += 3) {
      const tri = [worstElements!.indices[i], worstElements!.indices[i + 1], worstElements!.indices[i + 2]];
      expect(tri.sort().join(",")).not.toBe("1,2,3"); // the interior seam must not appear
    }
  });

  it("a good neighbor sharing a face with one bad tet does NOT cancel that face", () => {
    const gmsh = fakeQualityGmsh([
      { nodeTags: [0, 1, 2, 3], quality: 0.05 }, // bad
      { nodeTags: [1, 2, 3, 4], quality: 0.9 }, // good — not in the "worst" subset at all
    ]);
    const { worstElements } = computeQualityAndWorstElements(gmsh, 3, identityLookup);
    expect(worstElements!.shownCount).toBe(1);
    // The lone bad tet's full, undeduped 4-face boundary (the good neighbor
    // never entered the subset, so there's nothing to cancel {1,2,3} against).
    expect(worstElements!.indices.length).toBe(4 * 3);
  });

  it("caps at MAX_WORST_ELEMENTS, keeping the lowest-quality elements first", () => {
    const regular: FakeElement[] = Array.from({ length: MAX_WORST_ELEMENTS }, (_, i) => ({
      // Strictly below threshold, ranging worst (-0.5) to least-bad (~-0.3001)
      // among the "regular" pool — all isolated (unique node tags -> no dedup).
      nodeTags: [4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 3],
      quality: -0.5 + i * 0.0001,
    }));
    // Distinctly identifiable via node-tag ranges far outside the regular pool.
    const veryWorst: FakeElement = { nodeTags: [9_000_000, 9_000_001, 9_000_002, 9_000_003], quality: -1 };
    const leastBad: FakeElement = { nodeTags: [8_000_000, 8_000_001, 8_000_002, 8_000_003], quality: -0.29 };

    const gmsh = fakeQualityGmsh([...regular, veryWorst, leastBad]);
    const { worstElements } = computeQualityAndWorstElements(gmsh, 3, identityLookup);

    expect(worstElements).toBeDefined();
    expect(worstElements!.belowThresholdCount).toBe(MAX_WORST_ELEMENTS + 2);
    expect(worstElements!.shownCount).toBe(MAX_WORST_ELEMENTS); // capped, not silently unlimited

    const indexSet = new Set(worstElements!.indices);
    expect(indexSet.has(9_000_000)).toBe(true); // the single worst element must survive the cap
    expect(indexSet.has(8_000_000)).toBe(false); // the least-bad-of-the-bad element must be the one dropped
  });
});
