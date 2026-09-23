import { describe, it, expect } from "vitest";
import { deriveTessellation, percentile, weldedMeshToBinaryStl } from "./tessellationTolerance";
import { parseStl } from "./stlParser";

describe("deriveTessellation", () => {
  it("derives an absolute deflection from cell size × fraction", () => {
    const d = deriveTessellation({ targetCellSize: 4, chordalFraction: 0.05 });
    expect(d.linearDeflectionMm).toBeCloseTo(0.2);
    expect(d.requestedChordal).toBeCloseTo(0.2);
    expect(d.angularDeflectionRad).toBeCloseTo((20 * Math.PI) / 180);
  });
  it("keeps the physical tolerance when the size is given in another unit", () => {
    const mm = deriveTessellation({ targetCellSize: 5, unit: "mm" });
    const m = deriveTessellation({ targetCellSize: 0.005, unit: "m" });
    expect(m.linearDeflectionMm).toBeCloseTo(mm.linearDeflectionMm, 12);
    expect(m.requestedChordal).toBeCloseTo(mm.requestedChordal / 1000, 12);
  });
  it("refuses nonsense input", () => {
    expect(() => deriveTessellation({ targetCellSize: 0 })).toThrow(/targetCellSize/);
    expect(() => deriveTessellation({ targetCellSize: 1, chordalFraction: 2 })).toThrow(/chordalFraction/);
    expect(() => deriveTessellation({ targetCellSize: 1, angularDeg: 0 })).toThrow(/angularDeg/);
  });
});

describe("percentile", () => {
  it("is nearest-rank and NaN for empty", () => {
    expect(percentile([5, 1, 3, 2, 4], 100)).toBe(5);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });
});

describe("weldedMeshToBinaryStl", () => {
  it("round-trips through the repo's own STL parser, scaled", () => {
    const mesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    const bytes = weldedMeshToBinaryStl(mesh, 25.4);
    expect(bytes.length).toBe(84 + 50);
    const soup = parseStl(bytes);
    expect(Array.from(soup)).toEqual([0, 0, 0, 25.4, 0, 0, 0, 25.4, 0].map((v) => Math.fround(v)));
  });
});
