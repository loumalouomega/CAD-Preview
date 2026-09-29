import { describe, it, expect } from "vitest";
import { addFreeEntitiesToGmshModel, type FreeEntitySpec } from "./gmshEmbed";

/** A recording fake of the `gmsh.model.occ` surface this module uses. Records
 * every call so a test can assert the exact sequence without a real
 * gmsh/WASM instance, and hands back sequential tags starting at 1 the way
 * Gmsh's own auto-tag behaviour does. `syncCount` is asserted separately
 * because the whole design rests on it happening exactly once per batch. */
function fakeGmsh(): {
  gmsh: unknown;
  calls: string[];
  syncCount: () => number;
} {
  const calls: string[] = [];
  let nextTag = 1;
  let syncs = 0;
  const gmsh = {
    model: {
      occ: {
        addPoint: (x: number, y: number, z: number) => {
          const tag = nextTag++;
          calls.push(`addPoint(${x}, ${y}, ${z}) -> ${tag}`);
          return tag;
        },
        addLine: (a: number, b: number) => {
          const tag = nextTag++;
          calls.push(`addLine(${a}, ${b}) -> ${tag}`);
          return tag;
        },
        synchronize: () => {
          syncs++;
          calls.push("synchronize()");
        },
      },
    },
  };
  return { gmsh, calls, syncCount: () => syncs };
}

describe("addFreeEntitiesToGmshModel", () => {
  it("does nothing at all — not even a synchronize — for an empty batch", () => {
    // A document whose Parts reference only real model geometry must not pay
    // a second occ.synchronize(): the first one already happened in
    // loadGeometryAndApplyOptions, and the whole point of this module is that
    // pre-existing physical groups survive it.
    const { gmsh, calls, syncCount } = fakeGmsh();
    const { tags } = addFreeEntitiesToGmshModel(gmsh, []);
    expect(tags.size).toBe(0);
    expect(calls).toEqual([]);
    expect(syncCount()).toBe(0);
  });

  it("creates a single point and synchronizes exactly once", () => {
    const { gmsh, calls, syncCount } = fakeGmsh();
    const { tags } = addFreeEntitiesToGmshModel(gmsh, [
      { id: "point-8", kind: "point", at: [0.37, -1.13, 2.5] },
    ]);
    expect(calls).toEqual(["addPoint(0.37, -1.13, 2.5) -> 1", "synchronize()"]);
    expect(syncCount()).toBe(1);
    expect(tags.get("point-8")).toBe(1);
  });

  it("creates a line from two fresh endpoint points, and maps the LINE's tag to the id", () => {
    // The endpoint points are implementation detail — they exist only to carry
    // the curve — so the id must resolve to `addLine`'s return, not to either
    // `addPoint`. Getting this wrong would put the Part's physical group on a
    // stray 0-D entity and the curve would carry no group at all.
    const { gmsh, calls } = fakeGmsh();
    const { tags } = addFreeEntitiesToGmshModel(gmsh, [
      { id: "edge-12", kind: "line", from: [-0.9, -1.1, 2.5], to: [0.9, 1.1, 2.5] },
    ]);
    expect(calls).toEqual([
      "addPoint(-0.9, -1.1, 2.5) -> 1",
      "addPoint(0.9, 1.1, 2.5) -> 2",
      "addLine(1, 2) -> 3",
      "synchronize()",
    ]);
    expect(tags.get("edge-12")).toBe(3);
  });

  it("batches many entities behind ONE synchronize", () => {
    const { gmsh, syncCount } = fakeGmsh();
    const specs: FreeEntitySpec[] = [
      { id: "point-8", kind: "point", at: [0, 0, 0] },
      { id: "point-9", kind: "point", at: [1, 0, 0] },
      { id: "edge-12", kind: "line", from: [0, 0, 0], to: [1, 0, 0] },
    ];
    const { tags } = addFreeEntitiesToGmshModel(gmsh, specs);
    expect(syncCount()).toBe(1);
    expect(tags.size).toBe(3);
  });

  it("preserves the caller's id strings verbatim, including a non-default numeric suffix", () => {
    // Ids are the keys `gmshPartsMap` merges back into `pointIdToTag` /
    // `edgeIdToTag`, so an id must survive unchanged — a reformatted one would
    // silently fail to join and the Part's entity would fall out of its own
    // physical group with no error anywhere.
    const { gmsh } = fakeGmsh();
    const { tags } = addFreeEntitiesToGmshModel(gmsh, [
      { id: "point-104", kind: "point", at: [0, 0, 0] },
    ]);
    expect([...tags.keys()]).toEqual(["point-104"]);
  });

  it("propagates a throw from the gmsh model instead of swallowing it", () => {
    // The caller's `catch` is what wraps an OCCT abort and resets Gmsh; a
    // silent catch here would leave a half-built model and rethrow nothing.
    const gmsh = {
      model: {
        occ: {
          addPoint: () => {
            throw new Error("memory access out of bounds");
          },
          addLine: () => 0,
          synchronize: () => {},
        },
      },
    };
    expect(() =>
      addFreeEntitiesToGmshModel(gmsh, [{ id: "point-1", kind: "point", at: [0, 0, 0] }])
    ).toThrow(/out of bounds/);
  });
});
