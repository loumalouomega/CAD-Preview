import { describe, expect, it, vi } from "vitest";
import { LayersModel } from "./layersModel";

describe("LayersModel", () => {
  it("loads empty as the implicit default without firing onChange", () => {
    const onChange = vi.fn();
    const m = new LayersModel(onChange);
    m.load([]);
    expect(onChange).not.toHaveBeenCalled();
    expect(m.list()).toEqual([
      { id: "layer-0", name: "Default", color: "#b8b8b8", visible: true, locked: false, volumes: [], surfaces: [], lines: [], points: [] },
    ]);
  });

  it("creates beside the materialized default with never-reused ids", () => {
    const changes: number[] = [];
    const m = new LayersModel(() => changes.push(1));
    m.load([]);
    const a = m.create("Dims");
    expect(a.id).toBe("layer-1");
    expect(m.remove("layer-1")).toBe(true);
    expect(m.create("Again").id).toBe("layer-2");
    expect(changes.length).toBe(3);
  });

  it("refuses to delete the default layer", () => {
    const onChange = vi.fn();
    const m = new LayersModel(onChange);
    m.load([]);
    expect(m.remove("layer-0")).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(m.list()).toHaveLength(1);
  });

  it("returns a deleted layer's members to the default layer", () => {
    const m = new LayersModel(() => undefined);
    m.load([]);
    m.create("Gone");
    m.assign("layer-1", [{ entityType: "surface", entityId: "face-1" }]);
    expect(m.remove("layer-1")).toBe(true);
    expect(m.list()[0].surfaces).toEqual(["face-1"]);
  });

  it("assign moves each entity onto exactly one layer", () => {
    const m = new LayersModel(() => undefined);
    m.load([]);
    m.create("A");
    m.create("B");
    m.assign("layer-1", [{ entityType: "surface" as const, entityId: "face-1" }]);
    m.assign("layer-2", [{ entityType: "surface" as const, entityId: "face-1" }]);
    expect(m.list()[1].surfaces).toEqual([]);
    expect(m.list()[2].surfaces).toEqual(["face-1"]);
  });

  it("tracks visibility, lock, and the locked-entity set", () => {
    const m = new LayersModel(() => undefined);
    m.load([]);
    m.create("Frozen");
    m.assign("layer-1", [{ entityType: "volume" as const, entityId: "solid-0" }]);
    expect(m.lockedEntityIds().size).toBe(0);
    m.setLocked("layer-1", true);
    expect(m.lockedEntityIds()).toEqual(new Set(["solid-0"]));
    m.setVisible("layer-1", false);
    expect(m.find("layer-1")?.visible).toBe(false);
    expect(m.entitiesOf("layer-1")).toEqual([{ entityType: "volume", entityId: "solid-0" }]);
  });

  it("list() returns copies — mutating the result never touches the model", () => {
    const m = new LayersModel(() => undefined);
    m.load([]);
    m.list()[0].surfaces.push("face-9");
    expect(m.list()[0].surfaces).toEqual([]);
  });
});

describe("never-reused ids", () => {
  it("a deleted id never comes back, across loads", () => {
    const onChange = vi.fn();
    const m = new LayersModel(onChange);
    m.load([], 0);
    expect(m.create("A").id).toBe("layer-1");
    expect(m.remove("layer-1")).toBe(true);
    // The counter survived the delete, so the next layer is layer-2.
    expect(m.create("B").id).toBe("layer-2");
    // A load carrying a higher counter (e.g. written by the host after an
    // agent created layers) wins over the local max.
    m.load(m.list(), 7);
    expect(m.create("C").id).toBe("layer-7");
  });
});
