import { describe, it, expect } from "vitest";
import { meshCadSurfaceModel, MESH_CAD_SURFACE_FORMATS, buildMeshCadCall, summarizeMeshCad, MAX_DETAIL_LISTED, type RawMeshCadResult } from "./meshCadSurface";

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

describe("buildMeshCadCall", () => {
  it("keeps a default call byte-identical to what 17.13 received", () => {
    const { call, order, warnings } = buildMeshCadCall({ targetSize: 2 }, "stl", ".stl");
    expect(call).toEqual({ targetSize: 2, edges: true, maxPoints: 5_000_000 });
    expect(Object.keys(call)).toEqual(["targetSize", "edges", "maxPoints"]);
    expect(order).toBe(1);
    expect(warnings).toEqual([]);
  });

  it("forwards only the options that were given, under meshio++'s own names", () => {
    const { call } = buildMeshCadCall(
      {
        targetSize: 1, minAngle: 25, smoothIterations: 3, smoothMethod: "odt", order: 2, grading: 1.3, curvatureDeviation: 0.05,
        cellsAcrossGaps: 2, poleRings: 2, faceSizes: { 0: 0.3 }, edgeSizes: { 4: 0.2 }, metric: "varying", virtualEdges: true,
        virtualFaces: false, modelTolerances: true, reparamConditionNumber: 0, lopCorners: true,
      },
      "gmsh",
      ".msh"
    );
    expect(call).toEqual({
      targetSize: 1, edges: true, maxPoints: 5_000_000, minAngle: 25, smoothIterations: 3, smoothMethod: "odt", order: 2, grading: 1.3,
      curvatureDeviation: 0.05, cellsAcrossGaps: 2, poleRings: 2, faceSizes: { "0": 0.3 }, edgeSizes: { "4": 0.2 }, metric: "varying",
      virtualEdges: true, virtualFaces: false, modelTolerances: true, reparamConditionNumber: 0, lopCorners: true,
    });
  });

  it("rejects out-of-range quality options by name", () => {
    const bad = (o: object, re: RegExp) => expect(() => buildMeshCadCall({ targetSize: 1, ...o } as never, "gmsh", ".msh")).toThrow(re);
    bad({ minAngle: 60 }, /minAngle must be below 60/);
    bad({ minAngle: -1 }, /minAngle/);
    bad({ smoothIterations: 1.5 }, /smoothIterations must be an integer/);
    bad({ smoothMethod: "x" }, /smoothMethod/);
    bad({ metric: "x" }, /metric/);
    bad({ order: 4 }, /order must be 1, 2 or 3/);
    bad({ grading: 1 }, /grading must be 0/);
    bad({ poleRings: 9 }, /poleRings must be an integer from 0 to 8/);
    bad({ faceSizes: { a: 1 } }, /faceSizes key "a"/);
    bad({ faceSizes: { 0: 0 } }, /faceSizes\[0\] must be a positive size/);
    bad({ edgeSizes: [1] }, /edgeSizes must be an object/);
    bad({ reparamConditionNumber: 1 }, /reparamConditionNumber must be 0 \(off\) or above 1/);
    bad({ quads: "x" }, /quads must be/);
    bad({ quadPairs: "x", quads: "dominant" }, /quadPairs must be/);
    bad({ quadPairs: "greedy" }, /quadPairs acts on the quad recombination/);
    bad({ quads: "all", virtualEdges: true }, /cannot be combined with virtualEdges/);
    bad({ untangle: true }, /untangle moves high-order nodes/);
    bad({ lopCorners: true }, /lopCorners acts on the minAngle refinement/);
  });

  it("forwards the 17.23 quad / untangle / curved-reparam options and refuses a writer without quads", () => {
    const { call } = buildMeshCadCall({ targetSize: 1, order: 2, untangle: true, quads: "dominant", quadPairs: "greedy", reparamConditionNumber: 5 }, "gmsh", ".msh");
    expect(call).toMatchObject({ order: 2, untangle: true, quads: "dominant", quadPairs: "greedy", reparamConditionNumber: 5 });
    expect(Object.keys(buildMeshCadCall({ targetSize: 1 }, "gmsh", ".msh").call)).toEqual(["targetSize", "edges", "maxPoints"]);
    expect(() => buildMeshCadCall({ targetSize: 1, quads: "all" }, "stl", ".stl")).toThrow(/quadrilateral cells.*got "\.stl"/);
    expect(buildMeshCadCall({ targetSize: 1, quads: "all" }, "obj", ".obj").call.quads).toBe("all");
  });

  it("refuses a curved order for a writer that cannot hold triangle6 / triangle10", () => {
    expect(() => buildMeshCadCall({ targetSize: 1, order: 2 }, "stl", ".stl")).toThrow(/only \.msh, \.vtk, \.vtu can hold \(got "\.stl"\)/);
    expect(() => buildMeshCadCall({ targetSize: 1, order: 3 }, "ply", ".ply")).toThrow(/order 3/);
    expect(buildMeshCadCall({ targetSize: 1, order: 3 }, "vtu", ".vtu").order).toBe(3);
    // the engine writes MSH itself and passes no extension
    expect(buildMeshCadCall({ targetSize: 1, order: 2, edges: false }, null).call.order).toBe(2);
  });

  it("drops the edge block for OBJ with a warning and honours edges:false silently", () => {
    const obj = buildMeshCadCall({ targetSize: 1 }, "obj", ".obj");
    expect(obj.call.edges).toBe(false);
    expect(obj.warnings[0]).toMatch(/OBJ holds no line cells/);
    expect(buildMeshCadCall({ targetSize: 1, edges: false }, "obj", ".obj").warnings).toEqual([]);
  });
});

