import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import fs from "node:fs";
import path from "node:path";
import { amfDeclaredUnit } from "./amfUnits";

const doc = (attrs: string) => `<?xml version="1.0"?>\n<amf ${attrs}><object id="0"/></amf>`;
const bytes = (s: string) => strToU8(s);

describe("amfDeclaredUnit", () => {
  it("maps each listed unit", () => {
    expect(amfDeclaredUnit(bytes(doc('unit="millimeter"')))).toBe("mm");
    expect(amfDeclaredUnit(bytes(doc('unit="inch"')))).toBe("in");
    expect(amfDeclaredUnit(bytes(doc('unit="feet"')))).toBe("ft");
    expect(amfDeclaredUnit(bytes(doc('unit="meter"')))).toBe("m");
    expect(amfDeclaredUnit(bytes(doc("unit='Inch'")))).toBe("in");
  });

  it("returns undefined for a micron, an unknown unit, or no attribute", () => {
    expect(amfDeclaredUnit(bytes(doc('unit="micron"')))).toBeUndefined();
    expect(amfDeclaredUnit(bytes(doc('unit="furlong"')))).toBeUndefined();
    expect(amfDeclaredUnit(bytes(doc('version="1.1"')))).toBeUndefined();
  });

  it("reads only the root element's attribute", () => {
    const text = `<amf><object id="0"><metadata unit="inch"/></object></amf>`;
    expect(amfDeclaredUnit(bytes(text))).toBeUndefined();
  });

  it("reads a zipped AMF's first .amf entry", () => {
    const zipped = zipSync({ "readme.txt": strToU8("x"), "part.amf": bytes(doc('unit="inch"')) });
    expect(amfDeclaredUnit(zipped)).toBe("in");
  });

  it("is undefined (not a throw) for garbage and for a zip with no .amf", () => {
    expect(amfDeclaredUnit(new Uint8Array([0x50, 0x4b, 1, 2, 3]))).toBeUndefined();
    expect(amfDeclaredUnit(zipSync({ "a.txt": strToU8("x") }))).toBeUndefined();
    expect(amfDeclaredUnit(new Uint8Array())).toBeUndefined();
  });
});

describe("committed fixtures (examples/AMF)", () => {
  const read = (n: string) => new Uint8Array(fs.readFileSync(path.join(__dirname, "..", "examples", "AMF", n)));
  it("declare the units their generator says (plain and zipped)", () => {
    expect(amfDeclaredUnit(read("cube.amf"))).toBe("mm");
    expect(amfDeclaredUnit(read("cube-inch.amf"))).toBe("in");
    expect(amfDeclaredUnit(read("cube-colour.amf"))).toBe("mm");
    expect(amfDeclaredUnit(read("cube-zip.amf"))).toBe("mm");
  });
});
