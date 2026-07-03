import { describe, it, expect, vi } from "vitest";
import { MeshingModel } from "./meshingModel";
import { DEFAULT_MESH_OPTIONS } from "../meshOptions";

describe("MeshingModel", () => {
  it("defaults to DEFAULT_MESH_OPTIONS before any load", () => {
    const m = new MeshingModel(() => {});
    expect(m.get()).toEqual(DEFAULT_MESH_OPTIONS);
  });

  it("load hydrates state and does not fire onChange", () => {
    const onChange = vi.fn();
    const m = new MeshingModel(onChange);
    m.load({ ...DEFAULT_MESH_OPTIONS, dimension: 2, sizeMax: 5 });
    expect(onChange).not.toHaveBeenCalled();
    expect(m.get()).toEqual({ ...DEFAULT_MESH_OPTIONS, dimension: 2, sizeMax: 5 });
  });

  it("update merges a partial patch and fires onChange", () => {
    const onChange = vi.fn();
    const m = new MeshingModel(onChange);
    m.update({ dimension: 2 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(m.get()).toEqual({ ...DEFAULT_MESH_OPTIONS, dimension: 2 });

    m.update({ sizeMin: 0.5 });
    expect(onChange).toHaveBeenCalledTimes(2);
    // Earlier patch (dimension) must survive a later, unrelated patch.
    expect(m.get()).toEqual({ ...DEFAULT_MESH_OPTIONS, dimension: 2, sizeMin: 0.5 });
  });

  it("get returns a deep copy (no aliasing)", () => {
    const m = new MeshingModel(() => {});
    const a = m.get();
    a.dimension = 1;
    a.sizeMax = 999;
    expect(m.get()).toEqual(DEFAULT_MESH_OPTIONS);
  });

  it("load replaces wholesale rather than merging with prior state", () => {
    const m = new MeshingModel(() => {});
    m.update({ dimension: 2, optimize: false });
    m.load(DEFAULT_MESH_OPTIONS);
    expect(m.get()).toEqual(DEFAULT_MESH_OPTIONS);
  });
});
