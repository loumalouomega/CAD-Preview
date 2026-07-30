import { describe, it, expect } from "vitest";
import {
  parseMeshJson,
  serializeMeshJson,
  generateGeoScript,
  MESH_SIDECAR_VERSION,
} from "./meshOptionsSidecar";
import { DEFAULT_MESH_OPTIONS, type MeshOptions } from "./meshOptions";

describe("parseMeshJson", () => {
  it("parses a well-formed sidecar", () => {
    const options: MeshOptions = {
      dimension: 2,
      sizeMin: 0.5,
      sizeMax: 5,
      algorithm2D: 5,
      algorithm3D: 1,
      elementOrder: 2,
      elementShape: "subdivided",
      optimize: false,
      stlAngle: 25,
    };
    const text = JSON.stringify({ version: 1, source: "bull.stp", options });
    expect(parseMeshJson(text)).toEqual(options);
  });

  it("falls back to DEFAULT_MESH_OPTIONS for invalid JSON", () => {
    expect(parseMeshJson("not json")).toEqual(DEFAULT_MESH_OPTIONS);
  });

  it("falls back to DEFAULT_MESH_OPTIONS when options field is missing or not an object", () => {
    expect(parseMeshJson("{}")).toEqual(DEFAULT_MESH_OPTIONS);
    expect(parseMeshJson(JSON.stringify({ options: "nope" }))).toEqual(DEFAULT_MESH_OPTIONS);
    expect(parseMeshJson(JSON.stringify({ options: null }))).toEqual(DEFAULT_MESH_OPTIONS);
  });

  it("clamps/defaults out-of-range fields instead of dropping the whole object", () => {
    const text = JSON.stringify({
      version: 1,
      source: "cube.stl",
      options: { dimension: 99, sizeMin: 1, sizeMax: 2, elementOrder: 1, optimize: true, stlAngle: 20, algorithm2D: 6, algorithm3D: 4 },
    });
    const result = parseMeshJson(text);
    expect(result.dimension).toBe(DEFAULT_MESH_OPTIONS.dimension);
    expect(result.sizeMin).toBe(1);
    expect(result.sizeMax).toBe(2);
  });
});

describe("serializeMeshJson", () => {
  it("round-trips through parseMeshJson and stamps version + source", () => {
    const options: MeshOptions = { ...DEFAULT_MESH_OPTIONS, stlAngle: 20 };
    const text = serializeMeshJson("model.step", options);
    const obj = JSON.parse(text);
    expect(obj.version).toBe(MESH_SIDECAR_VERSION);
    expect(obj.source).toBe("model.step");
    expect(obj.options).toEqual(options);
    expect(parseMeshJson(text)).toEqual(options);
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("generateGeoScript", () => {
  it("contains the Merge, Mesh.* option lines, and trailing Mesh <dimension>; command", () => {
    const options: MeshOptions = {
      dimension: 2,
      sizeMin: 0.1,
      sizeMax: 10,
      algorithm2D: 6,
      algorithm3D: 4,
      elementOrder: 1,
      elementShape: "simplex",
      optimize: true,
      stlAngle: 40,
    };
    const script = generateGeoScript("bull.stp", options);

    expect(script).toContain('Merge "bull.stp";');
    expect(script).toContain("Mesh.MeshSizeMin = 0.1;");
    expect(script).toContain("Mesh.MeshSizeMax = 10;");
    expect(script).toContain("Mesh.Algorithm = 6;");
    expect(script).toContain("Mesh.Algorithm3D = 4;");
    expect(script).toContain("Mesh.ElementOrder = 1;");
    expect(script).toContain("Mesh.RecombineAll = 0;");
    expect(script).toContain("Mesh.SubdivisionAlgorithm = 0;");
    expect(script).toContain("Mesh.Optimize = 1;");
    expect(script.trim().endsWith("Mesh 2;")).toBe(true);
  });

  it("emits Blossom recombination for a 2D subdivided (quad) mesh", () => {
    const script = generateGeoScript("bull.stp", { ...DEFAULT_MESH_OPTIONS, dimension: 2, elementShape: "subdivided" });
    expect(script).toContain("Mesh.RecombineAll = 1;");
    expect(script).toContain("Mesh.SubdivisionAlgorithm = 0;");
  });

  it("emits hex subdivision for a 3D subdivided mesh", () => {
    const script = generateGeoScript("bull.stp", { ...DEFAULT_MESH_OPTIONS, dimension: 3, elementShape: "subdivided" });
    expect(script).toContain("Mesh.RecombineAll = 0;");
    expect(script).toContain("Mesh.SubdivisionAlgorithm = 2;");
  });

  it("emits the RTree recombiner and overrides Algorithm3D to 9 for a hex-dominant mesh", () => {
    const script = generateGeoScript("bull.stp", {
      ...DEFAULT_MESH_OPTIONS,
      dimension: 3,
      elementShape: "hexDominant",
      algorithm3D: 1,
    });
    expect(script).toContain("Mesh.Algorithm3D = 9;");
    expect(script).toContain("Mesh.Recombine3DAll = 1;");
  });

  it("hexDominant outside 3D degrades to a plain simplex mesh, algorithm3D unchanged", () => {
    const script = generateGeoScript("bull.stp", {
      ...DEFAULT_MESH_OPTIONS,
      dimension: 2,
      elementShape: "hexDominant",
      algorithm3D: 1,
    });
    expect(script).toContain("Mesh.Algorithm3D = 1;");
    expect(script).toContain("Mesh.Recombine3DAll = 0;");
  });

  it("encodes optimize=false as 0", () => {
    const options: MeshOptions = { ...DEFAULT_MESH_OPTIONS, optimize: false };
    const script = generateGeoScript("cube.stl", options);
    expect(script).toContain("Mesh.Optimize = 0;");
  });

  it("uses the given dimension in the trailing Mesh command", () => {
    const script3d = generateGeoScript("cube.stl", { ...DEFAULT_MESH_OPTIONS, dimension: 3 });
    expect(script3d.trim().endsWith("Mesh 3;")).toBe(true);
    const script1d = generateGeoScript("cube.stl", { ...DEFAULT_MESH_OPTIONS, dimension: 1 });
    expect(script1d.trim().endsWith("Mesh 1;")).toBe(true);
  });
});
