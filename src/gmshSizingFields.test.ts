import { describe, it, expect } from "vitest";
import { addConstantField, addDistanceThresholdField, setBackgroundMin } from "./gmshSizingFields";

/** A recording fake `mesh.field.*`/`getBoundary` surface — records every
 * call so a test can assert the exact sequence of option names/values
 * without a real gmsh/WASM instance. `add()` returns sequential tags
 * starting at 1, mirroring Gmsh's own auto-tag behavior. */
function fakeGmsh(opts: { boundaryOf?: (dimTagsIn: number[]) => number[] } = {}): {
  gmsh: unknown;
  calls: string[];
  fields: Map<number, { type: string; numbers: Record<string, number>; lists: Record<string, number[]> }>;
} {
  const calls: string[] = [];
  const fields = new Map<number, { type: string; numbers: Record<string, number>; lists: Record<string, number[]> }>();
  let nextTag = 1;
  const gmsh = {
    model: {
      getBoundary: (dimTagsIn: number[]) => {
        calls.push(`getBoundary(${JSON.stringify(dimTagsIn)})`);
        return { outDimTags: opts.boundaryOf ? opts.boundaryOf(dimTagsIn) : [] };
      },
      mesh: {
        field: {
          add: (type: string) => {
            const tag = nextTag++;
            fields.set(tag, { type, numbers: {}, lists: {} });
            calls.push(`add(${type}) -> ${tag}`);
            return tag;
          },
          setNumber: (tag: number, option: string, value: number) => {
            fields.get(tag)!.numbers[option] = value;
            calls.push(`setNumber(${tag}, ${option}, ${value})`);
          },
          setNumbers: (tag: number, option: string, values: number[]) => {
            fields.get(tag)!.lists[option] = values;
            calls.push(`setNumbers(${tag}, ${option}, ${JSON.stringify(values)})`);
          },
          setAsBackgroundMesh: (tag: number) => {
            calls.push(`setAsBackgroundMesh(${tag})`);
          },
        },
      },
    },
  };
  return { gmsh, calls, fields };
}

const noTags = { volTags: [], surfTags: [], curveTags: [], pointTags: [] };

describe("addConstantField", () => {
  it("returns null when no tags are given at all", () => {
    const { gmsh } = fakeGmsh();
    expect(addConstantField(gmsh, noTags, 0.5)).toBeNull();
  });

  it("sets VIn plus each non-empty *List, matching the original gmshPartsMap.ts behavior", () => {
    const { gmsh, fields } = fakeGmsh();
    const tag = addConstantField(gmsh, { volTags: [3], surfTags: [1, 2], curveTags: [], pointTags: [] }, 0.5);
    expect(tag).not.toBeNull();
    const f = fields.get(tag!)!;
    expect(f.type).toBe("Constant");
    expect(f.lists.VolumesList).toEqual([3]);
    expect(f.lists.SurfacesList).toEqual([1, 2]);
    expect(f.lists.CurvesList).toBeUndefined();
    expect(f.lists.PointsList).toBeUndefined();
    expect(f.numbers.VIn).toBe(0.5);
  });

  it("never sets VOut, leaving Gmsh's own unbounded default", () => {
    const { gmsh, fields } = fakeGmsh();
    const tag = addConstantField(gmsh, { ...noTags, pointTags: [7] }, 1);
    expect(fields.get(tag!)!.numbers.VOut).toBeUndefined();
  });
});

