import { describe, it, expect } from "vitest";
import {
  validateMeshOptions,
  octreeSummary,
  octreeMeshSummary,
  meshcadSummary,
  OCTREE_MAX_LEVEL_LIMIT,
  OCTREE_MESH_LEVELS_LIMIT,
  validateMeshGrading,
  validateMeshStructured,
  validateMeshBoundaryLayer,
  validateSizeField,
  MAX_SIZE_FIELD_SAMPLES,
  boundaryLayerPlan,
  boundaryLayerAlgorithmProblem,
  applyStlPartSizeOverride,
  gmshShapeOptions,
  scaleMeshOptionsForUnit,
  scalePartsMeshSizeForUnit,
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
      optimize: "none" as const,
      stlAngle: 30,
      engine: "ftetwild" as const,
      ftetwildEpsRel: 2e-3,
      ftetwildManifoldSurface: true,
      ftetwildCoarsen: false,
      ftetwildDisableFiltering: false,
      octreeMaxLevel: 5,
      octreeSnap: false,
      octreeTransition: "hanging" as const,
      mpcVariables: ["DISPLACEMENT_X", "TEMPERATURE"],
      octreeMeshOutput: "hex" as const,
      octreeMeshMaxSize: 1.5,
      octreeMeshLevels: 3,
      meshcadMinAngle: 25,
      meshcadSmoothIterations: 2,
      meshcadCurvatureDeviation: 0.05,
      meshcadCellsAcrossGaps: 2,
      meshcadGrading: 1.3,
      conformal: true,
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
      elementShape: "octahedral", // invalid (not a real shape) -> default
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

  it("defaults elementShape unless it is exactly 'simplex', 'subdivided', or 'hexDominant'", () => {
    expect(validateMeshOptions({ elementShape: "simplex" })?.elementShape).toBe("simplex");
    expect(validateMeshOptions({ elementShape: "subdivided" })?.elementShape).toBe("subdivided");
    expect(validateMeshOptions({ elementShape: "hexDominant" })?.elementShape).toBe("hexDominant");
    expect(validateMeshOptions({ elementShape: "octahedral" })?.elementShape).toBe(DEFAULT_MESH_OPTIONS.elementShape);
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

  it("accepts the optimize enum, parsing pre-enum booleans as default/none", () => {
    expect(validateMeshOptions({ optimize: true })?.optimize).toBe("default");
    expect(validateMeshOptions({ optimize: false })?.optimize).toBe("none");
    expect(validateMeshOptions({ optimize: "netgen" })?.optimize).toBe("netgen");
    expect(validateMeshOptions({ optimize: "highOrder" })?.optimize).toBe("highOrder");
    expect(validateMeshOptions({ optimize: "Relocate3D" })?.optimize).toBe(DEFAULT_MESH_OPTIONS.optimize);
    expect(validateMeshOptions({ optimize: 1 })?.optimize).toBe(DEFAULT_MESH_OPTIONS.optimize);
  });

  it("defaults engine unless it is exactly 'gmsh', 'ftetwild', 'octree', 'octreemesh' or 'meshcad'", () => {
    expect(validateMeshOptions({ engine: "octree" })?.engine).toBe("octree");
    expect(validateMeshOptions({ engine: "octreemesh" })?.engine).toBe("octreemesh");
    expect(validateMeshOptions({ engine: "octreeMesh" })?.engine).toBe("gmsh");
    expect(validateMeshOptions({ engine: "ftetwild" })?.engine).toBe("ftetwild");
    expect(validateMeshOptions({ engine: "gmsh" })?.engine).toBe("gmsh");
    expect(validateMeshOptions({ engine: "tetgen" })?.engine).toBe(DEFAULT_MESH_OPTIONS.engine);
    expect(validateMeshOptions({ engine: 1 })?.engine).toBe(DEFAULT_MESH_OPTIONS.engine);
    expect(validateMeshOptions({})?.engine).toBe(DEFAULT_MESH_OPTIONS.engine);
  });

  it("defaults ftetwildEpsRel unless a positive finite number", () => {
    expect(validateMeshOptions({ ftetwildEpsRel: 5e-4 })?.ftetwildEpsRel).toBe(5e-4);
    expect(validateMeshOptions({ ftetwildEpsRel: 0 })?.ftetwildEpsRel).toBe(DEFAULT_MESH_OPTIONS.ftetwildEpsRel);
    expect(validateMeshOptions({ ftetwildEpsRel: -1e-3 })?.ftetwildEpsRel).toBe(DEFAULT_MESH_OPTIONS.ftetwildEpsRel);
    expect(validateMeshOptions({ ftetwildEpsRel: NaN })?.ftetwildEpsRel).toBe(DEFAULT_MESH_OPTIONS.ftetwildEpsRel);
    expect(validateMeshOptions({ ftetwildEpsRel: "x" })?.ftetwildEpsRel).toBe(DEFAULT_MESH_OPTIONS.ftetwildEpsRel);
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

describe("scaleMeshOptionsForUnit", () => {
  it("returns options unchanged (same reference) for a factor of 1 (mm, no conversion)", () => {
    const options = { ...DEFAULT_MESH_OPTIONS, sizeMin: 1, sizeMax: 10 };
    expect(scaleMeshOptionsForUnit(options, 1)).toBe(options);
  });

  it("scales sizeMin and sizeMax by the given factor", () => {
    const options = { ...DEFAULT_MESH_OPTIONS, sizeMin: 1, sizeMax: 10 };
    const result = scaleMeshOptionsForUnit(options, 1 / 25.4);
    expect(result.sizeMin).toBeCloseTo(1 / 25.4, 6);
    expect(result.sizeMax).toBeCloseTo(10 / 25.4, 6);
  });

  it("leaves the SIZE_MAX_SENTINEL untouched — it's a flag, not a real mm value", () => {
    const options = { ...DEFAULT_MESH_OPTIONS, sizeMin: 0, sizeMax: SIZE_MAX_SENTINEL };
    const result = scaleMeshOptionsForUnit(options, 1 / 25.4);
    expect(result.sizeMax).toBe(SIZE_MAX_SENTINEL);
  });

  it("does not mutate the input", () => {
    const options = { ...DEFAULT_MESH_OPTIONS, sizeMin: 1, sizeMax: 10 };
    scaleMeshOptionsForUnit(options, 2);
    expect(options.sizeMin).toBe(1);
    expect(options.sizeMax).toBe(10);
  });
});

describe("scalePartsMeshSizeForUnit", () => {
  it("returns the same array reference for a factor of 1", () => {
    const parts = [part({ name: "A", meshSize: 5 })];
    expect(scalePartsMeshSizeForUnit(parts, 1)).toBe(parts);
  });

  it("scales only parts with meshSize set, leaving others untouched", () => {
    const parts = [part({ name: "A", meshSize: 10 }), part({ name: "B" })];
    const result = scalePartsMeshSizeForUnit(parts, 1 / 25.4);
    expect(result[0].meshSize).toBeCloseTo(10 / 25.4, 6);
    expect(result[1].meshSize).toBeUndefined();
    expect(parts[0].meshSize).toBe(10); // original untouched
  });

  it("no-ops on an empty parts list", () => {
    expect(scalePartsMeshSizeForUnit([], 2)).toEqual([]);
  });

  it("scales every length in meshGrading by the same factor", () => {
    const grading = { sizeAtWall: 0.15, sizeFar: 1, distNear: 0.3, distFar: 1.5 };
    const parts = [part({ name: "A", meshGrading: grading }), part({ name: "B" })];
    const result = scalePartsMeshSizeForUnit(parts, 1 / 25.4);
    const g = result[0].meshGrading!;
    expect(g.sizeAtWall).toBeCloseTo(0.15 / 25.4, 10);
    expect(g.sizeFar).toBeCloseTo(1 / 25.4, 10);
    expect(g.distNear).toBeCloseTo(0.3 / 25.4, 10);
    expect(g.distFar).toBeCloseTo(1.5 / 25.4, 10);
    expect(result[1].meshGrading).toBeUndefined();
    expect(parts[0].meshGrading).toEqual(grading); // original untouched
  });

  it("scales both meshSize and meshGrading on the same part independently", () => {
    const grading = { sizeAtWall: 0.15, sizeFar: 1, distNear: 0.3, distFar: 1.5 };
    const parts = [part({ name: "A", meshSize: 10, meshGrading: grading })];
    const result = scalePartsMeshSizeForUnit(parts, 2);
    expect(result[0].meshSize).toBe(20);
    expect(result[0].meshGrading).toEqual({ sizeAtWall: 0.3, sizeFar: 2, distNear: 0.6, distFar: 3 });
  });
});

describe("periodic pairs", () => {
  const ok = { slave: "Left", master: "Right", translation: [3, 0, 0] };
  it("keeps valid pairs and drops bad entries, never the list", () => {
    const v = validateMeshOptions({
      periodic: [ok, { slave: "A", master: "A", translation: [1, 0, 0] }, { slave: "A", master: "B", translation: [0, 0, 0] }, { slave: "A", master: "B", translation: [1, NaN, 0] }, "x"],
    });
    expect(v?.periodic).toEqual([ok]);
  });
  it("is absent (byte-stable sidecar) when none are given", () => {
    expect("periodic" in (validateMeshOptions({}) ?? {})).toBe(false);
    expect("periodic" in (validateMeshOptions({ periodic: [] }) ?? {})).toBe(false);
  });
  it("scales the translation with the unit factor", () => {
    const v = validateMeshOptions({ periodic: [ok] })!;
    expect(scaleMeshOptionsForUnit(v, 25.4).periodic![0].translation[0]).toBeCloseTo(76.2, 10);
  });
});

describe("validateSizeField", () => {
  it("accepts well-formed samples unchanged", () => {
    expect(validateSizeField([{ point: [1, 2, 3], size: 0.5 }])).toEqual([{ point: [1, 2, 3], size: 0.5 }]);
  });

  it("returns undefined for non-arrays and drops malformed entries, never the list", () => {
    for (const bad of [undefined, null, "x", 42, {}, { point: [0, 0, 0], size: 1 }]) {
      expect(validateSizeField(bad)).toBeUndefined();
    }
    expect(validateSizeField([])).toBeUndefined();
    expect(
      validateSizeField([
        { point: [0, 0, 0], size: 0.5 },
        { point: [0, 0], size: 0.5 },
        { point: [0, 0, 0], size: 0 },
        { point: [0, 0, NaN], size: 0.5 },
        "x",
        { point: [1, 1, 1], size: 1 },
      ])
    ).toEqual([
      { point: [0, 0, 0], size: 0.5 },
      { point: [1, 1, 1], size: 1 },
    ]);
  });

  it("is absent (byte-stable sidecar) when none are given", () => {
    expect("sizeField" in (validateMeshOptions({}) ?? {})).toBe(false);
    expect("sizeField" in (validateMeshOptions({ sizeField: [] }) ?? {})).toBe(false);
  });

  it("round-trips through validateMeshOptions and scales with the unit factor", () => {
    const v = validateMeshOptions({ sizeField: [{ point: [25.4, 0, 0], size: 2.54 }] })!;
    expect(v.sizeField).toEqual([{ point: [25.4, 0, 0], size: 2.54 }]);
    const scaled = scaleMeshOptionsForUnit(v, 1 / 25.4);
    expect(scaled.sizeField![0].point[0]).toBeCloseTo(1, 12);
    expect(scaled.sizeField![0].size).toBeCloseTo(0.1, 12);
    expect(v.sizeField![0].point[0]).toBe(25.4); // original untouched
  });

  it("truncates to the documented cap instead of rejecting the list", () => {
    const many = Array.from({ length: MAX_SIZE_FIELD_SAMPLES + 5 }, (_, i) => ({ point: [i, 0, 0], size: 1 }));
    expect(validateSizeField(many)!.length).toBe(MAX_SIZE_FIELD_SAMPLES);
  });
});

describe("validateMeshGrading", () => {
  const valid = { sizeAtWall: 0.15, sizeFar: 1, distNear: 0.3, distFar: 1.5 };

  it("accepts a well-formed band unchanged", () => {
    expect(validateMeshGrading(valid)).toEqual(valid);
  });

  it("returns undefined when raw isn't an object", () => {
    expect(validateMeshGrading(undefined)).toBeUndefined();
    expect(validateMeshGrading(null)).toBeUndefined();
    expect(validateMeshGrading("nope")).toBeUndefined();
    expect(validateMeshGrading(42)).toBeUndefined();
    expect(validateMeshGrading([])).toBeUndefined();
  });

  it("rejects a non-positive sizeAtWall", () => {
    expect(validateMeshGrading({ ...valid, sizeAtWall: 0 })).toBeUndefined();
    expect(validateMeshGrading({ ...valid, sizeAtWall: -1 })).toBeUndefined();
  });

  it("rejects sizeFar below sizeAtWall", () => {
    expect(validateMeshGrading({ ...valid, sizeFar: 0.1 })).toBeUndefined();
  });

  it("accepts sizeFar exactly equal to sizeAtWall (a flat band)", () => {
    expect(validateMeshGrading({ ...valid, sizeFar: valid.sizeAtWall })).toEqual({
      ...valid,
      sizeFar: valid.sizeAtWall,
    });
  });

  it("rejects a negative distNear", () => {
    expect(validateMeshGrading({ ...valid, distNear: -1 })).toBeUndefined();
  });

  it("accepts a zero distNear", () => {
    expect(validateMeshGrading({ ...valid, distNear: 0 })).toEqual({ ...valid, distNear: 0 });
  });

  it("rejects distFar at or below distNear", () => {
    expect(validateMeshGrading({ ...valid, distFar: valid.distNear })).toBeUndefined();
    expect(validateMeshGrading({ ...valid, distFar: valid.distNear - 0.1 })).toBeUndefined();
  });

  it("rejects a missing or non-finite field", () => {
    expect(validateMeshGrading({ sizeFar: 1, distNear: 0.3, distFar: 1.5 })).toBeUndefined();
    expect(validateMeshGrading({ ...valid, sizeAtWall: "x" })).toBeUndefined();
    expect(validateMeshGrading({ ...valid, distFar: NaN })).toBeUndefined();
  });
});

describe("validateMeshStructured", () => {
  it("accepts an integer divisions >= 2", () => {
    expect(validateMeshStructured({ divisions: 2 })).toEqual({ divisions: 2 });
    expect(validateMeshStructured({ divisions: 6 })).toEqual({ divisions: 6 });
  });

  it("returns undefined for non-objects and malformed counts", () => {
    for (const bad of [undefined, null, "6", 6, [], { divisions: 1 }, { divisions: 0 }, { divisions: 2.5 }, { divisions: "6" }, {}]) {
      expect(validateMeshStructured(bad)).toBeUndefined();
    }
  });
});

describe("gmshShapeOptions", () => {
  const plain = { recombineAll: 0, subdivisionAlgorithm: 0, recombine3DAll: 0, algorithm3DOverride: null };

  it("simplex never recombines or subdivides, any dimension", () => {
    for (const d of [1, 2, 3] as const) {
      expect(gmshShapeOptions("simplex", d)).toEqual(plain);
    }
  });

  it("subdivided uses Blossom recombination in 2D and hex subdivision in 3D", () => {
    expect(gmshShapeOptions("subdivided", 2)).toEqual({ ...plain, recombineAll: 1 });
    expect(gmshShapeOptions("subdivided", 3)).toEqual({ ...plain, subdivisionAlgorithm: 2 });
  });

  it("subdivided in 1D degrades to plain simplex options", () => {
    expect(gmshShapeOptions("subdivided", 1)).toEqual(plain);
  });

  it("hexDominant in 3D sets the RTree recombiner and overrides algorithm3D to 9", () => {
    expect(gmshShapeOptions("hexDominant", 3)).toEqual({ ...plain, recombine3DAll: 1, algorithm3DOverride: 9 });
  });

  it("hexDominant outside 3D degrades to plain simplex options", () => {
    expect(gmshShapeOptions("hexDominant", 1)).toEqual(plain);
    expect(gmshShapeOptions("hexDominant", 2)).toEqual(plain);
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
      optimize: "default",
      stlAngle: 40,
      engine: "gmsh",
      ftetwildEpsRel: 1e-3,
      ftetwildManifoldSurface: false,
      ftetwildCoarsen: false,
      ftetwildDisableFiltering: false,
      octreeMaxLevel: 4,
      octreeSnap: true,
      octreeTransition: "templates",
      mpcVariables: ["DISPLACEMENT_X", "DISPLACEMENT_Y", "DISPLACEMENT_Z"],
      octreeMeshOutput: "tet",
      octreeMeshMaxSize: 0,
      octreeMeshLevels: 2,
      meshcadMinAngle: 0,
      meshcadSmoothIterations: 0,
      meshcadCurvatureDeviation: 0,
      meshcadCellsAcrossGaps: 0,
      meshcadGrading: 0,
      conformal: true,
    });
  });

  it("validates the mesh-CAD fields to their documented ranges", () => {
    expect(validateMeshOptions({ engine: "meshcad" })?.engine).toBe("meshcad");
    expect(validateMeshOptions({ engine: "meshCad" })?.engine).toBe("gmsh");
    expect(validateMeshOptions({ meshcadMinAngle: 25 })?.meshcadMinAngle).toBe(25);
    // below 0 and at/above 60 can never be met by a triangulation: back to off
    for (const bad of [-1, 60, 90, Number.NaN, "25"]) expect(validateMeshOptions({ meshcadMinAngle: bad })?.meshcadMinAngle).toBe(0);
    expect(validateMeshOptions({ meshcadSmoothIterations: 3.4 })?.meshcadSmoothIterations).toBe(3);
    expect(validateMeshOptions({ meshcadSmoothIterations: 5000 })?.meshcadSmoothIterations).toBe(100);
    expect(validateMeshOptions({ meshcadSmoothIterations: -2 })?.meshcadSmoothIterations).toBe(0);
    expect(validateMeshOptions({ meshcadCurvatureDeviation: 0.05 })?.meshcadCurvatureDeviation).toBe(0.05);
    expect(validateMeshOptions({ meshcadCurvatureDeviation: -1 })?.meshcadCurvatureDeviation).toBe(0);
    expect(validateMeshOptions({ meshcadCellsAcrossGaps: 2 })?.meshcadCellsAcrossGaps).toBe(2);
    expect(validateMeshOptions({ meshcadGrading: 1.3 })?.meshcadGrading).toBe(1.3);
    // |grad h| <= grading - 1: anything in (0, 1] is meaningless
    for (const bad of [0.5, 1, -1]) expect(validateMeshOptions({ meshcadGrading: bad })?.meshcadGrading).toBe(0);
  });

  it("summarises a mesh-CAD generate in one line, naming open edges and missed bounds", () => {
    const stats = {
      targetSize: 1, order: 1 as const, numFaces: 6, numFailed: 0, numTriangles: 252, numPoints: 128,
      numOpenEdges: 0, numNonManifoldEdges: 0, numMisorientedEdges: 0, minAngleDeg: 23.79, maxAngleDeg: 105,
      minEdge: 0.5, maxEdge: 1.2, numRefinementPoints: 0, numFacesBelowBound: 0, numSmoothed: 0, numCurvedStraightened: 0, warnings: [],
    };
    expect(meshcadSummary(stats)).toBe("Mesh-CAD surface: 252 tri · min angle 23.8° · closed · Parts not preserved");
    expect(meshcadSummary({ ...stats, numOpenEdges: 4, numFacesBelowBound: 2, numFailed: 1 })).toBe(
      "Mesh-CAD surface: 252 tri · min angle 23.8° · 4 open edges · 2 face(s) below the angle bound · 1 face(s) failed · Parts not preserved"
    );
  });

  it("defaults the fTetWild flags unless real booleans", () => {
    expect(validateMeshOptions({ ftetwildManifoldSurface: true })?.ftetwildManifoldSurface).toBe(true);
    expect(validateMeshOptions({ ftetwildCoarsen: true })?.ftetwildCoarsen).toBe(true);
    expect(validateMeshOptions({ ftetwildDisableFiltering: true })?.ftetwildDisableFiltering).toBe(true);
    expect(validateMeshOptions({ ftetwildManifoldSurface: "yes" })?.ftetwildManifoldSurface).toBe(false);
    expect(validateMeshOptions({ ftetwildCoarsen: 1 })?.ftetwildCoarsen).toBe(false);
    expect(validateMeshOptions({})?.ftetwildDisableFiltering).toBe(false);
  });

  it("defaults conformal on, keeps explicit off", () => {
    expect(DEFAULT_MESH_OPTIONS.conformal).toBe(true);
    expect(validateMeshOptions({})?.conformal).toBe(true);
    expect(validateMeshOptions({ conformal: false })?.conformal).toBe(false);
    expect(validateMeshOptions({ conformal: "yes" })?.conformal).toBe(true);
  });

  it("defaults sizeMax to the unbounded sentinel the webview seeds over", () => {
    expect(DEFAULT_MESH_OPTIONS.sizeMax).toBe(SIZE_MAX_SENTINEL);
  });

  it("round-trips a seeded (finite, non-sentinel) sizeMax untouched", () => {
    const seeded = { ...DEFAULT_MESH_OPTIONS, sizeMax: 4.21 };
    expect(validateMeshOptions(seeded)).toEqual(seeded);
  });
});

describe("validateMeshBoundaryLayer", () => {
  it("accepts a well-formed layer and defaults quads to true", () => {
    expect(validateMeshBoundaryLayer({ wallSize: 0.05, growthRatio: 1.2, thickness: 0.5 })).toEqual({ wallSize: 0.05, growthRatio: 1.2, thickness: 0.5, quads: true });
    expect(validateMeshBoundaryLayer({ wallSize: 0.05, growthRatio: 1, thickness: 0.05, quads: false })).toEqual({ wallSize: 0.05, growthRatio: 1, thickness: 0.05, quads: false });
  });

  it("rejects non-objects, non-positive walls, shrinking ratios and a thickness below the wall", () => {
    for (const bad of [null, undefined, 3, "x", [], {}, { wallSize: 0, growthRatio: 1.2, thickness: 1 }, { wallSize: -1, growthRatio: 1.2, thickness: 1 },
      { wallSize: 0.1, growthRatio: 0.9, thickness: 1 }, { wallSize: 0.1, growthRatio: 1.2, thickness: 0.05 },
      { wallSize: NaN, growthRatio: 1.2, thickness: 1 }, { wallSize: 0.1, growthRatio: 1.2 }]) {
      expect(validateMeshBoundaryLayer(bad)).toBeUndefined();
    }
  });
});

describe("boundaryLayerPlan", () => {
  // Analytic: row k is h*r^k high, so n rows total h*(r^n - 1)/(r - 1).
  it("fits 6 rows of 0.05 x 1.2 into 0.5 (total 0.4966, last 0.1244)", () => {
    const p = boundaryLayerPlan({ wallSize: 0.05, growthRatio: 1.2, thickness: 0.5, quads: true });
    expect(p.layers).toBe(6);
    expect(p.totalThickness).toBeCloseTo((0.05 * (Math.pow(1.2, 6) - 1)) / 0.2, 12);
    expect(p.lastHeight).toBeCloseTo(0.05 * Math.pow(1.2, 5), 12);
    expect(p.totalThickness).toBeLessThanOrEqual(0.5);
  });

  it("keeps an exact fit instead of dropping a row to floating-point noise", () => {
    expect(boundaryLayerPlan({ wallSize: 0.05, growthRatio: 1.2, thickness: 0.182, quads: true }).layers).toBe(3);
    // Without the epsilon these floor one row short (log ratio evaluates to 4.999999999999999 / 3.9999999999999996).
    expect(boundaryLayerPlan({ wallSize: 0.01, growthRatio: 1.1, thickness: 0.061051, quads: true }).layers).toBe(5);
    expect(boundaryLayerPlan({ wallSize: 0.01, growthRatio: 1.2, thickness: 0.07441599999999998, quads: true }).layers).toBe(5);
  });

  it("handles a unit ratio as equal rows", () => {
    const p = boundaryLayerPlan({ wallSize: 0.1, growthRatio: 1, thickness: 0.55, quads: true });
    expect(p.layers).toBe(5);
    expect(p.totalThickness).toBeCloseTo(0.5, 12);
    expect(p.lastHeight).toBeCloseTo(0.1, 12);
  });

  it("is a single row when the thickness equals the wall", () => {
    expect(boundaryLayerPlan({ wallSize: 0.2, growthRatio: 1.5, thickness: 0.2, quads: true }).layers).toBe(1);
  });
});

describe("boundaryLayerAlgorithmProblem", () => {
  it("accepts the algorithms measured to grade the wall", () => {
    for (const a of [2, 5, 6, 8]) {
      expect(boundaryLayerAlgorithmProblem(a, false)).toBeNull();
      expect(boundaryLayerAlgorithmProblem(a, true)).toBeNull();
    }
    expect(boundaryLayerAlgorithmProblem(1, false)).toBeNull();
  });

  it("refuses MeshAdapt with recombination (it aborts the WASM module) and the algorithms that fail or ignore the layer", () => {
    expect(boundaryLayerAlgorithmProblem(1, true)).toMatch(/aborts the mesher/);
    for (const a of [3, 7, 9, 11, 42]) expect(boundaryLayerAlgorithmProblem(a, false)).toMatch(/cannot carry a boundary layer/);
  });
});

describe("scalePartsMeshSizeForUnit boundary layers", () => {
  it("scales wallSize and thickness but never the dimensionless ratio", () => {
    const parts = [part({ name: "A", meshBoundaryLayer: { wallSize: 0.05, growthRatio: 1.2, thickness: 0.5, quads: true } })];
    const result = scalePartsMeshSizeForUnit(parts, 2);
    expect(result[0].meshBoundaryLayer).toEqual({ wallSize: 0.1, growthRatio: 1.2, thickness: 1, quads: true });
    expect(parts[0].meshBoundaryLayer!.wallSize).toBe(0.05); // original untouched
  });
});

describe("octree options", () => {
  it("clamps octreeMaxLevel to 1..limit, rounds it, and defaults anything else", () => {
    expect(validateMeshOptions({ octreeMaxLevel: 3 })?.octreeMaxLevel).toBe(3);
    expect(validateMeshOptions({ octreeMaxLevel: 2.6 })?.octreeMaxLevel).toBe(3);
    expect(validateMeshOptions({ octreeMaxLevel: 99 })?.octreeMaxLevel).toBe(OCTREE_MAX_LEVEL_LIMIT);
    expect(validateMeshOptions({ octreeMaxLevel: 0 })?.octreeMaxLevel).toBe(DEFAULT_MESH_OPTIONS.octreeMaxLevel);
    expect(validateMeshOptions({ octreeMaxLevel: -2 })?.octreeMaxLevel).toBe(DEFAULT_MESH_OPTIONS.octreeMaxLevel);
    expect(validateMeshOptions({ octreeMaxLevel: NaN })?.octreeMaxLevel).toBe(DEFAULT_MESH_OPTIONS.octreeMaxLevel);
    expect(validateMeshOptions({ octreeMaxLevel: "4" })?.octreeMaxLevel).toBe(DEFAULT_MESH_OPTIONS.octreeMaxLevel);
  });

  it("takes octreeSnap only as a real boolean", () => {
    expect(validateMeshOptions({ octreeSnap: false })?.octreeSnap).toBe(false);
    expect(validateMeshOptions({ octreeSnap: 0 })?.octreeSnap).toBe(true);
    expect(validateMeshOptions({})?.octreeSnap).toBe(true);
  });

  it("summarizes an octree result for the status line, naming refusals and the Parts loss", () => {
    const stats = { maxLevel: 4, snap: true, transition: "templates" as const, numLeaves: 3000, numHanging: 0, finestLevel: 4, numSnapped: 433, numRefused: 0, elementMix: { hexahedra: 1372, pyramids: 542, tetrahedra: 1608 } };
    expect(octreeSummary(stats)).toBe("Octree L4: 1372 hex · 542 pyramid · 1608 tet · snapped 433 · Parts not preserved");
    expect(octreeSummary({ ...stats, numRefused: 81 })).toContain("snapped 433, refused 81");
    expect(octreeSummary({ ...stats, snap: false })).toContain("snap off");
  });

  it("takes octreeTransition only as templates or hanging (polyhedra is never offered)", () => {
    expect(validateMeshOptions({ octreeTransition: "hanging" })?.octreeTransition).toBe("hanging");
    expect(validateMeshOptions({ octreeTransition: "polyhedra" })?.octreeTransition).toBe("templates");
    expect(validateMeshOptions({ octreeTransition: 1 })?.octreeTransition).toBe("templates");
    expect(validateMeshOptions({})?.octreeTransition).toBe("templates");
  });

  it("cleans mpcVariables to unique identifiers, capped, falling back to the displacement set", () => {
    expect(validateMeshOptions({ mpcVariables: ["TEMPERATURE", " PRESSURE ", "TEMPERATURE", "9bad", "a-b", 3] })?.mpcVariables).toEqual(["TEMPERATURE", "PRESSURE"]);
    expect(validateMeshOptions({ mpcVariables: "VELOCITY_X, VELOCITY_Y" })?.mpcVariables).toEqual(["VELOCITY_X", "VELOCITY_Y"]);
    expect(validateMeshOptions({ mpcVariables: [] })?.mpcVariables).toEqual(DEFAULT_MESH_OPTIONS.mpcVariables);
    expect(validateMeshOptions({ mpcVariables: ["", "1x"] })?.mpcVariables).toEqual(DEFAULT_MESH_OPTIONS.mpcVariables);
    expect(validateMeshOptions({ mpcVariables: Array.from({ length: 12 }, (_, i) => `V${i}`) })?.mpcVariables).toHaveLength(8);
  });

  it("summarizes a hanging run by its constraints, never by snap counts", () => {
    const stats = {
      maxLevel: 4, snap: false, transition: "hanging" as const, numLeaves: 1450, numHanging: 378, finestLevel: 4, numSnapped: 0, numRefused: 0,
      elementMix: { hexahedra: 11600, pyramids: 0, tetrahedra: 0 },
      constraints: { hangingNodes: 378, constraints: 1134, chained: 0, variables: ["DISPLACEMENT_X", "DISPLACEMENT_Y", "DISPLACEMENT_Z"] },
    };
    expect(octreeSummary(stats)).toBe("Octree L4 hanging: 11600 hex · 378 hanging nodes tied by 1134 MPCs · Parts not preserved");
    expect(octreeSummary({ ...stats, constraints: undefined })).toContain("constraints not computed");
  });
});

describe("octree-mesh options", () => {
  it("accepts only tet or hex as the output (castellated has hanging nodes and is not offered)", () => {
    expect(validateMeshOptions({ octreeMeshOutput: "hex" })?.octreeMeshOutput).toBe("hex");
    expect(validateMeshOptions({ octreeMeshOutput: "castellated" })?.octreeMeshOutput).toBe("tet");
    expect(validateMeshOptions({ octreeMeshOutput: 3 })?.octreeMeshOutput).toBe("tet");
  });

  it("keeps a positive max size, and maps zero, negative and non-numbers to automatic (0)", () => {
    expect(validateMeshOptions({ octreeMeshMaxSize: 2.5 })?.octreeMeshMaxSize).toBe(2.5);
    expect(validateMeshOptions({ octreeMeshMaxSize: 0 })?.octreeMeshMaxSize).toBe(0);
    expect(validateMeshOptions({ octreeMeshMaxSize: -1 })?.octreeMeshMaxSize).toBe(0);
    expect(validateMeshOptions({ octreeMeshMaxSize: "2" })?.octreeMeshMaxSize).toBe(0);
    expect(validateMeshOptions({ octreeMeshMaxSize: Infinity })?.octreeMeshMaxSize).toBe(0);
  });

  it("clamps levels to 1..limit, rounds, and defaults anything else", () => {
    expect(validateMeshOptions({ octreeMeshLevels: 3 })?.octreeMeshLevels).toBe(3);
    expect(validateMeshOptions({ octreeMeshLevels: 2.6 })?.octreeMeshLevels).toBe(3);
    expect(validateMeshOptions({ octreeMeshLevels: 99 })?.octreeMeshLevels).toBe(OCTREE_MESH_LEVELS_LIMIT);
    expect(validateMeshOptions({ octreeMeshLevels: 0 })?.octreeMeshLevels).toBe(DEFAULT_MESH_OPTIONS.octreeMeshLevels);
    expect(validateMeshOptions({ octreeMeshLevels: NaN })?.octreeMeshLevels).toBe(DEFAULT_MESH_OPTIONS.octreeMeshLevels);
  });

  it("summarizes a result with the quality facts and the Parts loss", () => {
    const tet = {
      output: "tet" as const, maxSize: 2, minSize: 0.5, numLeaves: 100, numTetrahedra: 44832, numHexahedra: 0, numInverted: 0,
      minDihedral: 35.26, maxDihedral: 125.26, minScaledJacobian: 0.24, hausdorffToSkin: 0, numFeatureChains: 12,
      numFeatureChainsMissed: 2, numWarpRefused: 0, warnings: [],
    };
    expect(octreeMeshSummary(tet)).toBe(
      "Octree-mesh tet: 44832 tet · min Jacobian 0.24 · dihedral 35.3°–125.3° · features 10/12 · 0 inverted · Parts not preserved"
    );
    const hex = octreeMeshSummary({ ...tet, output: "hex", numTetrahedra: 0, numHexahedra: 7776, numFeatureChains: 0, numFeatureChainsMissed: 0 });
    expect(hex).toBe("Octree-mesh hex: 7776 hex · min Jacobian 0.24 · 0 inverted · Parts not preserved");
  });
});
