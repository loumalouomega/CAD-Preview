import { describe, it, expect } from "vitest";
import { meshCadSurfaceModel, MESH_CAD_SURFACE_FORMATS } from "./meshCadSurface";

// Option validation runs before any WASM is touched; the live behaviour is
// pinned in `mcp:smoke` (meshio++ cannot load under vitest).
const bytes = new Uint8Array(0);

describe("meshCadSurfaceModel option validation", () => {
  it("maps each writable extension to meshio++'s own format name", () => {
    expect(MESH_CAD_SURFACE_FORMATS[".msh"]).toBe("gmsh");
    expect(Object.keys(MESH_CAD_SURFACE_FORMATS).sort()).toEqual([".msh", ".obj", ".ply", ".stl", ".vtk", ".vtu"]);
  });
  it("rejects an unsupported extension by listing the valid ones", async () => {
    await expect(meshCadSurfaceModel(bytes, "step", ".step", { targetSize: 1 })).rejects.toThrow(/Unsupported output extension.*\.stl/);
  });
  it("requires a positive targetSize", async () => {
    await expect(meshCadSurfaceModel(bytes, "step", ".stl", { targetSize: 0 })).rejects.toThrow(/targetSize must be a positive/);
    await expect(meshCadSurfaceModel(bytes, "step", ".stl", { targetSize: Number.NaN })).rejects.toThrow(/targetSize/);
  });
  it("rejects a negative deviation / tolerance and a fractional point count", async () => {
    await expect(meshCadSurfaceModel(bytes, "step", ".stl", { targetSize: 1, maxChordalDeviation: -1 })).rejects.toThrow(/non-negative/);
    await expect(meshCadSurfaceModel(bytes, "step", ".stl", { targetSize: 1, tolerance: -1 })).rejects.toThrow(/non-negative/);
    await expect(meshCadSurfaceModel(bytes, "step", ".stl", { targetSize: 1, minPointsPerEdge: 1.5 })).rejects.toThrow(/minPointsPerEdge/);
  });
});
