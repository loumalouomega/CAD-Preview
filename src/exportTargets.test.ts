import { describe, it, expect } from "vitest";
import { exportTargetsFor, EXPORT_EXTENSION, UNIT_CONVERTIBLE_FORMATS } from "./exportTargets";

describe("exportTargetsFor", () => {
  it("offers the other B-rep formats plus all mesh formats for a STEP source", () => {
    expect(exportTargetsFor({ strategy: "occt", format: "step" })).toEqual([
      "iges",
      "brep",
      "stl",
      "obj",
      "ply",
      "gltf",
    ]);
  });

  it("offers the other B-rep formats plus all mesh formats for an IGES source", () => {
    expect(exportTargetsFor({ strategy: "occt", format: "iges" })).toEqual([
      "step",
      "brep",
      "stl",
      "obj",
      "ply",
      "gltf",
    ]);
  });

  it("offers the other B-rep formats plus all mesh formats for a BREP source", () => {
    expect(exportTargetsFor({ strategy: "occt", format: "brep" })).toEqual([
      "step",
      "iges",
      "stl",
      "obj",
      "ply",
      "gltf",
    ]);
  });

  it("offers all three B-rep formats plus all mesh formats for a CSG source (import-only — never itself)", () => {
    expect(exportTargetsFor({ strategy: "occt", format: "csg" })).toEqual([
      "step",
      "iges",
      "brep",
      "stl",
      "obj",
      "ply",
      "gltf",
    ]);
  });

  it("offers only the other mesh formats for a mesh source", () => {
    expect(exportTargetsFor({ strategy: "three", format: "stl" })).toEqual(["obj", "ply", "gltf"]);
    expect(exportTargetsFor({ strategy: "three", format: "obj" })).toEqual(["stl", "ply", "gltf"]);
    expect(exportTargetsFor({ strategy: "three", format: "ply" })).toEqual(["stl", "obj", "gltf"]);
    expect(exportTargetsFor({ strategy: "three", format: "gltf" })).toEqual(["stl", "obj", "ply"]);
  });
});

describe("UNIT_CONVERTIBLE_FORMATS", () => {
  it("includes STEP and IGES — both now have a verified way to set their header unit on write", () => {
    expect(UNIT_CONVERTIBLE_FORMATS.has("step")).toBe(true);
    expect(UNIT_CONVERTIBLE_FORMATS.has("iges")).toBe(true);
  });

  it("includes brep and every mesh export target", () => {
    expect(UNIT_CONVERTIBLE_FORMATS.has("brep")).toBe(true);
    expect(UNIT_CONVERTIBLE_FORMATS.has("stl")).toBe(true);
    expect(UNIT_CONVERTIBLE_FORMATS.has("obj")).toBe(true);
    expect(UNIT_CONVERTIBLE_FORMATS.has("ply")).toBe(true);
    expect(UNIT_CONVERTIBLE_FORMATS.has("gltf")).toBe(true);
  });
});

describe("EXPORT_EXTENSION", () => {
  it("maps glTF export to the binary .glb extension", () => {
    expect(EXPORT_EXTENSION.gltf).toBe("glb");
  });

  it("maps every other format to its own extension", () => {
    expect(EXPORT_EXTENSION.step).toBe("step");
    expect(EXPORT_EXTENSION.iges).toBe("iges");
    expect(EXPORT_EXTENSION.brep).toBe("brep");
    expect(EXPORT_EXTENSION.stl).toBe("stl");
    expect(EXPORT_EXTENSION.obj).toBe("obj");
    expect(EXPORT_EXTENSION.ply).toBe("ply");
  });
});