describe("summarizeMeshCad", () => {
  const face = (over: Record<string, unknown>) => ({
    face: 0, id: 0, status: "ok", reason: "", numTriangles: 2, numInteriorPoints: 0, minAngleDeg: 40, maxAngleDeg: 80,
    numRefinementPoints: 0, numSmoothed: 0, belowBound: false, boundDeg: 0, corners: [], limitedByEdges: [], ...over,
  });
  const raw = (over: Record<string, unknown> = {}): RawMeshCadResult => ({
    mesh: { points: [], cells: [] },
    faces: [face({ face: 0 }), face({ face: 1, belowBound: true, boundDeg: 12, corners: [{}, {}] }), face({ face: 2, status: "open_loop", reason: "bad loop" })],
    warnings: ["refinement stopped after 16 rounds of boundary splits"],
    numPoints: 10, numTriangles: 6, numEdgeSegments: 0, numFaces: 3, numFailed: 1, numEdges: 9, numOpenEdges: 0, numNonManifoldEdges: 0,
    numMisorientedEdges: 0, numDegenerateDropped: 0, tolerance: 1e-7, minAngleDeg: 0.42, maxAngleDeg: 120, minEdge: 0.1, maxEdge: 2, maxEdgeGap: 0,
    numRefinementPoints: 653, numFacesBelowBound: 1, numSmoothed: 7, numCurvedStraightened: 3, angleHistogram: [1, 2, 3],
    virtualEdges: [[1, 2]], reparametrised: [], mergedFaces: [], toleranceUses: [], loppedCorners: [],
    ...over,
  });

  it("lists failures first, then faces below the angle bound, and carries the new per-face facts", () => {
    const r = summarizeMeshCad(raw(), 1, []);
    expect(r.faces.map((f) => f.face)).toEqual([2, 1, 0]);
    expect(r.faces[1]).toMatchObject({ belowBound: true, boundDeg: 12, cornerCount: 2 });
    expect(r.numRefinementPoints).toBe(653);
    expect(r.numFacesBelowBound).toBe(1);
    expect(r.numSmoothed).toBe(7);
    expect(r.angleHistogram).toEqual([1, 2, 3]);
    expect(r.virtualEdges).toEqual([[1, 2]]);
  });

  it("turns missed bounds, straightened elements and failures into warnings, keeping upstream's verbatim", () => {
    const w = summarizeMeshCad(raw(), 1, ["pre"]).warnings;
    expect(w[0]).toBe("pre");
    expect(w).toContain("refinement stopped after 16 rounds of boundary splits");
    expect(w.some((x) => /1 of 3 faces could not be meshed/.test(x))).toBe(true);
    expect(w.some((x) => /1 face\(s\) could not reach the requested minAngle.*0\.42°/.test(x))).toBe(true);
    expect(w.some((x) => /3 curved element\(s\).*kept straight-sided/.test(x))).toBe(true);
  });

  it("caps each detail list and says so", () => {
    const many = Array.from({ length: MAX_DETAIL_LISTED + 5 }, (_, i) => ({ face: i }));
    const r = summarizeMeshCad(raw({ loppedCorners: many }), 1, []);
    expect(r.loppedCorners).toHaveLength(MAX_DETAIL_LISTED);
    expect(r.detailTruncated).toBe(true);
    expect(r.warnings.some((x) => /Detail lists capped/.test(x))).toBe(true);
    expect(summarizeMeshCad(raw(), 1, []).detailTruncated).toBe(false);
  });

  it("is stable on a result with none of the 17.14+ fields (an older build)", () => {
    const old = raw();
    for (const k of ["numRefinementPoints", "numFacesBelowBound", "numSmoothed", "numCurvedStraightened", "angleHistogram", "virtualEdges", "reparametrised", "mergedFaces", "toleranceUses", "loppedCorners"]) delete old[k];
    old.faces = [{ face: 0, id: 0, status: "ok", reason: "", numTriangles: 2, numInteriorPoints: 0, minAngleDeg: 40, maxAngleDeg: 80 }];
    const r = summarizeMeshCad(old, 1, []);
    expect(r.numRefinementPoints).toBe(0);
    expect(r.angleHistogram).toEqual([]);
    expect(r.faces[0]).toMatchObject({ belowBound: false, cornerCount: 0, limitedByEdges: [] });
  });
});
