import { describe, it, expect } from "vitest";
import { exportTargetsFor, EXPORT_EXTENSION, EXPORT_LABEL, MESH_SAVE_IN_PLACE_FORMATS, BREP_SAVE_IN_PLACE_FORMATS, SAVE_IN_PLACE_FORMATS, UNIT_CONVERTIBLE_FORMATS } from "./exportTargets";

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

describe("Collada as an import-only, display-only mesh format", () => {
  it("offers every mesh export format for a .dae source, with no save-in-place", () => {
    const all = ["stl", "obj", "ply", "gltf", "3mf"];
    expect(exportTargetsFor({ strategy: "three", format: "dae" })).toEqual(all);
    expect(exportTargetsFor({ strategy: "three", format: "dae" }, true)).toEqual(all);
    expect(MESH_SAVE_IN_PLACE_FORMATS.has("dae")).toBe(false);
  });

  it("is never an export target for any other source (there is no Collada writer)", () => {
    for (const route of [
      { strategy: "occt", format: "step" },
      { strategy: "three", format: "stl" },
      { strategy: "three", format: "3mf" },
    ] as const) {
      expect(exportTargetsFor(route, true)).not.toContain("dae");
    }
    expect(UNIT_CONVERTIBLE_FORMATS.has("dae")).toBe(false);
  });
});

describe("SAVE_IN_PLACE_FORMATS", () => {
  it("covers exactly the formats with a same-format writer", () => {
    expect([...SAVE_IN_PLACE_FORMATS].sort()).toEqual(["brep", "iges", "obj", "ply", "step", "stl"]);
    expect([...BREP_SAVE_IN_PLACE_FORMATS].sort()).toEqual(["brep", "iges", "step"]);
  });

  it("excludes glTF, meshio, 3MF and CAD-text sources", () => {
    for (const format of ["gltf", "3mf", "vtk", "med", "csg", "scad"] as const) {
      expect(SAVE_IN_PLACE_FORMATS.has(format)).toBe(false);
    }
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

describe("AMF as an import-only, display-only mesh format", () => {
  it("offers every mesh export format for an .amf source, with no save-in-place", () => {
    const all = ["stl", "obj", "ply", "gltf", "3mf"];
    expect(exportTargetsFor({ strategy: "three", format: "amf" })).toEqual(all);
    expect(exportTargetsFor({ strategy: "three", format: "amf" }, true)).toEqual(all);
    expect(MESH_SAVE_IN_PLACE_FORMATS.has("amf")).toBe(false);
  });

  it("is never an export target for any other source (there is no AMF writer)", () => {
    for (const route of [
      { strategy: "occt", format: "step" },
      { strategy: "three", format: "stl" },
      { strategy: "three", format: "3mf" },
      { strategy: "three", format: "dae" },
    ] as const) {
      expect(exportTargetsFor(route, true)).not.toContain("amf");
    }
    expect(UNIT_CONVERTIBLE_FORMATS.has("amf")).toBe(false);
  });
});

describe("FBX as an import-only, display-only mesh format", () => {
  it("offers every mesh export format for an FBX source, with no save-in-place", () => {
    const all = ["stl", "obj", "ply", "gltf", "3mf"];
    expect(exportTargetsFor({ strategy: "three", format: "fbx" })).toEqual(all);
    expect(exportTargetsFor({ strategy: "three", format: "fbx" }, true)).toEqual(all);
    expect(MESH_SAVE_IN_PLACE_FORMATS.has("fbx")).toBe(false);
  });

  it("is never an export target for any other source (there is no FBX writer)", () => {
    for (const route of [
      { strategy: "occt", format: "step" },
      { strategy: "three", format: "stl" },
      { strategy: "three", format: "wrl" },
    ] as const) {
      expect(exportTargetsFor(route, true)).not.toContain("fbx");
    }
    expect(UNIT_CONVERTIBLE_FORMATS.has("fbx")).toBe(false);
  });
});

describe("VRML as an import-only, display-only mesh format", () => {
  it("offers every mesh export format for a VRML source, with no save-in-place", () => {
    const all = ["stl", "obj", "ply", "gltf", "3mf"];
    expect(exportTargetsFor({ strategy: "three", format: "wrl" })).toEqual(all);
    expect(exportTargetsFor({ strategy: "three", format: "wrl" }, true)).toEqual(all);
    expect(MESH_SAVE_IN_PLACE_FORMATS.has("wrl")).toBe(false);
  });

  it("is never an export target for any other source (there is no VRML writer)", () => {
    for (const route of [
      { strategy: "occt", format: "step" },
      { strategy: "three", format: "stl" },
      { strategy: "three", format: "usd" },
    ] as const) {
      expect(exportTargetsFor(route, true)).not.toContain("wrl");
    }
    expect(UNIT_CONVERTIBLE_FORMATS.has("wrl")).toBe(false);
  });
});

describe("USD as an import-only, display-only mesh format", () => {
  it("offers every mesh export format for a USD source, with no save-in-place", () => {
    const all = ["stl", "obj", "ply", "gltf", "3mf"];
    expect(exportTargetsFor({ strategy: "three", format: "usd" })).toEqual(all);
    expect(exportTargetsFor({ strategy: "three", format: "usd" }, true)).toEqual(all);
    expect(MESH_SAVE_IN_PLACE_FORMATS.has("usd")).toBe(false);
  });

  it("is never an export target for any other source (there is no USD writer)", () => {
    for (const route of [
      { strategy: "occt", format: "step" },
      { strategy: "three", format: "stl" },
      { strategy: "three", format: "amf" },
    ] as const) {
      expect(exportTargetsFor(route, true)).not.toContain("usd");
    }
    expect(UNIT_CONVERTIBLE_FORMATS.has("usd")).toBe(false);
  });
});
