import { describe, it, expect } from "vitest";
import { segmentMeshSurface, FIT_PRIMITIVE_TYPES } from "./meshSegment";

// meshio++ cannot load under vitest (see CLAUDE.md "Testing"); the live-WASM
// behaviour is pinned in `mcp:smoke`. These cover the option gate, which runs
// before any WASM or mesh work.
const bytes = new TextEncoder().encode("solid x\nendsolid x\n");

describe("segmentMeshSurface option validation", () => {
  it("rejects a feature angle outside 0..180", async () => {
    await expect(segmentMeshSurface(bytes, "stl", { featureAngle: 200 })).rejects.toThrow(/featureAngle/);
    await expect(segmentMeshSurface(bytes, "stl", { featureAngle: Number.NaN })).rejects.toThrow(/featureAngle/);
  });
  it("rejects an unknown or empty primitive type list", async () => {
    await expect(segmentMeshSurface(bytes, "stl", { types: ["blob" as never] })).rejects.toThrow(/Unknown primitive type/);
    await expect(segmentMeshSurface(bytes, "stl", { types: [] })).rejects.toThrow(/at least one/);
  });
  it("rejects an unknown segmentation method and a non-positive primitive tolerance", async () => {
    await expect(segmentMeshSurface(bytes, "stl", { method: "curvature" as never })).rejects.toThrow(/method must be/);
    await expect(segmentMeshSurface(bytes, "stl", { method: "primitive", primitiveTolerance: 0 })).rejects.toThrow(/primitiveTolerance/);
  });
  it("lists the five kinds in meshio++'s fit order", () => {
    expect([...FIT_PRIMITIVE_TYPES]).toEqual(["plane", "sphere", "cylinder", "cone", "torus"]);
  });
});