describe("addDistanceThresholdField", () => {
  const grading = { sizeAtWall: 0.15, sizeFar: 1, distNear: 0.3, distFar: 1.5 };

  it("returns null when there is nothing to measure distance from", () => {
    const { gmsh } = fakeGmsh();
    expect(addDistanceThresholdField(gmsh, noTags, grading)).toBeNull();
  });

  it("builds a Distance field over surfaces, then a Threshold field reading it", () => {
    const { gmsh, fields, calls } = fakeGmsh();
    const tag = addDistanceThresholdField(gmsh, { ...noTags, surfTags: [4] }, grading);
    expect(tag).not.toBeNull();

    // Distance is field 1, Threshold is field 2 (creation order).
    const dist = fields.get(1)!;
    expect(dist.type).toBe("Distance");
    expect(dist.lists.SurfacesList).toEqual([4]);
    expect(dist.numbers.Sampling).toBe(20);

    const thresh = fields.get(2)!;
    expect(thresh.type).toBe("Threshold");
    expect(thresh.numbers.InField).toBe(1);
    expect(thresh.numbers.SizeMin).toBe(0.15);
    expect(thresh.numbers.SizeMax).toBe(1);
    expect(thresh.numbers.DistMin).toBe(0.3);
    expect(thresh.numbers.DistMax).toBe(1.5);
    expect(tag).toBe(2); // the returned tag is the Threshold field's

    // getBoundary must never be called when there are no volume tags at all.
    expect(calls.some((c) => c.startsWith("getBoundary"))).toBe(false);
  });

  it("converts volume tags to their boundary surfaces via getBoundary, since Distance cannot target a volume", () => {
    const { gmsh, fields } = fakeGmsh({
      boundaryOf: () => [2, 1, 2, -2, 2, 3], // signed face tags, as gmsh returns
    });
    addDistanceThresholdField(gmsh, { ...noTags, volTags: [10] }, grading);
    const dist = fields.get(1)!;
    // Sign discarded (SurfacesList tags are unsigned) and deduplicated.
    expect(dist.lists.SurfacesList).toEqual([1, 2, 3]);
  });

  it("merges resolved surface tags with a volume's own boundary faces, deduplicated", () => {
    const { gmsh, fields } = fakeGmsh({ boundaryOf: () => [2, 4, 2, 5] });
    addDistanceThresholdField(gmsh, { ...noTags, surfTags: [4], volTags: [10] }, grading);
    const dist = fields.get(1)!;
    expect([...dist.lists.SurfacesList].sort()).toEqual([4, 5]);
  });

  it("includes curves and points alongside surfaces", () => {
    const { gmsh, fields } = fakeGmsh();
    addDistanceThresholdField(gmsh, { volTags: [], surfTags: [1], curveTags: [2], pointTags: [3] }, grading);
    const dist = fields.get(1)!;
    expect(dist.lists.SurfacesList).toEqual([1]);
    expect(dist.lists.CurvesList).toEqual([2]);
    expect(dist.lists.PointsList).toEqual([3]);
  });
});

describe("setBackgroundMin", () => {
  it("is a no-op when there are no field tags at all", () => {
    const { gmsh, calls } = fakeGmsh();
    setBackgroundMin(gmsh, []);
    expect(calls).toEqual([]);
  });

  it("combines every field tag into one Min field and sets it as the background mesh", () => {
    const { gmsh, fields, calls } = fakeGmsh();
    setBackgroundMin(gmsh, [5, 6, 7]);
    const minTag = [...fields.keys()][0];
    expect(fields.get(minTag)!.type).toBe("Min");
    expect(fields.get(minTag)!.lists.FieldsList).toEqual([5, 6, 7]);
    expect(calls.some((c) => c === `setAsBackgroundMesh(${minTag})`)).toBe(true);
    // Exactly one Min field, and setAsBackgroundMesh called exactly once —
    // a second call would silently REPLACE, not compose with, the first.
    expect(calls.filter((c) => c.startsWith("setAsBackgroundMesh")).length).toBe(1);
  });
});

describe("Constant + Distance/Threshold composing on the same part", () => {
  it("both fields land in the FieldsList a caller passes to setBackgroundMin", () => {
    const { gmsh, fields } = fakeGmsh();
    const constTag = addConstantField(gmsh, { ...noTags, surfTags: [1] }, 0.2)!;
    const threshTag = addDistanceThresholdField(gmsh, { ...noTags, surfTags: [1] }, {
      sizeAtWall: 0.15,
      sizeFar: 1,
      distNear: 0.3,
      distFar: 1.5,
    })!;
    setBackgroundMin(gmsh, [constTag, threshTag]);
    const minTag = [...fields.entries()].find(([, f]) => f.type === "Min")![0];
    expect(fields.get(minTag)!.lists.FieldsList).toEqual([constTag, threshTag]);
  });
});
