import { describe, expect, it } from "vitest";
import { parseScadOverridesJson, serializeScadOverridesJson, SCAD_OVERRIDES_SIDECAR_VERSION } from "./scadOverridesSidecar";

describe("parseScadOverridesJson — round trip", () => {
  it("recovers a well-formed file exactly", () => {
    const overrides = { width: 60, chamfer: false, label: "round", size: [1, 2, 3] as const };
    const text = serializeScadOverridesJson("m.scad", { width: 60, chamfer: false, label: "round", size: [1, 2, 3] });
    expect(parseScadOverridesJson(text)).toEqual(overrides);
  });

  it("returns {} for missing, empty, or non-JSON input rather than throwing", () => {
    expect(parseScadOverridesJson("")).toEqual({});
    expect(parseScadOverridesJson("not json")).toEqual({});
    expect(parseScadOverridesJson("null")).toEqual({});
    expect(parseScadOverridesJson(JSON.stringify({ version: 1, source: "m.scad" }))).toEqual({});
  });
});

describe("parseScadOverridesJson — tolerance", () => {
  const withOverrides = (overrides: unknown) => JSON.stringify({ version: 1, source: "m.scad", overrides });

  it("drops a malformed entry while its siblings survive", () => {
    const r = parseScadOverridesJson(withOverrides({ width: 60, bad: { nested: true }, chamfer: true }));
    expect(r).toEqual({ width: 60, chamfer: true });
  });

  it("drops an invalid variable name", () => {
    const r = parseScadOverridesJson(withOverrides({ "bad name": 1, width: 2 }));
    expect(r).toEqual({ width: 2 });
  });

  it("drops a non-finite number", () => {
    const r = parseScadOverridesJson(withOverrides({ width: Number.NaN, height: 5 }));
    // NaN does not survive JSON, but a null/infinity-shaped payload must still drop
    expect(r).toEqual({ height: 5 });
  });

  it("drops a vector with a non-scalar element", () => {
    const r = parseScadOverridesJson(withOverrides({ size: [1, null], width: 2 }));
    expect(r).toEqual({ width: 2 });
  });
});

describe("serializeScadOverridesJson", () => {
  it("records the version and source, and ends in a newline", () => {
    const text = serializeScadOverridesJson("model.scad", { width: 60 });
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(SCAD_OVERRIDES_SIDECAR_VERSION);
    expect(parsed.source).toBe("model.scad");
  });
});
