import { describe, it, expect } from "vitest";
import { exportTargetsFor, EXPORT_EXTENSION, EXPORT_LABEL, MESH_SAVE_IN_PLACE_FORMATS, UNIT_CONVERTIBLE_FORMATS } from "./exportTargets";

describe("exportTargetsFor", () => {
  it("offers the other B-rep formats plus all mesh formats for a STEP source", () => {
    expect(exportTargetsFor({ strategy: "occt", format: "step" })).toEqual([
      "iges",
      "brep",
      "stl",
      "obj",
      "ply",
      "gltf",
      "3mf",
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
      "3mf",
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
      "3mf",
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
      "3mf",
    ]);
  });

  it("offers only the other mesh formats for a mesh source", () => {
    expect(exportTargetsFor({ strategy: "three", format: "stl" })).toEqual(["obj", "ply", "gltf", "3mf"]);
    expect(exportTargetsFor({ strategy: "three", format: "obj" })).toEqual(["stl", "ply", "gltf", "3mf"]);
    expect(exportTargetsFor({ strategy: "three", format: "ply" })).toEqual(["stl", "obj", "gltf", "3mf"]);
    expect(exportTargetsFor({ strategy: "three", format: "gltf" })).toEqual(["stl", "obj", "ply", "3mf"]);
  });

  it("offers the source's own B-rep format first when allowSameFormat is set (Tier 0 Phase 1)", () => {
    expect(exportTargetsFor({ strategy: "occt", format: "step" }, true)).toEqual([
      "step",
      "iges",
      "brep",
      "stl",
      "obj",
      "ply",
      "gltf",
      "3mf",
    ]);
    expect(exportTargetsFor({ strategy: "occt", format: "brep" }, true)[0]).toBe("brep");
  });

  it("offers the source's own mesh format first for STL/OBJ/PLY when allowSameFormat is set (Tier 0 Phase 3)", () => {
    expect(exportTargetsFor({ strategy: "three", format: "stl" }, true)).toEqual(["stl", "obj", "ply", "gltf", "3mf"]);
    expect(exportTargetsFor({ strategy: "three", format: "obj" }, true)).toEqual(["obj", "stl", "ply", "gltf", "3mf"]);
    expect(exportTargetsFor({ strategy: "three", format: "ply" }, true)).toEqual(["ply", "stl", "obj", "gltf", "3mf"]);
  });

  it("keeps the glTF exclusion even with allowSameFormat (exporter only emits binary .glb)", () => {
    expect(exportTargetsFor({ strategy: "three", format: "gltf" }, true)).toEqual(["stl", "obj", "ply", "3mf"]);
  });
});

describe("3MF as a display-only mesh format", () => {
  it("offers the other mesh formats (not itself) for a 3MF source, with no save-in-place", () => {
    expect(exportTargetsFor({ strategy: "three", format: "3mf" })).toEqual(["stl", "obj", "ply", "gltf"]);
    expect(exportTargetsFor({ strategy: "three", format: "3mf" }, true)).toEqual(["stl", "obj", "ply", "gltf"]);
    expect(MESH_SAVE_IN_PLACE_FORMATS.has("3mf")).toBe(false);
  });

  it("is an export target for every B-rep and other mesh source, with its own extension and label", () => {
    expect(EXPORT_EXTENSION["3mf"]).toBe("3mf");
    expect(EXPORT_LABEL["3mf"]).toBe("3MF");
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
    expect(UNIT_CONVERTIBLE_FORMATS.has("3mf")).toBe(true);
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
