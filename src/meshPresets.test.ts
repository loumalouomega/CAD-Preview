import { describe, it, expect } from "vitest";
import {
  parseMeshPresetsJson,
  serializeMeshPresetsJson,
  mergePresetLibraries,
  inapplicablePresetFields,
  effectivePresetOptions,
  MESH_PRESET_LIBRARY_VERSION,
  type MeshPreset,
} from "./meshPresets";
import { DEFAULT_MESH_OPTIONS } from "./meshOptions";

const gmshPreset: MeshPreset = {
  name: "balanced",
  description: "Everyday Gmsh tetrahedral mesh",
  unit: "mm",
  engine: "gmsh",
  options: { ...DEFAULT_MESH_OPTIONS, sizeMax: 2, elementOrder: 2 },
};

describe("parseMeshPresetsJson", () => {
  it("parses a well-formed library", () => {
    const text = JSON.stringify({ version: 1, presets: { balanced: gmshPreset } });
    expect(parseMeshPresetsJson(text)).toEqual({ balanced: gmshPreset });
  });

  it("returns {} for invalid JSON or a missing presets field", () => {
    expect(parseMeshPresetsJson("not json")).toEqual({});
    expect(parseMeshPresetsJson("{}")).toEqual({});
    expect(parseMeshPresetsJson(JSON.stringify({ presets: [] }))).toEqual({});
  });

  it("drops a nameless entry and an entry with non-object options, keeping the rest", () => {
    const text = JSON.stringify({
      version: 1,
      presets: {
        ok: { ...gmshPreset, name: "ok" },
        "  ": { ...gmshPreset, name: "  " },
        noopts: { name: "noopts", unit: "mm", engine: "gmsh" },
        stringopts: { name: "stringopts", options: "coarse" },
      },
    });
    expect(Object.keys(parseMeshPresetsJson(text))).toEqual(["ok"]);
  });

  it("falls back unit/engine per-field rather than dropping the entry", () => {
    const text = JSON.stringify({
      version: 1,
      presets: {
        weird: { name: "weird", unit: "furlongs", engine: "tetgen", options: { sizeMax: 3 } },
      },
    });
    const lib = parseMeshPresetsJson(text);
    expect(lib.weird.unit).toBe("mm");
    expect(lib.weird.engine).toBe("gmsh");
    expect(lib.weird.options.sizeMax).toBe(3);
  });

  it("prefers the entry's own name field over its object key", () => {
    const text = JSON.stringify({
      version: 1,
      presets: { key: { ...gmshPreset, name: "field" } },
    });
    expect(Object.keys(parseMeshPresetsJson(text))).toEqual(["field"]);
  });

  it("round-trips through serialize → parse", () => {
    const lib = { balanced: gmshPreset };
    expect(parseMeshPresetsJson(serializeMeshPresetsJson(lib))).toEqual(lib);
  });

  it("serializes with the version", () => {
    const file = JSON.parse(serializeMeshPresetsJson({}));
    expect(file.version).toBe(MESH_PRESET_LIBRARY_VERSION);
  });
});

describe("mergePresetLibraries", () => {
  it("unions bundled and user entries, caller winning collisions", () => {
    const bundled = { a: { ...gmshPreset, name: "a" }, b: { ...gmshPreset, name: "b" } };
    const user = { b: { ...gmshPreset, name: "b", description: "mine" }, c: { ...gmshPreset, name: "c" } };
    const { merged, collisions } = mergePresetLibraries(bundled, user);
    expect(Object.keys(merged).sort()).toEqual(["a", "b", "c"]);
    expect(merged.b.description).toBe("mine");
    expect(collisions).toEqual(["b"]);
  });
});

describe("inapplicablePresetFields", () => {
  it("lists non-default Gmsh-only fields under fTetWild", () => {
    const preset: MeshPreset = {
      ...gmshPreset,
      name: "robust",
      engine: "ftetwild",
      options: { ...DEFAULT_MESH_OPTIONS, elementOrder: 2, sizeMax: 2 },
    };
    // elementOrder is Gmsh-only and non-default → listed; sizeMax applies to
    // both engines (it drives fTetWild's idealEdgeLengthRel) → not listed.
    expect(inapplicablePresetFields(preset)).toEqual(["elementOrder"]);
  });

  it("lists non-default fTetWild-only fields under Gmsh", () => {
    const preset: MeshPreset = {
      ...gmshPreset,
      options: { ...DEFAULT_MESH_OPTIONS, ftetwildCoarsen: true },
    };
    expect(inapplicablePresetFields(preset)).toEqual(["ftetwildCoarsen"]);
  });

  it("is silent when every engine-foreign field is at its default", () => {
    expect(inapplicablePresetFields(gmshPreset)).toEqual([]);
    expect(
      inapplicablePresetFields({ ...gmshPreset, name: "r", engine: "ftetwild", options: { ...DEFAULT_MESH_OPTIONS } })
    ).toEqual([]);
  });
});

describe("effectivePresetOptions", () => {
  it("converts authored sizes into mm-native options and pins the engine", () => {
    const preset: MeshPreset = {
      ...gmshPreset,
      unit: "in",
      options: { ...DEFAULT_MESH_OPTIONS, sizeMin: 0.1, sizeMax: 1 },
    };
    const { options, warnings } = effectivePresetOptions(preset);
    expect(options.sizeMin).toBeCloseTo(2.54, 10);
    expect(options.sizeMax).toBeCloseTo(25.4, 10);
    expect(options.engine).toBe("gmsh");
    expect(warnings.some((w) => /converted from in to mm/.test(w))).toBe(true);
  });

  it("leaves the unbounded sentinel unconverted and says so plainly", () => {
    const preset: MeshPreset = { ...gmshPreset, unit: "in", options: { ...DEFAULT_MESH_OPTIONS } };
    const { options, warnings } = effectivePresetOptions(preset);
    expect(options.sizeMax).toBe(DEFAULT_MESH_OPTIONS.sizeMax);
    expect(warnings.some((w) => /auto/.test(w))).toBe(true);
  });

  it("is a no-op conversion (and warning-free) for native mm", () => {
    const { options, warnings } = effectivePresetOptions(gmshPreset);
    expect(options).toEqual({ ...gmshPreset.options, engine: "gmsh" });
    // elementOrder: 2 applies under gmsh — no inapplicable-field warning.
    expect(warnings).toEqual([]);
  });

  it("warns about engine-ignored fields by name", () => {
    const preset: MeshPreset = {
      ...gmshPreset,
      name: "robust",
      engine: "ftetwild",
      options: { ...DEFAULT_MESH_OPTIONS, elementOrder: 2 },
    };
    const { options, warnings } = effectivePresetOptions(preset);
    expect(options.engine).toBe("ftetwild");
    expect(warnings.some((w) => /"elementOrder".*fTetWild/.test(w))).toBe(true);
  });
});
