import { describe, expect, it } from "vitest";
import { meshInspection } from "./meshInspection";
import type { WeldedMesh } from "./meshComponents";

function cubeMesh(origin: [number, number, number] = [0, 0, 0]): WeldedMesh {
  const [ox, oy, oz] = origin;
  const positions = new Float32Array([
    ox, oy, oz,
    ox + 1, oy, oz,
    ox + 1, oy + 1, oz,
    ox, oy + 1, oz,
    ox, oy, oz + 1,
    ox + 1, oy, oz + 1,
    ox + 1, oy + 1, oz + 1,
    ox, oy + 1, oz + 1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    2, 3, 7, 2, 7, 6,
    1, 2, 6, 1, 6, 5,
    0, 4, 7, 0, 7, 3,
  ]);
  return { positions, indices };
}

describe("meshInspection", () => {
  it("invents a discoverable component/triangle/vertex inventory for a closed cube", () => {
    const inv = meshInspection(cubeMesh()).inventory;
    expect(inv.components).toHaveLength(1);
    expect(inv.components[0].entityId).toBe("mesh-component-0");
    expect(inv.components[0].triangleCount).toBe(12);
    expect(inv.triangleCount).toBe(12);
    expect(inv.vertexCount).toBe(8);
  });

  it("reports whole-model mass, bbox, and bbox-centre measurement", () => {
    const inspection = meshInspection(cubeMesh());
    const mass = inspection.mass("whole-model");
    expect(mass.volume).toBeCloseTo(1, 9);
    expect(mass.area).toBeCloseTo(6, 9);
    expect(mass.centerOfMass[0]).toBeCloseTo(0.5, 9);
    expect(mass.watertight).toBe(true);
    expect(mass.momentsOfInertia).toBeNull();

    const facts = inspection.inspect("whole-model");
    expect(facts.bbox).toMatchObject({ min: [0, 0, 0], max: [1, 1, 1] });
    expect(facts.center).toEqual([0.5, 0.5, 0.5]);
    expect(facts.surfaceParams).toBeNull();

    const m = inspection.measure("mesh-component-0", "whole-model");
    expect(m.distance).toBeCloseTo(0, 12);
    const axis = inspection.measure("mesh-triangle-0", "mesh-triangle-1", [1, 0, 0]);
    expect(axis.axis).toEqual([1, 0, 0]);
    expect(axis.axisComponent).toBeCloseTo(axis.delta[0], 12);
  });

  it("segments two disjoint cubes into two components", () => {
    const a = cubeMesh([0, 0, 0]);
    const b = cubeMesh([10, 0, 0]);
    const positions = new Float32Array([...a.positions, ...b.positions]);
    const shifted = Array.from(b.indices, (i) => i + 8);
    const indices = new Uint32Array([...a.indices, ...shifted]);
    const inspection = meshInspection({ positions, indices });
    expect(inspection.inventory.components).toHaveLength(2);
    const m = inspection.measure("mesh-component-0", "mesh-component-1");
    expect(m.distance).toBeCloseTo(10, 9);
    expect(m.delta[0]).toBeCloseTo(10, 9);
  });

  it("rejects webview-style ids with a load_model hint, and empty geometry with no-geometry", () => {
    const inspection = meshInspection(cubeMesh());
    expect(() => inspection.inspect("node-0")).toThrow(/load_model/i);
    expect(() => inspection.inspect("mesh-component-9")).toThrow(/re-run load_model/i);
    const empty = meshInspection({ positions: new Float32Array(), indices: new Uint32Array() });
    expect(empty.mass("whole-model").volume).toBeNull();
    expect(() => empty.inspect("whole-model")).toThrow(/no geometry/i);
  });
});
