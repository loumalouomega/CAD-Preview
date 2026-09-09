import { describe, expect, it } from "vitest";
import { MESHIO_OP_IDS, MESHIO_OP_LABELS, validateMeshioOpSpec } from "./meshioOps";

describe("meshioOps", () => {
  it("covers the seven transform_mesh operations", () => {
    expect([...MESHIO_OP_IDS].sort()).toEqual(
      ["agglomerate", "clean", "convertCells", "decimate", "refine", "smooth", "subdivide"].sort()
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
});
