import { describe, it, expect } from "vitest";
import { buildPartsFromCsgColors, csgColorName, csgColorPartsNote, parseCsgColor } from "./csgColorParts";

describe("parseCsgColor", () => {
  it("reads the numeric vector OpenSCAD writes into .csg, with or without alpha", () => {
    expect(parseCsgColor({ "#0": [1, 0, 0, 1] })).toEqual({ hex: "#ff0000" });
    expect(parseCsgColor({ "#0": [0, 0.5, 1] })).toEqual({ hex: "#0080ff" });
  });
  it("rounds and clamps channels to 8 bits", () => {
    expect(parseCsgColor({ "#0": [2, -1, 0.2, 1] })).toEqual({ hex: "#ff0033" });
  });
  it("accepts c= as well as the positional argument", () => {
    expect(parseCsgColor({ c: [0, 1, 0, 1] })).toEqual({ hex: "#00ff00" });
  });
  it("accepts #rgb, #rrggbb and #rrggbbaa strings (alpha dropped), case-insensitively", () => {
    expect(parseCsgColor({ "#0": "#F80" })).toEqual({ hex: "#ff8800" });
    expect(parseCsgColor({ "#0": "#AABBCC" })).toEqual({ hex: "#aabbcc" });
    expect(parseCsgColor({ "#0": "#aabbcc80" })).toEqual({ hex: "#aabbcc" });
  });
  it("resolves known names, including aliases, and warns on an unknown one", () => {
    expect(parseCsgColor({ "#0": "Red" })).toEqual({ hex: "#ff0000" });
    expect(parseCsgColor({ "#0": "grey" })).toEqual({ hex: "#808080" });
    expect(parseCsgColor({ "#0": "cyan" })).toEqual({ hex: "#00ffff" });
    expect(parseCsgColor({ "#0": "puce" }).warning).toMatch(/puce.*colour ignored/);
  });
  it("yields no colour and no warning when color() has no argument, and warns on a malformed vector", () => {
    expect(parseCsgColor({})).toEqual({});
    expect(parseCsgColor({ "#0": [1, 0] }).warning).toMatch(/not \[r, g, b\]/);
    expect(parseCsgColor({ "#0": true }).warning).toMatch(/not a colour/);
  });
});

describe("csgColorName", () => {
  it("names a basic colour and falls back to the hex", () => {
    expect(csgColorName("#ff0000")).toBe("red");
    expect(csgColorName("#FF0000")).toBe("red");
    expect(csgColorName("#0080ff")).toBe("#0080ff");
  });
});

describe("buildPartsFromCsgColors", () => {
  it("makes one Part per colour, in order, listing the solids as volumes", () => {
    const parts = buildPartsFromCsgColors([
      { color: "#ff0000", solidIds: ["solid-0", "solid-4"] },
      { color: "#0080ff", solidIds: ["solid-1"] },
    ]);
    expect(parts).toEqual([
      { name: "Part red", color: "#ff0000", volumes: ["solid-0", "solid-4"], surfaces: [], lines: [], points: [] },
      { name: "Part #0080ff", color: "#0080ff", volumes: ["solid-1"], surfaces: [], lines: [], points: [] },
    ]);
  });
  it("skips an empty group and returns [] for no groups", () => {
    expect(buildPartsFromCsgColors([{ color: "#ff0000", solidIds: [] }])).toEqual([]);
    expect(buildPartsFromCsgColors([])).toEqual([]);
  });
  it("copies the id arrays rather than aliasing them", () => {
    const g = { color: "#ff0000", solidIds: ["solid-0"] };
    const [p] = buildPartsFromCsgColors([g]);
    p.volumes.push("solid-9");
    expect(g.solidIds).toEqual(["solid-0"]);
  });
});

describe("csgColorPartsNote", () => {
  it("states the naming limit instead of inventing module names", () => {
    expect(csgColorPartsNote(2)).toMatch(/Created 2 Part\(s\).*no module names/);
  });
});
