import { describe, it, expect } from "vitest";
import { routeFile } from "./fileRouter";

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
});
