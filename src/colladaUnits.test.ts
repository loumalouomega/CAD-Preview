import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { colladaDeclaredUnit, colladaMetresPerUnit, colladaMmPerUnit } from "./colladaUnits";

const asset = (unit: string) => `<COLLADA><asset>${unit}<up_axis>Z_UP</up_axis></asset><library_geometries/></COLLADA>`;

describe("colladaMetresPerUnit", () => {
  it("reads the asset's <unit meter>", () => {
    expect(colladaMetresPerUnit(asset('<unit meter="0.001" name="millimeter"/>'))).toBe(0.001);
    expect(colladaMetresPerUnit(asset('<unit name="inch" meter="0.0254"/>'))).toBe(0.0254);
    expect(colladaMetresPerUnit(asset('<unit meter = "1"/>'))).toBe(1);
  });

  it("falls back to the spec default (1 m) when absent or unusable — never NaN, never 0", () => {
    expect(colladaMetresPerUnit(asset(""))).toBe(1);
    expect(colladaMetresPerUnit("not xml")).toBe(1);
    expect(colladaMetresPerUnit(asset('<unit meter="abc"/>'))).toBe(1);
    expect(colladaMetresPerUnit(asset('<unit meter="0"/>'))).toBe(1);
    expect(colladaMetresPerUnit(asset('<unit meter="-2"/>'))).toBe(1);
  });

  it("ignores a <unit> outside <asset>", () => {
    const xml = `<COLLADA><asset></asset><library_physics_models><unit meter="0.001"/></library_physics_models></COLLADA>`;
    expect(colladaMetresPerUnit(xml)).toBe(1);
  });
});

describe("colladaMmPerUnit", () => {
  it("is metres × 1000 (the viewer works in millimetres)", () => {
    expect(colladaMmPerUnit(asset('<unit meter="0.001"/>'))).toBeCloseTo(1, 12);
    expect(colladaMmPerUnit(asset('<unit meter="0.0254"/>'))).toBeCloseTo(25.4, 9);
    expect(colladaMmPerUnit(asset(""))).toBe(1000);
  });
});

describe("colladaDeclaredUnit", () => {
  it("maps the common declared units to the Units dropdown", () => {
    expect(colladaDeclaredUnit(asset('<unit meter="0.001"/>'))).toBe("mm");
    expect(colladaDeclaredUnit(asset('<unit meter="0.01"/>'))).toBe("cm");
    expect(colladaDeclaredUnit(asset('<unit meter="1"/>'))).toBe("m");
    expect(colladaDeclaredUnit(asset('<unit meter="0.0254"/>'))).toBe("in");
    expect(colladaDeclaredUnit(asset('<unit meter="0.3048"/>'))).toBe("ft");
  });

  it("does not seed from an unlisted unit, a missing <unit>, or a malformed value", () => {
    expect(colladaDeclaredUnit(asset('<unit meter="0.000001"/>'))).toBeUndefined();
    expect(colladaDeclaredUnit(asset(""))).toBeUndefined();
    expect(colladaDeclaredUnit(asset('<unit meter="abc"/>'))).toBeUndefined();
  });
});

describe("committed fixtures (examples/Collada)", () => {
  const read = (n: string) => fs.readFileSync(path.join(__dirname, "..", "examples", "Collada", n), "utf8");
  it("declare the units their generator says, and measure the same real-world size", () => {
    // A cube of side 10 mm, 0.01 m and 1 in: sizes in mm after unit scaling.
    const side = (n: string, edge: number) => edge * colladaMmPerUnit(read(n));
    expect(side("cube.dae", 10)).toBeCloseTo(10, 9);
    expect(side("cube-metre.dae", 0.01)).toBeCloseTo(10, 9);
    expect(side("cube-inch.dae", 1)).toBeCloseTo(25.4, 9);
    expect(colladaDeclaredUnit(read("cube.dae"))).toBe("mm");
    expect(colladaDeclaredUnit(read("cube-metre.dae"))).toBe("m");
    expect(colladaDeclaredUnit(read("cube-inch.dae"))).toBe("in");
  });
});
