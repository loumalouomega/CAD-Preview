import { describe, it, expect } from "vitest";
import { normalizeViewerDefaults, DEFAULT_VIEWER_DEFAULTS } from "./viewerDefaults";

describe("normalizeViewerDefaults", () => {
  it("returns defaults for garbage/missing input", () => {
    expect(normalizeViewerDefaults(undefined)).toEqual(DEFAULT_VIEWER_DEFAULTS);
    expect(normalizeViewerDefaults(null)).toEqual(DEFAULT_VIEWER_DEFAULTS);
    expect(normalizeViewerDefaults("nope")).toEqual(DEFAULT_VIEWER_DEFAULTS);
    expect(normalizeViewerDefaults(42)).toEqual(DEFAULT_VIEWER_DEFAULTS);
    expect(normalizeViewerDefaults([])).toEqual(DEFAULT_VIEWER_DEFAULTS);
    expect(normalizeViewerDefaults({})).toEqual(DEFAULT_VIEWER_DEFAULTS);
  });

  it("accepts a well-formed object unchanged", () => {
    const opts = { background: "#000000", meshSizePreset: "fine" as const, showGridAndAxes: false, upAxis: "z" as const };
    expect(normalizeViewerDefaults(opts)).toEqual(opts);
  });

  it("accepts a 3-digit hex background", () => {
    expect(normalizeViewerDefaults({ background: "#fff" }).background).toBe("#fff");
  });

  it("defaults background unless a valid CSS hex color", () => {
    expect(normalizeViewerDefaults({ background: "red" }).background).toBe(DEFAULT_VIEWER_DEFAULTS.background);
    expect(normalizeViewerDefaults({ background: "#12" }).background).toBe(DEFAULT_VIEWER_DEFAULTS.background);
    expect(normalizeViewerDefaults({ background: 123 }).background).toBe(DEFAULT_VIEWER_DEFAULTS.background);
  });

  it("defaults meshSizePreset unless exactly coarse/medium/fine", () => {
    expect(normalizeViewerDefaults({ meshSizePreset: "coarse" }).meshSizePreset).toBe("coarse");
    expect(normalizeViewerDefaults({ meshSizePreset: "extra-fine" }).meshSizePreset).toBe(
      DEFAULT_VIEWER_DEFAULTS.meshSizePreset
    );
  });

  it("defaults showGridAndAxes unless a boolean", () => {
    expect(normalizeViewerDefaults({ showGridAndAxes: false }).showGridAndAxes).toBe(false);
    expect(normalizeViewerDefaults({ showGridAndAxes: "false" }).showGridAndAxes).toBe(
      DEFAULT_VIEWER_DEFAULTS.showGridAndAxes
    );
  });

  it("defaults upAxis unless exactly y/z", () => {
    expect(normalizeViewerDefaults({ upAxis: "z" }).upAxis).toBe("z");
    expect(normalizeViewerDefaults({ upAxis: "x" }).upAxis).toBe(DEFAULT_VIEWER_DEFAULTS.upAxis);
  });

  it("DEFAULT_VIEWER_DEFAULTS is itself valid", () => {
    expect(normalizeViewerDefaults(DEFAULT_VIEWER_DEFAULTS)).toEqual(DEFAULT_VIEWER_DEFAULTS);
  });
});
