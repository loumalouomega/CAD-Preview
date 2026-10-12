import { describe, it, expect } from "vitest";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { build3mf, threeMfMmPerUnit } from "./threeMf";

// A unit cube, 8 vertices / 12 triangles, outward-wound.
const CUBE_POS = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const CUBE_IDX = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];

function modelOf(bytes: Uint8Array): string {
  return strFromU8(unzipSync(bytes)["3D/3dmodel.model"]);
}

describe("build3mf", () => {
  it("writes a valid package: the three OPC parts, PK magic, one object, 12 triangles", () => {
    const bytes = build3mf([{ name: "cube", positions: CUBE_POS, indices: CUBE_IDX }]);
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);
    const model = modelOf(bytes);
    expect(model.match(/<object /g)).toHaveLength(1);
    expect(model.match(/<triangle /g)).toHaveLength(12);
    expect(model.match(/<vertex /g)).toHaveLength(8);
    expect(model).toContain('unit="millimeter"');
    expect(model).toContain('<item objectid="1"/>');
    expect(strFromU8(files["_rels/.rels"])).toContain("/3D/3dmodel.model");
  });

  it("labels the declared unit for every DisplayUnit", () => {
    const labels = { mm: "millimeter", cm: "centimeter", m: "meter", in: "inch", ft: "foot" } as const;
    for (const [unit, label] of Object.entries(labels)) {
      expect(modelOf(build3mf([{ positions: CUBE_POS, indices: CUBE_IDX }], unit as keyof typeof labels))).toContain(`unit="${label}"`);
    }
  });

  it("welds an exactly-coincident triangle soup without changing the triangle count", () => {
    // Two triangles sharing an edge, written as an unindexed soup (6 vertices).
    const soup = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
    const model = modelOf(build3mf([{ positions: soup, indices: null }]));
    expect(model.match(/<triangle /g)).toHaveLength(2);
    expect(model.match(/<vertex /g)).toHaveLength(4);
  });

  it("writes one object per input and skips empty ones; throws when nothing remains", () => {
    const two = modelOf(build3mf([{ positions: CUBE_POS, indices: CUBE_IDX }, { positions: [], indices: [] }, { positions: CUBE_POS, indices: CUBE_IDX }]));
    expect(two.match(/<object /g)).toHaveLength(2);
    expect(() => build3mf([{ positions: [], indices: [] }])).toThrow(/no triangles/);
  });

  it("escapes names", () => {
    expect(modelOf(build3mf([{ name: 'a"<b>&', positions: CUBE_POS, indices: CUBE_IDX }]))).toContain('name="a&quot;&lt;b&gt;&amp;"');
  });

  it("is byte-stable across calls", () => {
    const a = build3mf([{ positions: CUBE_POS, indices: CUBE_IDX }]);
    const b = build3mf([{ positions: CUBE_POS, indices: CUBE_IDX }]);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe("threeMfMmPerUnit", () => {
  const pkg = (unitAttr: string) =>
    zipSync({ "3D/3dmodel.model": strToU8(`<?xml version="1.0"?><model ${unitAttr} xmlns="x"><resources/></model>`) });

  it("reads every unit the spec allows", () => {
    expect(threeMfMmPerUnit(pkg('unit="millimeter"'))).toBe(1);
    expect(threeMfMmPerUnit(pkg('unit="centimeter"'))).toBe(10);
    expect(threeMfMmPerUnit(pkg('unit="meter"'))).toBe(1000);
    expect(threeMfMmPerUnit(pkg('unit="inch"'))).toBe(25.4);
    expect(threeMfMmPerUnit(pkg('unit="foot"'))).toBe(304.8);
    expect(threeMfMmPerUnit(pkg('unit="micron"'))).toBe(0.001);
  });

  it("defaults to millimetres when the attribute is absent, unknown, or the package is unreadable", () => {
    expect(threeMfMmPerUnit(pkg(""))).toBe(1);
    expect(threeMfMmPerUnit(pkg('unit="parsec"'))).toBe(1);
    expect(threeMfMmPerUnit(new Uint8Array([1, 2, 3]))).toBe(1);
  });

  it("round-trips the writer's own label for every unit", () => {
    const expected = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 } as const;
    for (const [unit, mm] of Object.entries(expected)) {
      expect(threeMfMmPerUnit(build3mf([{ positions: CUBE_POS, indices: CUBE_IDX }], unit as keyof typeof expected))).toBe(mm);
    }
  });
});
