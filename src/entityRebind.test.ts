import { describe, it, expect } from "vitest";
import { rebindEntities, remapPartEntityIds, type EntitySignature, type EntityIdBag } from "./entityRebind";

function sig(id: string, kind: EntitySignature["kind"], centre: [number, number, number], measure = 0): EntitySignature {
  return { id, kind, centre, measure };
}

describe("rebindEntities", () => {
  it("matches an unchanged face to itself when geometry is identical", () => {
    const old = [sig("face-0", "face", [0, 0, 0], 10), sig("face-1", "face", [5, 0, 0], 20)];
    const now = [sig("face-0", "face", [0, 0, 0], 10), sig("face-1", "face", [5, 0, 0], 20)];
    const matches = rebindEntities(old, now, 1e-6);
    expect(matches).toContainEqual(expect.objectContaining({ oldId: "face-0", newId: "face-0" }));
    expect(matches).toContainEqual(expect.objectContaining({ oldId: "face-1", newId: "face-1" }));
  });

  it("remaps an id whose index shifted but geometry stayed put", () => {
    // A new face got inserted before the old face-1's geometry, pushing it to face-2.
    const old = [sig("face-0", "face", [0, 0, 0], 10), sig("face-1", "face", [5, 0, 0], 20)];
    const now = [
      sig("face-0", "face", [0, 0, 0], 10),
      sig("face-1", "face", [99, 99, 99], 1), // brand-new face
      sig("face-2", "face", [5, 0, 0], 20), // the old face-1, renumbered
    ];
    const matches = rebindEntities(old, now, 1e-6);
    expect(matches).toContainEqual(expect.objectContaining({ oldId: "face-1", newId: "face-2" }));
    // The brand-new face-1 has no old counterpart within tolerance, so it's simply never a match target.
    expect(matches.some((m) => m.newId === "face-1")).toBe(false);
  });

  it("never matches across kinds even when centres coincide", () => {
    const old = [sig("edge-0", "edge", [1, 1, 1], 5)];
    const now = [sig("face-0", "face", [1, 1, 1], 5)];
    expect(rebindEntities(old, now, 1e-6)).toEqual([]);
  });

  it("drops an old entity with no candidate within tolerance", () => {
    const old = [sig("face-0", "face", [0, 0, 0], 10)];
    const now = [sig("face-0", "face", [100, 100, 100], 10)];
    expect(rebindEntities(old, now, 1)).toEqual([]);
  });

  it("prefers the closer candidate when two are within tolerance", () => {
    const old = [sig("face-0", "face", [0, 0, 0], 10)];
    const now = [sig("face-0", "face", [0.5, 0, 0], 10), sig("face-1", "face", [0.1, 0, 0], 10)];
    const matches = rebindEntities(old, now, 1);
    expect(matches).toEqual([expect.objectContaining({ oldId: "face-0", newId: "face-1" })]);
  });

  it("matches points by centre alone (measure is always 0)", () => {
    const old = [sig("point-0", "point", [1, 2, 3])];
    const now = [sig("point-0", "point", [1, 2, 3])];
    const matches = rebindEntities(old, now, 1e-6);
    expect(matches).toEqual([expect.objectContaining({ oldId: "point-0", newId: "point-0" })]);
  });

  it("each new entity is claimed by at most one old entity", () => {
    const old = [sig("face-0", "face", [0, 0, 0], 10), sig("face-1", "face", [0.01, 0, 0], 10)];
    const now = [sig("face-0", "face", [0, 0, 0], 10)];
    const matches = rebindEntities(old, now, 1);
    expect(matches.length).toBe(1);
  });
});

function part(overrides: Partial<EntityIdBag> = {}): EntityIdBag & { name: string } {
  return { name: "P", volumes: [], surfaces: [], lines: [], points: [], ...overrides };
}

describe("remapPartEntityIds", () => {
  it("rewrites ids through the map, counting only genuinely-changed ones as rebound", () => {
    const parts = [part({ surfaces: ["face-1", "face-3"], lines: ["edge-0"] })];
    const idMap = new Map([
      ["face-1", "face-2"], // renumbered
      ["face-3", "face-3"], // unchanged
      ["edge-0", "edge-0"], // unchanged
    ]);
    const result = remapPartEntityIds(parts, idMap);
    expect(result.parts[0].surfaces).toEqual(["face-2", "face-3"]);
    expect(result.parts[0].lines).toEqual(["edge-0"]);
    expect(result.reboundCount).toBe(1);
    expect(result.droppedCount).toBe(0);
  });

  it("drops an id with no entry in the map", () => {
    const parts = [part({ volumes: ["solid-0"] })];
    const result = remapPartEntityIds(parts, new Map());
    expect(result.parts[0].volumes).toEqual([]);
    expect(result.droppedCount).toBe(1);
    expect(result.reboundCount).toBe(0);
  });

  it("does not mutate the input parts array", () => {
    const parts = [part({ surfaces: ["face-1"] })];
    remapPartEntityIds(parts, new Map([["face-1", "face-9"]]));
    expect(parts[0].surfaces).toEqual(["face-1"]);
  });

  it("handles an empty parts list", () => {
    const result = remapPartEntityIds([], new Map());
    expect(result.parts).toEqual([]);
    expect(result.reboundCount).toBe(0);
    expect(result.droppedCount).toBe(0);
  });

  it("preserves every other field on the part object", () => {
    const parts = [{ name: "Widget", color: "#fff", volumes: ["solid-0"], surfaces: [], lines: [], points: [], meshSize: 2 }];
    const result = remapPartEntityIds(parts, new Map([["solid-0", "solid-0"]]));
    expect(result.parts[0]).toMatchObject({ name: "Widget", color: "#fff", meshSize: 2 });
  });
});
