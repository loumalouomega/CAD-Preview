import { describe, it, expect } from "vitest";
import {
  validateMeshOptions,
  applyStlPartSizeOverride,
  gmshShapeOptions,
  DEFAULT_MESH_OPTIONS,
  SIZE_MAX_SENTINEL,
} from "./meshOptions";
import type { Part } from "./protocol";

function part(overrides: Partial<Part>): Part {
  return { name: "P", color: "#fff", volumes: [], surfaces: [], lines: [], points: [], ...overrides };
}

describe("validateMeshOptions", () => {
  it("accepts a well-formed options object unchanged", () => {
    const opts = {
      dimension: 2,
      sizeMin: 0.1,
      sizeMax: 10,
      algorithm2D: 5,
      algorithm3D: 1,
      elementOrder: 2,
      elementShape: "subdivided" as const,
      optimize: false,
      stlAngle: 30,
    };
    expect(validateMeshOptions(opts)).toEqual(opts);
  });

  it("returns null when raw isn't an object", () => {
    expect(validateMeshOptions(null)).toBeNull();
    expect(validateMeshOptions(undefined)).toBeNull();
    expect(validateMeshOptions("nope")).toBeNull();
    expect(validateMeshOptions(42)).toBeNull();
    expect(validateMeshOptions([])).toBeNull();
  });

  it("falls back to defaults for an empty object", () => {
    expect(validateMeshOptions({})).toEqual(DEFAULT_MESH_OPTIONS);
  });

  it("clamps/defaults individually invalid fields rather than rejecting the whole object", () => {
    const result = validateMeshOptions({
      dimension: 7, // invalid -> default
      sizeMin: -5, // invalid -> default
      sizeMax: "big", // invalid -> default
      algorithm2D: "x", // invalid -> default
      algorithm3D: null, // invalid -> default
      elementOrder: 3, // invalid -> default
      elementShape: "hexDominant", // invalid (excluded) -> default
      optimize: "yes", // invalid -> default
      stlAngle: 400, // invalid -> default
    });
    expect(result).toEqual(DEFAULT_MESH_OPTIONS);
  });

  it("defaults dimension unless it is exactly 1, 2, or 3", () => {
    expect(validateMeshOptions({ dimension: 1 })?.dimension).toBe(1);
    expect(validateMeshOptions({ dimension: 2 })?.dimension).toBe(2);
    expect(validateMeshOptions({ dimension: 3 })?.dimension).toBe(3);
    expect(validateMeshOptions({ dimension: 0 })?.dimension).toBe(DEFAULT_MESH_OPTIONS.dimension);
    expect(validateMeshOptions({ dimension: 2.5 })?.dimension).toBe(DEFAULT_MESH_OPTIONS.dimension);
  });

  it("defaults elementOrder unless it is exactly 1 or 2", () => {
    expect(validateMeshOptions({ elementOrder: 1 })?.elementOrder).toBe(1);
    expect(validateMeshOptions({ elementOrder: 2 })?.elementOrder).toBe(2);
    expect(validateMeshOptions({ elementOrder: 3 })?.elementOrder).toBe(DEFAULT_MESH_OPTIONS.elementOrder);
    expect(validateMeshOptions({ elementOrder: 0 })?.elementOrder).toBe(DEFAULT_MESH_OPTIONS.elementOrder);
  });

  it("defaults elementShape unless it is exactly 'simplex' or 'subdivided'", () => {
    expect(validateMeshOptions({ elementShape: "simplex" })?.elementShape).toBe("simplex");
    expect(validateMeshOptions({ elementShape: "subdivided" })?.elementShape).toBe("subdivided");
    // hexDominant is intentionally excluded (broken in the WASM build) -> default
    expect(validateMeshOptions({ elementShape: "hexDominant" })?.elementShape).toBe(DEFAULT_MESH_OPTIONS.elementShape);
    expect(validateMeshOptions({ elementShape: 2 })?.elementShape).toBe(DEFAULT_MESH_OPTIONS.elementShape);
  });

  it("defaults sizeMin/sizeMax when negative or non-finite, and defaults both when sizeMin > sizeMax", () => {
    expect(validateMeshOptions({ sizeMin: -1 })?.sizeMin).toBe(DEFAULT_MESH_OPTIONS.sizeMin);
    expect(validateMeshOptions({ sizeMax: -1 })?.sizeMax).toBe(DEFAULT_MESH_OPTIONS.sizeMax);
    expect(validateMeshOptions({ sizeMin: Infinity })?.sizeMin).toBe(DEFAULT_MESH_OPTIONS.sizeMin);
    // sizeMin > sizeMax is invalid combination -> both fall back to defaults
    const result = validateMeshOptions({ sizeMin: 10, sizeMax: 1 });
    expect(result?.sizeMin).toBe(DEFAULT_MESH_OPTIONS.sizeMin);
    expect(result?.sizeMax).toBe(DEFAULT_MESH_OPTIONS.sizeMax);
    // valid: sizeMin === sizeMax is fine
    expect(validateMeshOptions({ sizeMin: 5, sizeMax: 5 })).toMatchObject({ sizeMin: 5, sizeMax: 5 });
  });

  it("defaults stlAngle unless strictly within (0, 180)", () => {
    expect(validateMeshOptions({ stlAngle: 0 })?.stlAngle).toBe(DEFAULT_MESH_OPTIONS.stlAngle);
    expect(validateMeshOptions({ stlAngle: 180 })?.stlAngle).toBe(DEFAULT_MESH_OPTIONS.stlAngle);
    expect(validateMeshOptions({ stlAngle: -10 })?.stlAngle).toBe(DEFAULT_MESH_OPTIONS.stlAngle);
    expect(validateMeshOptions({ stlAngle: 90 })?.stlAngle).toBe(90);
  });

  it("defaults algorithm2D/algorithm3D unless finite numbers", () => {
    expect(validateMeshOptions({ algorithm2D: "x" })?.algorithm2D).toBe(DEFAULT_MESH_OPTIONS.algorithm2D);
    expect(validateMeshOptions({ algorithm3D: NaN })?.algorithm3D).toBe(DEFAULT_MESH_OPTIONS.algorithm3D);
    expect(validateMeshOptions({ algorithm2D: 8 })?.algorithm2D).toBe(8);
  });

  it("defaults optimize unless it is a boolean", () => {
    expect(validateMeshOptions({ optimize: true })?.optimize).toBe(true);
    expect(validateMeshOptions({ optimize: false })?.optimize).toBe(false);
    expect(validateMeshOptions({ optimize: "true" })?.optimize).toBe(DEFAULT_MESH_OPTIONS.optimize);
    expect(validateMeshOptions({ optimize: 1 })?.optimize).toBe(DEFAULT_MESH_OPTIONS.optimize);
  });
});

