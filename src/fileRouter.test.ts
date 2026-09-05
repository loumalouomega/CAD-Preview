import { describe, it, expect } from "vitest";
import { routeFile, MESHIO_FORMATS, AMBIGUOUS_MESHIO_EXTENSIONS, ambiguityCaveatFor, matchExtension } from "./fileRouter";

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

  it("routes OpenSCAD .csg to the occt strategy (parsed + built kernel-side, opaque base)", () => {
    expect(routeFile("model.csg")).toEqual({ strategy: "occt", format: "csg" });
    expect(routeFile("/abs/path/MODEL.CSG")).toEqual({ strategy: "occt", format: "csg" });
  });

  it("routes OpenFOAM case marker files to the meshio strategy", () => {
    expect(routeFile("case.foam")).toEqual({ strategy: "meshio", format: "openfoam" });
  });

  describe("compound extensions (GiD's .post.msh)", () => {
    it("routes .post.msh to gid, NOT to gmsh via its .msh tail", () => {
      // The whole reason routeFile matches the longest suffix first: `.msh`
      // alone is registered to gmsh, so a last-dot-only lookup silently
      // resolved every GiD file to a Gmsh parse that then failed.
      expect(routeFile("beam.post.msh")).toEqual({ strategy: "meshio", format: "gid" });
      expect(routeFile("/abs/path/beam.post.msh")).toEqual({ strategy: "meshio", format: "gid" });
      expect(routeFile("BEAM.POST.MSH")).toEqual({ strategy: "meshio", format: "gid" });
    });

    it("still routes a plain .msh to gmsh", () => {
      expect(routeFile("beam.msh")).toEqual({ strategy: "meshio", format: "gmsh" });
    });

    it("does NOT route the .post.res results sibling — it is not an openable document", () => {
      expect(routeFile("beam.post.res")).toBeUndefined();
    });

    it("does not claim the binary/hdf5 GiD flavours, which have no verified fixture here", () => {
      expect(routeFile("beam.post.bin")).toBeUndefined();
      expect(routeFile("beam.post.h5")).toBeUndefined();
    });
  });

  describe("longest-suffix matching is behavior-preserving for single-extension paths", () => {
    it("resolves an unregistered leading segment by falling through to the final extension", () => {
      expect(routeFile("my.backup.stl")).toEqual({ strategy: "three", format: "stl" });
      expect(routeFile("v1.2.3.step")).toEqual({ strategy: "occt", format: "step" });
    });

    it("ignores dots in directory components", () => {
      expect(routeFile("/my.dir/model.stl")).toEqual({ strategy: "three", format: "stl" });
      expect(routeFile("/my.dir/model")).toBeUndefined();
    });

    it("returns undefined for a trailing dot", () => {
      expect(routeFile("model.")).toBeUndefined();
      expect(routeFile("a.model.")).toBeUndefined();
    });
  });

  describe("matchExtension", () => {
    it("returns the registered key the route matched, longest suffix first", () => {
      expect(matchExtension("beam.post.msh")).toBe("post.msh");
      expect(matchExtension("beam.msh")).toBe("msh");
      expect(matchExtension("my.backup.stl")).toBe("stl");
    });

    it("returns undefined when nothing is registered", () => {
      expect(matchExtension("notes.txt")).toBeUndefined();
      expect(matchExtension("noextension")).toBeUndefined();
    });
  });

  describe("ambiguityCaveatFor", () => {
    it("reports the caveat for a genuinely ambiguous extension", () => {
      expect(ambiguityCaveatFor("m.msh")).toContain("Gmsh");
      expect(ambiguityCaveatFor("m.inp")).toContain("Abaqus");
    });

    it("does NOT hand .msh's caveat to a .post.msh — it routes to gid, not gmsh", () => {
      expect(ambiguityCaveatFor("beam.post.msh")).toBeUndefined();
    });

    it("returns undefined for an unambiguous or unsupported extension", () => {
      expect(ambiguityCaveatFor("m.stl")).toBeUndefined();
      expect(ambiguityCaveatFor("notes.txt")).toBeUndefined();
    });
  });

  it("MESHIO_FORMATS lists exactly the formats EXTENSION_MAP routes to the meshio strategy, with no duplicates", () => {
    const formatsInMap = new Set<string>();
    for (const ext of ["vtk", "vtu", "med", "cgns", "exo", "e", "xdmf", "mdpa", "foam", "msh", "msh2", "inp", "unv", "su2", "mesh", "post.msh"]) {
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
