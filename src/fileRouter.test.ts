import { describe, it, expect } from "vitest";
import { routeFile, MESHIO_FORMATS, AMBIGUOUS_MESHIO_EXTENSIONS } from "./fileRouter";

describe("routeFile", () => {
  it("routes STEP files to the OCCT strategy", () => {
    expect(routeFile("/path/to/model.step")).toEqual({ strategy: "occt", format: "step" });
    expect(routeFile("model.stp")).toEqual({ strategy: "occt", format: "step" });
  });

  it("routes IGES files to the OCCT strategy", () => {
    expect(routeFile("a.iges")).toEqual({ strategy: "occt", format: "iges" });
    expect(routeFile("a.igs")).toEqual({ strategy: "occt", format: "iges" });
  });

  it("routes BREP files to the OCCT strategy", () => {
    expect(routeFile("part.brep")).toEqual({ strategy: "occt", format: "brep" });
  });

  it("routes mesh files to the Three.js strategy", () => {
    expect(routeFile("m.stl")).toEqual({ strategy: "three", format: "stl" });
    expect(routeFile("m.obj")).toEqual({ strategy: "three", format: "obj" });
    expect(routeFile("m.ply")).toEqual({ strategy: "three", format: "ply" });
    expect(routeFile("m.gltf")).toEqual({ strategy: "three", format: "gltf" });
    expect(routeFile("m.glb")).toEqual({ strategy: "three", format: "gltf" });
  });

  it("is case-insensitive", () => {
    expect(routeFile("MODEL.STP")).toEqual({ strategy: "occt", format: "step" });
    expect(routeFile("Mesh.STL")).toEqual({ strategy: "three", format: "stl" });
  });

  it("returns undefined for unsupported extensions", () => {
    expect(routeFile("notes.txt")).toBeUndefined();
    expect(routeFile("noextension")).toBeUndefined();
  });

  it("routes the original 7 meshio++ bridge formats", () => {
    expect(routeFile("m.vtk")).toEqual({ strategy: "meshio", format: "vtk" });
    expect(routeFile("m.vtu")).toEqual({ strategy: "meshio", format: "vtu" });
    expect(routeFile("m.med")).toEqual({ strategy: "meshio", format: "med" });
    expect(routeFile("m.cgns")).toEqual({ strategy: "meshio", format: "cgns" });
    expect(routeFile("m.exo")).toEqual({ strategy: "meshio", format: "exodus" });
    expect(routeFile("m.e")).toEqual({ strategy: "meshio", format: "exodus" });
    expect(routeFile("m.xdmf")).toEqual({ strategy: "meshio", format: "xdmf" });
    expect(routeFile("m.mdpa")).toEqual({ strategy: "meshio", format: "mdpa" });
  });

  it("routes the 5 new meshio++ bridge formats that close the FE Mesh panel's export/import asymmetry", () => {
    expect(routeFile("m.msh")).toEqual({ strategy: "meshio", format: "gmsh" });
    expect(routeFile("m.msh2")).toEqual({ strategy: "meshio", format: "gmsh" });
    expect(routeFile("m.inp")).toEqual({ strategy: "meshio", format: "abaqus" });
    expect(routeFile("m.unv")).toEqual({ strategy: "meshio", format: "unv" });
    expect(routeFile("m.su2")).toEqual({ strategy: "meshio", format: "su2" });
    expect(routeFile("m.mesh")).toEqual({ strategy: "meshio", format: "medit" });
  });

  it("does NOT claim .bdf or .off as import formats — both were tried and rejected (see MESHIO_FORMATS' doc comment)", () => {
    expect(routeFile("m.bdf")).toBeUndefined();
    expect(routeFile("m.off")).toBeUndefined();
  });

  it("routes OpenFOAM case marker files to the meshio strategy", () => {
    expect(routeFile("case.foam")).toEqual({ strategy: "meshio", format: "openfoam" });
  });

  it("MESHIO_FORMATS lists exactly the formats EXTENSION_MAP routes to the meshio strategy, with no duplicates", () => {
    const formatsInMap = new Set<string>();
    for (const ext of ["vtk", "vtu", "med", "cgns", "exo", "e", "xdmf", "mdpa", "foam", "msh", "msh2", "inp", "unv", "su2", "mesh"]) {
      const route = routeFile(`x.${ext}`);
      if (route?.strategy === "meshio") formatsInMap.add(route.format);
    }
    expect(new Set(MESHIO_FORMATS)).toEqual(formatsInMap);
    expect(new Set(MESHIO_FORMATS).size).toBe(MESHIO_FORMATS.length);
  });

  it("AMBIGUOUS_MESHIO_EXTENSIONS names exactly msh and inp, each with a non-empty caveat", () => {
    expect(new Set(AMBIGUOUS_MESHIO_EXTENSIONS.keys())).toEqual(new Set(["msh", "inp"]));
    for (const message of AMBIGUOUS_MESHIO_EXTENSIONS.values()) {
      expect(message.length).toBeGreaterThan(0);
    }
  });
});
