import { describe, it, expect, vi } from "vitest";
import { PartsModel } from "./partsModel";

describe("PartsModel", () => {
  it("creates parts with auto names, palette colours, and fires onChange", () => {
    const onChange = vi.fn();
    const m = new PartsModel(onChange);
    m.create();
    m.create("Inlet");
    expect(onChange).toHaveBeenCalledTimes(2);
    const parts = m.list();
    expect(parts[0].name).toBe("Part 1");
    expect(parts[1].name).toBe("Inlet");
    expect(parts[0].color).not.toBe(parts[1].color);
  });

  it("assigns entities into the correct buckets and de-dupes", () => {
    const m = new PartsModel(() => {});
    m.create();
    m.assign(0, [
      { entityType: "volume", entityId: "solid-0" },
      { entityType: "surface", entityId: "face-2" },
      { entityType: "surface", entityId: "face-2" }, // dup
      { entityType: "line", entityId: "edge-5" },
      { entityType: "point", entityId: "point-3" },
    ]);
    const p = m.list()[0];
    expect(p.volumes).toEqual(["solid-0"]);
    expect(p.surfaces).toEqual(["face-2"]);
    expect(p.lines).toEqual(["edge-5"]);
    expect(p.points).toEqual(["point-3"]);
  });

  it("removes a single entity and whole parts", () => {
    const m = new PartsModel(() => {});
    m.create();
    m.assign(0, [
      { entityType: "surface", entityId: "face-1" },
      { entityType: "surface", entityId: "face-2" },
    ]);
    m.removeEntity(0, "surface", "face-1");
    expect(m.list()[0].surfaces).toEqual(["face-2"]);
    m.remove(0);
    expect(m.size).toBe(0);
  });

  it("resolves a colour map with last-part-wins on overlap", () => {
    const m = new PartsModel(() => {});
    m.create(); // Part 1
    m.create(); // Part 2
    m.recolor(0, "#111111");
    m.recolor(1, "#222222");
    m.assign(0, [{ entityType: "surface", entityId: "face-1" }]);
    m.assign(1, [{ entityType: "surface", entityId: "face-1" }]); // overlaps
    const map = m.colorMap();
    expect(map.faces.get("face-1")).toBe("#222222");
  });

  it("load() replaces data without firing onChange", () => {
    const onChange = vi.fn();
    const m = new PartsModel(onChange);
    m.load([{ name: "X", color: "#abcdef", volumes: ["solid-0"], surfaces: [], lines: [], points: [] }]);
    expect(onChange).not.toHaveBeenCalled();
    expect(m.list()[0].name).toBe("X");
    expect(m.entitiesOf(0)).toEqual([{ entityType: "volume", entityId: "solid-0" }]);
  });

  it("sets and clears a part's meshSize, firing onChange", () => {
    const onChange = vi.fn();
    const m = new PartsModel(onChange);
    m.create();
    m.setMeshSize(0, 0.75);
    expect(m.list()[0].meshSize).toBe(0.75);
    m.setMeshSize(0, undefined);
    expect(m.list()[0].meshSize).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(3); // create + 2 setMeshSize calls
  });

  it("preserves meshSize through clone() on list()/load()", () => {
    const m = new PartsModel(() => {});
    m.load([{ name: "X", color: "#abcdef", volumes: [], surfaces: [], lines: [], points: [], meshSize: 1.5 }]);
    expect(m.list()[0].meshSize).toBe(1.5);
  });

  it("isolates internal state via clones", () => {
    const m = new PartsModel(() => {});
    m.create();
    const snapshot = m.list();
    snapshot[0].name = "mutated";
    snapshot[0].volumes.push("hack");
    expect(m.list()[0].name).toBe("Part 1");
    expect(m.list()[0].volumes).toEqual([]);
  });
});
