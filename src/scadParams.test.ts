import { describe, it, expect } from "vitest";
import { parseScadParameters, validateScadOverrides, formatScadValue, isValidScadName } from "./scadParams";

const SAMPLE = `
// A bracket
/* [Dimensions] */
// Overall width in mm
width = 40; // [10:5:100]
height = 12.5; // [5:30]
holes = 4;     // [2, 4, 6:Six holes]

/* [Style] */
corner = "round"; // [round, square:Square corners]
chamfer = true;
size = [10, 20, 30];
label = "a;b // c";

/* [Hidden] */
secret = 7;

derived = width * 2;
module part() { cube(1); }
after_module = 99;
`;

describe("parseScadParameters", () => {
  const params = parseScadParameters(SAMPLE);
  const by = (n: string) => params.find((p) => p.name === n);

  it("reads literal assignments with kind, default, group and 1-based line", () => {
    expect(by("width")).toMatchObject({ kind: "number", default: 40, group: "Dimensions", hidden: false });
    expect(by("chamfer")).toMatchObject({ kind: "boolean", default: true, group: "Style" });
    expect(by("size")).toMatchObject({ kind: "vector", default: [10, 20, 30] });
    expect(SAMPLE.split("\n")[by("width")!.line - 1]).toContain("width = 40");
  });

  it("takes the comment line above as the description", () => {
    expect(by("width")?.description).toBe("Overall width in mm");
    expect(by("height")?.description).toBeUndefined();
  });

  it("reads [min:max] and [min:step:max] ranges", () => {
    expect(by("width")).toMatchObject({ min: 10, step: 5, max: 100 });
    expect(by("height")).toMatchObject({ min: 5, max: 30 });
    expect(by("height")?.step).toBeUndefined();
  });

  it("reads option lists with optional labels, numeric and string", () => {
    expect(by("holes")?.options).toEqual([{ value: 2 }, { value: 4 }, { value: 6, label: "Six holes" }]);
    expect(by("corner")?.options).toEqual([{ value: "round" }, { value: "square", label: "Square corners" }]);
  });

  it("does not mistake ; or // inside a string for syntax", () => {
    expect(by("label")).toMatchObject({ kind: "string", default: "a;b // c" });
  });

  it("flags the [Hidden] group", () => {
    expect(by("secret")).toMatchObject({ hidden: true, group: "Hidden" });
  });

  it("skips expressions and stops at the first module", () => {
    expect(by("derived")).toBeUndefined();
    expect(by("after_module")).toBeUndefined();
  });

  it("returns [] for a file with no parameters, and never throws on junk", () => {
    expect(parseScadParameters("cube(10);")).toEqual([]);
    expect(parseScadParameters("")).toEqual([]);
    expect(() => parseScadParameters("x = ;\n/* unterminated\n")).not.toThrow();
  });

  it("ignores assignments inside a multi-line block comment", () => {
    expect(parseScadParameters("/*\nnot_a_param = 1;\n*/\nreal = 2;").map((p) => p.name)).toEqual(["real"]);
  });

  it("keeps a malformed annotation from dropping the parameter", () => {
    expect(parseScadParameters("a = 3; // [x:y:z]")[0]).toMatchObject({ name: "a", default: 3 });
  });
});

describe("formatScadValue / isValidScadName", () => {
  it("renders values as OpenSCAD expressions", () => {
    expect(formatScadValue(2.5)).toBe("2.5");
    expect(formatScadValue(false)).toBe("false");
    expect(formatScadValue('he said "hi"')).toBe('"he said \\"hi\\""');
    expect(formatScadValue([1, "a"])).toBe('[1, "a"]');
  });
  it("accepts identifiers and $-specials only", () => {
    expect(isValidScadName("wall_2")).toBe(true);
    expect(isValidScadName("$fn")).toBe(true);
    expect(isValidScadName("a b")).toBe(false);
    expect(isValidScadName("x=1")).toBe(false);
    expect(isValidScadName("2x")).toBe(false);
  });
});

describe("validateScadOverrides", () => {
  const params = parseScadParameters(SAMPLE);

  it("accepts well-typed overrides", () => {
    const r = validateScadOverrides(params, { width: 60, chamfer: false, size: [1, 2, 3], corner: "square" });
    expect(r.defines).toEqual({ width: 60, chamfer: false, size: [1, 2, 3], corner: "square" });
    expect(r.warnings).toEqual([]);
  });

  it("reports and drops unknown names and wrong types", () => {
    const r = validateScadOverrides(params, { widht: 1, width: "wide", size: [1, 2], chamfer: 1 });
    expect(r.defines).toEqual({});
    expect(r.warnings).toHaveLength(4);
    expect(r.warnings.join("\n")).toMatch(/widht.*not a Customizer parameter/);
    expect(r.warnings.join("\n")).toMatch(/size.*vector of 3/);
  });

  it("applies out-of-range and off-list values with a note", () => {
    const r = validateScadOverrides(params, { width: 500, holes: 5, corner: "bevel" });
    expect(r.defines).toEqual({ width: 500, holes: 5, corner: "bevel" });
    expect(r.warnings).toHaveLength(3);
  });

  it("rejects non-finite numbers and invalid names", () => {
    const r = validateScadOverrides(params, { width: Number.NaN, "bad name": 1 });
    expect(r.defines).toEqual({});
    expect(r.warnings).toHaveLength(2);
  });

  it("accepts undeclared $-specials", () => {
    expect(validateScadOverrides(params, { $fn: 64 }).defines).toEqual({ $fn: 64 });
    expect(validateScadOverrides(params, { $fn: "x" }).defines).toEqual({});
  });
});