describe("applyStlPartSizeOverride", () => {
  it("leaves options unchanged when no part has meshSize set", () => {
    const parts = [part({ name: "A" }), part({ name: "B" })];
    expect(applyStlPartSizeOverride(DEFAULT_MESH_OPTIONS, parts)).toBe(DEFAULT_MESH_OPTIONS);
  });

  it("leaves options unchanged when more than one part has meshSize set (ambiguous)", () => {
    const parts = [part({ name: "A", meshSize: 1 }), part({ name: "B", meshSize: 2 })];
    expect(applyStlPartSizeOverride(DEFAULT_MESH_OPTIONS, parts)).toBe(DEFAULT_MESH_OPTIONS);
  });

  it("overrides sizeMin/sizeMax to the single part's meshSize", () => {
    const parts = [part({ name: "A" }), part({ name: "B", meshSize: 0.5 })];
    const result = applyStlPartSizeOverride(DEFAULT_MESH_OPTIONS, parts);
    expect(result).toEqual({ ...DEFAULT_MESH_OPTIONS, sizeMin: 0.5, sizeMax: 0.5 });
    expect(DEFAULT_MESH_OPTIONS.sizeMin).not.toBe(0.5); // original untouched
  });

  it("no-ops on an empty parts list", () => {
    expect(applyStlPartSizeOverride(DEFAULT_MESH_OPTIONS, [])).toBe(DEFAULT_MESH_OPTIONS);
  });
});

describe("gmshShapeOptions", () => {
  it("simplex never recombines or subdivides, any dimension", () => {
    for (const d of [1, 2, 3] as const) {
      expect(gmshShapeOptions("simplex", d)).toEqual({ recombineAll: 0, subdivisionAlgorithm: 0 });
    }
  });

  it("subdivided uses Blossom recombination in 2D and hex subdivision in 3D", () => {
    expect(gmshShapeOptions("subdivided", 2)).toEqual({ recombineAll: 1, subdivisionAlgorithm: 0 });
    expect(gmshShapeOptions("subdivided", 3)).toEqual({ recombineAll: 0, subdivisionAlgorithm: 2 });
  });

  it("subdivided in 1D degrades to plain simplex options", () => {
    expect(gmshShapeOptions("subdivided", 1)).toEqual({ recombineAll: 0, subdivisionAlgorithm: 0 });
  });
});

describe("DEFAULT_MESH_OPTIONS", () => {
  it("is itself valid", () => {
    expect(validateMeshOptions(DEFAULT_MESH_OPTIONS)).toEqual(DEFAULT_MESH_OPTIONS);
  });

  it("matches the documented defaults", () => {
    expect(DEFAULT_MESH_OPTIONS).toEqual({
      dimension: 3,
      sizeMin: 0,
      sizeMax: 1e22,
      algorithm2D: 6,
      algorithm3D: 1,
      elementOrder: 1,
      elementShape: "simplex",
      optimize: true,
      stlAngle: 40,
    });
  });

  it("defaults sizeMax to the unbounded sentinel the webview seeds over", () => {
    expect(DEFAULT_MESH_OPTIONS.sizeMax).toBe(SIZE_MAX_SENTINEL);
  });

  it("round-trips a seeded (finite, non-sentinel) sizeMax untouched", () => {
    const seeded = { ...DEFAULT_MESH_OPTIONS, sizeMax: 4.21 };
    expect(validateMeshOptions(seeded)).toEqual(seeded);
  });
});
