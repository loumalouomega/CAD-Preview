import { describe, expect, it } from "vitest";
import { MESHIO_OP_IDS, MESHIO_OP_LABELS, validateMeshioOpSpec } from "./meshioOps";

describe("meshioOps", () => {
  it("covers the thirty-five transform_mesh operations", () => {
    expect([...MESHIO_OP_IDS].sort()).toEqual(
      ["adapt", "adaptVolume", "agglomerate", "clean", "convertCells", "convertCoordinates", "convexHull", "decimate", "delaunay2d", "discretizeLevelset", "estimateNormals", "geodesicDistance", "laplacianEigenmodes", "morph", "optimizeVolume", "parameterize", "polyToTet", "prepareMetric", "reconstructSurface", "refine", "smooth", "subdivide", "tetToPoly", "untangle", "flipNormals", "removeIslands", "offsetSurface", "thicken", "hollow", "clip", "autoAlign", "silhouette", "thickness", "colorize", "exaggerate"].sort()
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

  it("validates the 18.1 op parameters", () => {
    expect(validateMeshioOpSpec({ op: "untangle", iterations: 20, fixBoundary: false })).toEqual({ op: "untangle", iterations: 20, fixBoundary: false });
    expect(validateMeshioOpSpec({ op: "prepareMetric", arrays: ["m1", "m2"], targetVertices: 500.7, hmin: 0.1, hmax: 5, gradation: 1.5 }))
      .toEqual({ op: "prepareMetric", arrays: ["m1", "m2"], targetVertices: 500, hmin: 0.1, hmax: 5, gradation: 1.5 });
    // a metric op without arrays, a morph without its displacement, a geodesic without a source: refused up front
    expect(validateMeshioOpSpec({ op: "prepareMetric" })).toBeNull();
    expect(validateMeshioOpSpec({ op: "prepareMetric", arrays: [] })).toBeNull();
    expect(validateMeshioOpSpec({ op: "prepareMetric", arrays: ["ok", 3] })).toBeNull();
    expect(validateMeshioOpSpec({ op: "morph" })).toBeNull();
    expect(validateMeshioOpSpec({ op: "morph", array: "d", steps: 3.9, stiffening: 0, allowInverted: true })).toEqual({ op: "morph", array: "d", steps: 3, stiffening: 0, allowInverted: true });
    expect(validateMeshioOpSpec({ op: "geodesicDistance" })).toBeNull();
    expect(validateMeshioOpSpec({ op: "geodesicDistance", sources: [0, 1.5] })).toBeNull();
    expect(validateMeshioOpSpec({ op: "geodesicDistance", sources: [-1] })).toBeNull();
    expect(validateMeshioOpSpec({ op: "geodesicDistance", sources: [0, 7] })).toEqual({ op: "geodesicDistance", sources: [0, 7] });
    expect(validateMeshioOpSpec({ op: "geodesicDistance", sourceRegion: "inlet" })).toEqual({ op: "geodesicDistance", sourceRegion: "inlet" });
  });

  it("keeps only well-formed 18.1 optional values", () => {
    expect(validateMeshioOpSpec({ op: "convexHull", dimension: 2 })).toEqual({ op: "convexHull", dimension: 2 });
    expect(validateMeshioOpSpec({ op: "convexHull", dimension: 4 })).toEqual({ op: "convexHull" });
    expect(validateMeshioOpSpec({ op: "convertCoordinates", system: "spherical", axis: [0, 0, 1], origin: [1, 2, 3], inverse: true, arrays: ["u"] }))
      .toEqual({ op: "convertCoordinates", system: "spherical", axis: [0, 0, 1], origin: [1, 2, 3], inverse: true, arrays: ["u"] });
    // a zero axis, a wrong-length vector and an unknown system are dropped, not fatal
    expect(validateMeshioOpSpec({ op: "convertCoordinates", system: "polar", axis: [0, 0, 0], origin: [1, 2] })).toEqual({ op: "convertCoordinates" });
    expect(validateMeshioOpSpec({ op: "estimateNormals", neighbours: 1 })).toEqual({ op: "estimateNormals" });
    expect(validateMeshioOpSpec({ op: "estimateNormals", neighbours: 12, orientation: "viewpoint" })).toEqual({ op: "estimateNormals", neighbours: 12, orientation: "viewpoint" });
    expect(validateMeshioOpSpec({ op: "reconstructSurface", k: 1, cellSize: 0, maxDistance: 2.5 })).toEqual({ op: "reconstructSurface", k: 1, cellSize: 0, maxDistance: 2.5 });
    expect(validateMeshioOpSpec({ op: "reconstructSurface", cellSize: -1 })).toEqual({ op: "reconstructSurface" });
    expect(validateMeshioOpSpec({ op: "parameterize", padding: 0.01, maxDepth: 3, maxStretch: 0 })).toEqual({ op: "parameterize", padding: 0.01, maxDepth: 3 });
    expect(validateMeshioOpSpec({ op: "laplacianEigenmodes", numModes: 8 })).toEqual({ op: "laplacianEigenmodes", numModes: 8 });
    expect(validateMeshioOpSpec({ op: "delaunay2d" })).toEqual({ op: "delaunay2d" });
  });

  it("validates the 20.0 op parameters", () => {
    expect(validateMeshioOpSpec({ op: "offsetSurface" })).toBeNull();
    expect(validateMeshioOpSpec({ op: "offsetSurface", distance: -1.5, smoothIterations: 2.9 })).toEqual({ op: "offsetSurface", distance: -1.5, smoothIterations: 2 });
    expect(validateMeshioOpSpec({ op: "thicken", distance: 1, side: "both" })).toEqual({ op: "thicken", distance: 1, side: "both" });
    expect(validateMeshioOpSpec({ op: "thicken", distance: 1, side: "up" })).toEqual({ op: "thicken", distance: 1 });
    // a clip needs both halves of its plane; a zero normal is no normal
    expect(validateMeshioOpSpec({ op: "clip", origin: [0, 0, 5] })).toBeNull();
    expect(validateMeshioOpSpec({ op: "clip", origin: [0, 0, 5], normal: [0, 0, 0] })).toBeNull();
    expect(validateMeshioOpSpec({ op: "clip", origin: [0, 0, 5], normal: [0, 0, 1], keepBelow: false, cap: true })).toEqual({ op: "clip", origin: [0, 0, 5], normal: [0, 0, 1], keepBelow: false, cap: true });
    expect(validateMeshioOpSpec({ op: "colorize" })).toBeNull();
    expect(validateMeshioOpSpec({ op: "colorize", field: "deviation:distance", cmap: "viridis" })).toEqual({ op: "colorize", field: "deviation:distance", cmap: "viridis" });
    expect(validateMeshioOpSpec({ op: "removeIslands", connectivity: "point", minCells: 3.7, dryRun: true })).toEqual({ op: "removeIslands", connectivity: "point", minCells: 3, dryRun: true });
    expect(validateMeshioOpSpec({ op: "thickness", probe: "cone", coneAngle: 20, twoSided: true, maxDistance: 5 })).toEqual({ op: "thickness", probe: "cone", coneAngle: 20, twoSided: true, maxDistance: 5 });
    expect(validateMeshioOpSpec({ op: "thickness", probe: "laser" })).toEqual({ op: "thickness" });
    expect(validateMeshioOpSpec({ op: "flipNormals", region: "top" })).toEqual({ op: "flipNormals", region: "top" });
  });

  it("validates the 20.1 adaptVolume parameters", () => {
    expect(validateMeshioOpSpec({ op: "adaptVolume" })).toEqual({ op: "adaptVolume" });
    expect(validateMeshioOpSpec({
      op: "adaptVolume", hmin: 0.1, hmax: 2, hausd: 0.05, hausdRelative: true, boundarySizing: "geometry",
      qualityMetric: "amips", qualityMin: 0.2, maxIterations: 30.9, targetMinDihedral: 15,
      sizeArray: "size", curvatureSizing: true, featureAngle: 45, cornerAngle: 60, maxNormalDeviation: 20,
      preserveBoundary: false, preserveFeatures: true, collapse: false, split: true, swap: true, smooth: true,
    })).toEqual({
      op: "adaptVolume", hmin: 0.1, hmax: 2, hausd: 0.05, hausdRelative: true, boundarySizing: "geometry",
      qualityMetric: "amips", qualityMin: 0.2, maxIterations: 30, targetMinDihedral: 15,
      sizeArray: "size", curvatureSizing: true, featureAngle: 45, cornerAngle: 60, maxNormalDeviation: 20,
      preserveBoundary: false, preserveFeatures: true, collapse: false, split: true, swap: true, smooth: true,
    });
    // A zero Hausdorff bound is no bound: refused, like adapt.
    expect(validateMeshioOpSpec({ op: "adaptVolume", hausd: 0 })).toBeNull();
    // Size bounds, angles and enum strings are dropped when malformed, never fatal.
    expect(validateMeshioOpSpec({
      op: "adaptVolume", hmin: 0, hmax: -2, qualityMetric: "max_dihedral", boundarySizing: "auto",
      hausdRelative: "yes", targetMinDihedral: 95, featureAngle: 200, cornerAngle: -1, maxNormalDeviation: 91,
    })).toEqual({ op: "adaptVolume" });
  });
});
