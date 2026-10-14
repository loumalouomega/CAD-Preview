import { describe, it, expect } from "vitest";
import { bomTsv, type BomRow } from "./bomExport";

const row = (overrides: Partial<BomRow> = {}): BomRow => ({
  name: "Bracket",
  color: "#e6194b",
  solidCount: 1,
  surfaceCount: 0,
  lineCount: 0,
  pointCount: 0,
  volume: 1000,
  area: 600,
  density: null,
  mass: null,
  unresolvedIds: [],
  ...overrides,
});

describe("bomTsv", () => {
  it("emits a header row plus one tab-separated line per part", () => {
    const tsv = bomTsv([row(), row({ name: "Boss", solidCount: 2, surfaceCount: 1, volume: 2000, area: 1200 })]);
    const lines = tsv.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Name\tSolids\tSurfaces\tLines\tPoints\tVolume_mm3\tArea_mm2\tDensity_g_cm3\tMass_g\tUnresolved");
    expect(lines[1]).toBe("Bracket\t1\t0\t0\t0\t1000\t600\t\t\t");
    expect(lines[2]).toBe("Boss\t2\t1\t0\t0\t2000\t1200\t\t\t");
  });

  it("rounds display numbers to 4 decimals without mutating the underlying rows", () => {
    const r = row({ volume: 699.9999999999, area: 123.456789 });
    const cell = (tsv: string) => tsv.split("\n")[1].split("\t");
    expect(cell(bomTsv([r]))[5]).toBe("700");
    expect(cell(bomTsv([r]))[6]).toBe("123.4568");
    expect(r.volume).toBeCloseTo(699.9999999999, 10);
  });

  it("leaves a numeric cell EMPTY for an unmeasurable row rather than writing a misleading 0", () => {
    const tsv = bomTsv([row({ volume: null, area: null, unresolvedIds: ["solid-9"] })]);
    const cells = tsv.split("\n")[1].split("\t");
    expect(cells[5]).toBe("");
    expect(cells[6]).toBe("");
    expect(cells[9]).toBe("solid-9");
  });

  it("returns just the header for zero rows", () => {
    expect(bomTsv([])).toBe("Name\tSolids\tSurfaces\tLines\tPoints\tVolume_mm3\tArea_mm2\tDensity_g_cm3\tMass_g\tUnresolved");
  });
});

describe("bomTsv mass columns", () => {
  it("writes density and mass, and leaves both empty when the part has no density", () => {
    const tsv = bomTsv([row({ density: 7.85, mass: 7.85 }), row({ name: "NoDensity" })]);
    const [, a, b] = tsv.split("\n").map((l) => l.split("\t"));
    expect(a.slice(7, 9)).toEqual(["7.85", "7.85"]);
    expect(b.slice(7, 9)).toEqual(["", ""]);
  });
});
