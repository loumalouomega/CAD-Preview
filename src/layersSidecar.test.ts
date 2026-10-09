import { describe, expect, it } from "vitest";
import {
  assignLayerEntities,
  defaultLayer,
  deleteLayer,
  layersWithDefault,
  lockedOperandForOp,
  nextLayerId,
  parseLayersJson,
  resolveLayerDrawFilter,
  serializeLayersJson,
} from "./layersSidecar";

describe("parseLayersJson", () => {
  it("returns [] for malformed JSON or a missing layers array", () => {
    expect(parseLayersJson("not json")).toEqual([]);
    expect(parseLayersJson(JSON.stringify({ version: 1, source: "a.stp" }))).toEqual([]);
  });

  it("parses a full layer and defaults visible/locked", () => {
    const layers = parseLayersJson(
      JSON.stringify({
        version: 1,
        source: "a.stp",
        layers: [
          { id: "layer-0", name: "Default", color: "#b8b8b8", volumes: ["solid-0"], surfaces: [], lines: [], points: [] },
        ],
      })
    );
    expect(layers).toEqual([
      { id: "layer-0", name: "Default", color: "#b8b8b8", visible: true, locked: false, volumes: ["solid-0"], surfaces: [], lines: [], points: [] },
    ]);
  });

  it("drops a malformed entry while its siblings survive", () => {
    const layers = parseLayersJson(
      JSON.stringify({
        version: 1,
        source: "a.stp",
        layers: [
          { id: "layer-0", name: "Default", color: "#b8b8b8" },
          { id: "", name: "Nameless", color: "#ff0000" },
          { id: "layer-1", name: "Bad colour", color: "red" },
          null,
        ],
      })
    );
    expect(layers.map((l) => l.id)).toEqual(["layer-0"]);
  });

  it("round-trips through serializeLayersJson", () => {
    const layers = [defaultLayer(), { ...defaultLayer(), id: "layer-1", name: "Hidden", visible: false, locked: true }];
    const text = serializeLayersJson("a.stp", layers);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseLayersJson(text)).toEqual(layers);
  });
});

describe("layer ids", () => {
  it("never reuses ids", () => {
    expect(nextLayerId([])).toBe("layer-0");
    expect(nextLayerId([defaultLayer(), { ...defaultLayer(), id: "layer-3", name: "X" }])).toBe("layer-4");
  });

  it("layersWithDefault yields the implicit default for an empty list", () => {
    expect(layersWithDefault([])).toEqual([defaultLayer()]);
    const stored = [defaultLayer()];
    expect(layersWithDefault(stored)).toEqual(stored);
    expect(layersWithDefault(stored)).not.toBe(stored);
  });
});

describe("deleteLayer", () => {
  it("returns members to the default layer", () => {
    const layers = [
      defaultLayer(),
      { ...defaultLayer(), id: "layer-1", name: "Gone", surfaces: ["face-1", "face-2"] },
    ];
    const out = deleteLayer(layers, "layer-1");
    expect(out.map((l) => l.id)).toEqual(["layer-0"]);
    expect(out[0].surfaces).toEqual(["face-1", "face-2"]);
    // The input is untouched.
    expect(layers[1].surfaces).toEqual(["face-1", "face-2"]);
  });

  it("refuses to delete the default layer or an unknown id", () => {
    expect(() => deleteLayer([defaultLayer()], "layer-0")).toThrow(/default layer cannot be deleted/);
    expect(() => deleteLayer([defaultLayer()], "layer-9")).toThrow(/No layer with id/);
  });
});

describe("assignLayerEntities", () => {
  it("moves members between layers so each entity sits on exactly one", () => {
    const layers = [
      defaultLayer(),
      { ...defaultLayer(), id: "layer-1", name: "A", surfaces: ["face-1"] },
    ];
    const out = assignLayerEntities(layers, "layer-0", { surfaces: ["face-1", "face-2"] });
    expect(out[0].surfaces).toEqual(["face-1", "face-2"]);
    expect(out[1].surfaces).toEqual([]);
  });

  it("throws for an unknown layer id", () => {
    expect(() => assignLayerEntities([defaultLayer()], "layer-9", {})).toThrow(/No layer with id/);
  });
});

describe("lockedOperandForOp", () => {
  const layers = [
    defaultLayer(),
    { ...defaultLayer(), id: "layer-1", name: "Frozen", locked: true, surfaces: ["face-1"] },
  ];
  it("names the locked layer for an op touching its member", () => {
    expect(lockedOperandForOp({ op: "defeature", faces: ["face-9", "face-1"] } as never, layers)).toEqual({
      id: "face-1",
      layerId: "layer-1",
      layerName: "Frozen",
    });
  });
  it("ignores unlocked layers, creation ops, and non-id fields", () => {
    expect(lockedOperandForOp({ op: "defeature", faces: ["face-9"] } as never, layers)).toBeNull();
    expect(lockedOperandForOp({ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] } as never, layers)).toBeNull();
    // A name that merely looks numeric is not an entity id.
    expect(lockedOperandForOp({ op: "defeature", faces: ["face-1x"] } as never, layers)).toBeNull();
  });
});

describe("resolveLayerDrawFilter", () => {
  const layers = [
    defaultLayer(),
    { ...defaultLayer(), id: "layer-1", name: "Dims", color: "#ff0000", surfaces: ["face-1"] },
  ];
  it("resolves by id or name, warning on unknown names", () => {
    const { subsets, warnings } = resolveLayerDrawFilter(layers, ["Dims", "layer-0", "Nope"]);
    expect(subsets.map((s) => s.id)).toEqual(["layer-1", "layer-0"]);
    expect(subsets[0]).toMatchObject({ name: "Dims", color: "#ff0000", faces: ["face-1"] });
    expect(warnings.join(" ")).toMatch(/Unknown layer "Nope"/);
  });
  it("dedupes and resolves against the implicit default when empty", () => {
    const { subsets, warnings } = resolveLayerDrawFilter([], ["layer-0", "layer-0"]);
    expect(subsets).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});
