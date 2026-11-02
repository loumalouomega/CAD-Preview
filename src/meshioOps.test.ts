import { describe, expect, it } from "vitest";
import { MESHIO_OP_IDS, MESHIO_OP_LABELS, validateMeshioOpSpec } from "./meshioOps";

describe("meshioOps", () => {
  it("covers the twelve transform_mesh operations", () => {
    expect([...MESHIO_OP_IDS].sort()).toEqual(
      ["adapt", "agglomerate", "clean", "convertCells", "decimate", "discretizeLevelset", "optimizeVolume", "polyToTet", "refine", "smooth", "subdivide", "tetToPoly"].sort()
    );
    for (const id of MESHIO_OP_IDS) expect(MESHIO_OP_LABELS[id].length).toBeGreaterThan(0);
  });

  it("accepts a bare op with no params", () => {
    expect(validateMeshioOpSpec({ op: "clean" })).toEqual({ op: "clean" });
  });

  it("rejects an unknown op id", () => {
    expect(validateMeshioOpSpec({ op: "extrude" })).toBeNull();
    expect(validateMeshioOpSpec(null)).toBeNull();
    expect(validateMeshioOpSpec("clean")).toBeNull();
  });

  it("rejects an out-of-range decimate ratio", () => {
    expect(validateMeshioOpSpec({ op: "decimate", ratio: 0 })).toBeNull();
    expect(validateMeshioOpSpec({ op: "decimate", ratio: 1.5 })).toBeNull();
    expect(validateMeshioOpSpec({ op: "decimate", ratio: 0.25 })).toEqual({ op: "decimate", ratio: 0.25 });
  });

  it("carries valid optional params and drops invalid ones", () => {
    expect(validateMeshioOpSpec({ op: "smooth", method: "laplacian", iterations: 3 })).toEqual({
      op: "smooth",
      method: "laplacian",
      iterations: 3,
    });
    // Unknown method string is dropped, not fatal — the kernel defaults it.
    expect(validateMeshioOpSpec({ op: "smooth", method: "nope" })).toEqual({ op: "smooth" });
    expect(validateMeshioOpSpec({ op: "convertCells", mode: "simplexify" })).toEqual({
      op: "convertCells",
      mode: "simplexify",
    });
  });
  it("validates the 18.0 op parameters", () => {
    expect(validateMeshioOpSpec({ op: "optimizeVolume", iterations: 3, objective: "energy", maxRingSize: 9 })).toEqual({ op: "optimizeVolume", iterations: 3, objective: "energy", maxRingSize: 9 });
    expect(validateMeshioOpSpec({ op: "optimizeVolume", objective: "bogus" })).toEqual({ op: "optimizeVolume" });
    expect(validateMeshioOpSpec({ op: "adapt", hsiz: 2, hausd: 0.1 })).toEqual({ op: "adapt", hsiz: 2, hausd: 0.1 });
    expect(validateMeshioOpSpec({ op: "adapt", hsiz: 0 })).toBeNull();
    expect(validateMeshioOpSpec({ op: "adapt", hausd: -1 })).toBeNull();
    expect(validateMeshioOpSpec({ op: "discretizeLevelset", levelSet: "phi", isovalue: 0.5 })).toEqual({ op: "discretizeLevelset", levelSet: "phi", isovalue: 0.5 });
    expect(validateMeshioOpSpec({ op: "discretizeLevelset" })).toBeNull();
  });
});
