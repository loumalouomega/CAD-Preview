import { describe, expect, it } from "vitest";
import { weldedMeshToStlBytes, type WeldedMesh } from "./meshComponents";
import { meshioBoundarySide, meshioBoundarySideFromResult } from "./meshioBoundarySide";
import type { MeshioBoundaryResult } from "./meshioService";

const tetra: WeldedMesh = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
};

const square: WeldedMesh = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

function result(mesh: WeldedMesh, regionCount = 0): MeshioBoundaryResult {
  return {
    stlBytes: weldedMeshToStlBytes(mesh),
    ...(regionCount > 0
      ? { regions: { regionNames: Array.from({ length: regionCount }, (_, i) => `region-${i}`), triangleRegion: new Int32Array(mesh.indices.length / 3) } }
      : {}),
  };
}

describe("meshioBoundarySide", () => {
  it("welds the boundary and reports a closed tetrahedron as watertight", () => {
    const side = meshioBoundarySideFromResult(result(tetra, 2));
    expect(side.surfaceDerived).toBe(true);
    expect(side.regionCount).toBe(2);
    expect(side.triangleCount).toBe(4);
    expect(side.watertight).toBe(true);
    const mass = side.inspection.mass("whole-model");
    expect(mass.volume).toBeCloseTo(1 / 6, 9);
    expect(mass.area).toBeCloseTo((6 + Math.sqrt(3)) / 4, 9);
  });

  it("keeps an open surface open instead of inventing a volume", () => {
    const side = meshioBoundarySideFromResult(result(square));
    expect(side.regionCount).toBe(0);
    expect(side.triangleCount).toBe(2);
    expect(side.watertight).toBe(false);
    expect(side.inspection.mass("whole-model").area).toBeCloseTo(1, 9);
  });

  it("passes the source arguments through the injected converter", async () => {
    let seen: { bytes: Uint8Array; format: string; name?: string; companions?: number } | undefined;
    const side = await meshioBoundarySide(
      new Uint8Array([1, 2, 3]),
      "vtk",
      "cube.vtk",
      [{ name: "cube.h5", bytes: new Uint8Array([4]) }],
      async (bytes, format, name, companions) => {
        seen = { bytes, format, name, companions: companions?.length };
        return result(tetra);
      }
    );
    expect(seen).toEqual({ bytes: new Uint8Array([1, 2, 3]), format: "vtk", name: "cube.vtk", companions: 1 });
    expect(side.watertight).toBe(true);
  });
});
