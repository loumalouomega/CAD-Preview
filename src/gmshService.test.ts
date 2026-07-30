import { describe, it, expect } from "vitest";
import { buildIndices } from "./gmshService";
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
