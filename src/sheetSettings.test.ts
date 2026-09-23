import { describe, it, expect } from "vitest";
import { parseScale, resolveSheetSettings, STANDARD_SCALE_LABELS } from "./sheetSettings";
import { mergeSheetTemplates, parseSheetTemplatesJson, serializeSheetTemplatesJson, type SheetTemplateLibrary } from "./sheetTemplates";
import { layoutSheet, titleBlockExtraRows, SHEET } from "./drawingSheet";

describe("parseScale", () => {
  it("reads ratios and plain numbers, rejects nonsense", () => {
    expect(parseScale("1:2")).toBe(0.5);
    expect(parseScale("2:1")).toBe(2);
    expect(parseScale(" 3 : 4 ")).toBe(0.75);
    expect(parseScale(0.25)).toBe(0.25);
    expect(parseScale("0.5")).toBe(0.5);
    expect(parseScale("0:1")).toBeNull();
    expect(parseScale("big")).toBeNull();
    expect(parseScale(-1)).toBeNull();
    expect(STANDARD_SCALE_LABELS[0]).toBe("50:1");
  });
});

describe("resolveSheetSettings", () => {
  it("defaults to front/top/right/iso, first-angle, fit, svg, the file name", () => {
    const s = resolveSheetSettings({}, undefined, { title: "part.stp" });
    expect(s.views.map((v) => v.name)).toEqual(["front", "top", "right", "iso-ftr"]);
    expect([s.projection, s.paper, s.format, s.title, s.scale]).toEqual(["first", "fit", "svg", "part.stp", undefined]);
  });
  it("input beats template beats defaults, field by field (fields merge)", () => {
    const template = { views: ["front"], projection: "third", paper: "A3", scale: "1:2", fields: { author: "T", material: "Steel" } };
    const s = resolveSheetSettings({ paper: "A4", fields: { author: "Me" } }, template, { title: "x" });
    expect(s.views.map((v) => v.name)).toEqual(["front"]);
    expect([s.projection, s.paper, s.scale]).toEqual(["third", "A4", 0.5]);
    expect(s.fields).toEqual({ author: "Me", material: "Steel" });
  });
  it("falls back with warnings, never throws, except when no view survives", () => {
    const s = resolveSheetSettings({ views: ["front", "nope", "front"], paper: "B5", projection: "second", scale: "huge", format: "pdf" }, undefined, { title: "x" });
    expect(s.views).toHaveLength(1);
    expect([s.paper, s.projection, s.scale, s.format]).toEqual(["fit", "first", undefined, "svg"]);
    expect(s.warnings.join(" ")).toMatch(/Unknown view "nope".*repeated.*Unknown format.*Unknown paper.*Unknown projection.*Invalid scale/s);
    expect(() => resolveSheetSettings({ views: ["nope"] }, undefined, { title: "x" })).toThrow(/at least one named view/);
  });
  it('treats scale "auto" as the automatic choice', () => {
    expect(resolveSheetSettings({ scale: "auto" }, { scale: "1:2" }, { title: "x" }).scale).toBeUndefined();
  });
});

describe("sheet templates", () => {
  it("round-trips and drops malformed entries/fields", () => {
    const lib: SheetTemplateLibrary = { a: { name: "a", views: ["front"], paper: "A3", scale: "1:5", fields: { author: "X" } } };
    expect(parseSheetTemplatesJson(serializeSheetTemplatesJson(lib))).toEqual(lib);
    const parsed = parseSheetTemplatesJson(JSON.stringify({ templates: { b: { views: [1, 2] }, c: 7, "": { name: "" } } }));
    expect(Object.keys(parsed)).toEqual(["b"]);
    expect(parsed.b.views).toBeUndefined();
    expect(parseSheetTemplatesJson("not json")).toEqual({});
  });
  it("merges with the caller winning collisions", () => {
    const { merged, collisions } = mergeSheetTemplates({ a: { name: "a", paper: "A3" } }, { a: { name: "a", paper: "A4" } });
    expect(merged.a.paper).toBe("A4");
    expect(collisions).toEqual(["a"]);
  });
});

describe("title-block fields", () => {
  it("produce extra rows only when present, and grow the block", () => {
    expect(titleBlockExtraRows(undefined)).toEqual([]);
    expect(titleBlockExtraRows({ author: "  " })).toEqual([]);
    expect(titleBlockExtraRows({ author: "Ann", drawingNumber: "D-1", revision: "B" })).toEqual([["Drawn Ann", "Dwg D-1 rev B"]]);
    expect(titleBlockExtraRows({ material: "Al" })).toEqual([["Material Al", null]]);
    const view = { name: "front", direction: [0, 0, 1] as [number, number, number], visible: [[[0, 0], [10, 0]], [[10, 0], [10, 5]]] as Array<[[number, number], [number, number]]>, hidden: [] };
    const plain = layoutSheet([view], {});
    const withFields = layoutSheet([view], { fields: { author: "Ann", material: "Al" } });
    expect(withFields.height - plain.height).toBeCloseTo(2 * SHEET.cellRowHeight);
    const texts = withFields.titleBlock.texts.map((t) => t.text);
    expect(texts).toContain("Drawn Ann");
    expect(texts).toContain("Material Al");
  });
});
