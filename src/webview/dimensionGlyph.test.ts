import { describe, expect, it } from "vitest";
import { computeDistanceGlyph, formatMeasureValue, type DimensionGlyph } from "./dimensionGlyph";

const SCALE = 200; // bbox diagonal for the tests below

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function len(a: [number, number, number]): number {
  return Math.hypot(a[0], a[1], a[2]);
}

describe("computeDistanceGlyph — on-segment style", () => {
  it("places arrowhead tips exactly at the endpoints, axes pointing outward along ±unit dir", () => {
    const g = computeDistanceGlyph([10, 20, 30], [110, 20, 30], { scale: SCALE });
    expect(g.arrowheads).toHaveLength(2);
    const [a0, a1] = g.arrowheads;
    expect(a0.tip).toEqual([10, 20, 30]);
    expect(a1.tip).toEqual([110, 20, 30]);
    // Segment runs +X: outward axes are −X at p0 and +X at p1.
    expect(len(a0.axis)).toBeCloseTo(1, 12);
    expect(a0.axis).toEqual([-1, 0, 0]);
    expect(a1.axis).toEqual([1, 0, 0]);
  });

  it("scales arrowheads from the model scale and caps them against short segments", () => {
    const long = computeDistanceGlyph([0, 0, 0], [100, 0, 0], { scale: SCALE });
    expect(long.arrowheads[0].length).toBeCloseTo(SCALE * 0.04, 9); // cap not binding

    const short = computeDistanceGlyph([0, 0, 0], [1, 0, 0], { scale: SCALE });
    expect(short.arrowheads[0].length).toBeCloseTo(1 / 3, 9); // capped at segment/3
    expect(short.arrowheads[1].tip).toEqual([1, 0, 0]);
  });

  it("derives halfWidth from the slender included angle (2 × 15°)", () => {
    const g = computeDistanceGlyph([0, 0, 0], [100, 0, 0], { scale: SCALE });
    const expected = g.arrowheads[0].length * Math.tan((15 * Math.PI) / 180);
    expect(g.arrowheads[0].halfWidth).toBeCloseTo(expected, 12);
  });

  it("draws witness stubs perpendicular to the segment and centered on each endpoint", () => {
    const g = computeDistanceGlyph([0, 0, 0], [60, 80, 0], { scale: SCALE }); // arbitrary non-axis direction
    expect(g.witnesses).toHaveLength(2);
    const expectedStub = SCALE * 0.04 * 1.25;
    for (const w of g.witnesses) {
      const centre: [number, number, number] = [(w[0][0] + w[1][0]) / 2, (w[0][1] + w[1][1]) / 2, (w[0][2] + w[1][2]) / 2];
      const onAnEndpoint = [0, 1].some((i) =>
        Math.hypot(centre[0] - (i === 0 ? 0 : 60), centre[1] - (i === 0 ? 0 : 80), centre[2]) < 1e-9
      );
      expect(onAnEndpoint).toBe(true);
      expect(len([w[1][0] - w[0][0], w[1][1] - w[0][1], w[1][2] - w[0][2]])).toBeCloseTo(expectedStub, 9);
      const dir: [number, number, number] = [0.6, 0.8, 0];
      expect(dot([w[1][0] - w[0][0], w[1][1] - w[0][1], w[1][2] - w[0][2]], dir)).toBeCloseTo(0, 9);
    }
    expect(g.extensionLines).toHaveLength(0);
  });

  it("falls back deterministically when upHint is parallel to the segment", () => {
    const parallel = computeDistanceGlyph([0, 0, 0], [0, 50, 0], { scale: SCALE, upHint: [0, 1, 0] });
    const fallback = computeDistanceGlyph([0, 0, 0], [0, 50, 0], { scale: SCALE, upHint: [0, 0, 1] });
    // Both must produce valid perpendicular stubs; the parallel hint resolves
    // through the fixed fallback chain rather than NaN.
    for (const g of [parallel, fallback]) {
      expect(g.witnesses.every((w) => w.every((p) => p.every(Number.isFinite)))).toBe(true);
      const segDir: [number, number, number] = [0, 1, 0];
      for (const w of g.witnesses) {
        expect(dot([w[1][0] - w[0][0], w[1][1] - w[0][1], w[1][2] - w[0][2]], segDir)).toBeCloseTo(0, 9);
      }
    }
    // The parallel hint resolves through the fixed fallback chain ([0,0,1]
    // next), so it matches an explicit [0,0,1] hint exactly — determinism,
    // not divergence, is the property under test.
    expect(parallel.witnesses).toEqual(fallback.witnesses);
    // A genuinely different plane produces genuinely different stubs.
    const otherPlane = computeDistanceGlyph([0, 0, 0], [0, 50, 0], { scale: SCALE, upHint: [1, 0, 0] });
    expect(otherPlane.witnesses).not.toEqual(parallel.witnesses);
  });

  it("keeps the dimension line identical to the measured segment and emits no extension lines", () => {
    const g: DimensionGlyph = computeDistanceGlyph([1, 2, 3], [4, 5, 6], { scale: SCALE });
    expect(g.line).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(g.extensionLines).toHaveLength(0);
  });
});

describe("computeDistanceGlyph — offset style", () => {
  it("displaces the dimension line along offsetDir and connects with perpendicular extension lines", () => {
    const g = computeDistanceGlyph([0, 0, 0], [100, 0, 0], { scale: SCALE, offsetDir: [0, 1, 0] });
    const offset = SCALE * 0.08;
    expect(g.line).toEqual([[0, offset, 0], [100, offset, 0]]);
    expect(g.extensionLines).toHaveLength(2);
    // Extension line starts at the measured point...
    expect(g.extensionLines[0][0]).toEqual([0, 0, 0]);
    expect(g.extensionLines[1][0]).toEqual([100, 0, 0]);
    // ...runs along offsetDir, overshooting the dimension line by half an arrowhead.
    const overshoot = SCALE * 0.04 * 0.5;
    expect(g.extensionLines[0][1]).toEqual([0, offset + overshoot, 0]);
    expect(g.witnesses).toHaveLength(0);
    // Arrowheads ride the displaced line.
    expect(g.arrowheads[0].tip).toEqual([0, offset, 0]);
    expect(g.arrowheads[1].tip).toEqual([100, offset, 0]);
  });

  it("normalizes a non-unit offsetDir", () => {
    const g = computeDistanceGlyph([0, 0, 0], [100, 0, 0], { scale: SCALE, offsetDir: [0, 5, 0] });
    expect(g.line[0][1]).toBeCloseTo(SCALE * 0.08, 9);
    expect(g.line[0][0]).toBeCloseTo(0, 9);
  });
});

describe("computeDistanceGlyph — degenerate input", () => {
  it("returns a valid empty-bodied glyph for coincident points (never NaN)", () => {
    const g = computeDistanceGlyph([5, 5, 5], [5, 5, 5], { scale: SCALE });
    expect(g.line).toEqual([[5, 5, 5], [5, 5, 5]]);
    expect(g.witnesses).toHaveLength(0);
    expect(g.arrowheads).toHaveLength(0);
    expect(g.extensionLines).toHaveLength(0);
  });

  it("returns a valid empty-bodied glyph for non-finite coordinates or a bad scale", () => {
    for (const g of [
      computeDistanceGlyph([NaN, 0, 0], [1, 0, 0], { scale: SCALE }),
      computeDistanceGlyph([0, 0, 0], [Infinity, 0, 0], { scale: SCALE }),
      computeDistanceGlyph([0, 0, 0], [10, 0, 0], { scale: 0 }),
      computeDistanceGlyph([0, 0, 0], [10, 0, 0], { scale: NaN }),
    ]) {
      expect(g.arrowheads).toHaveLength(0);
      expect(JSON.stringify(g)).not.toMatch(/NaN|Infinity/);
    }
  });
});

describe("formatMeasureValue", () => {
  it("trims trailing zeros from everyday magnitudes", () => {
    expect(formatMeasureValue(10)).toBe("10");
    expect(formatMeasureValue(0.034)).toBe("0.034");
    expect(formatMeasureValue(1234.5678)).toBe("1234.57");
    expect(formatMeasureValue(-7.5)).toBe("-7.5");
  });

  it("keeps six significant figures for awkward values", () => {
    expect(formatMeasureValue(1 / 3)).toBe("0.333333");
    expect(formatMeasureValue(161.29)).toBe("161.29");
  });

  it("switches to exponential only at extreme magnitudes", () => {
    expect(formatMeasureValue(2e-7)).toBe("2.000e-7");
    expect(formatMeasureValue(2.5e7)).toBe("2.500e+7");
    expect(formatMeasureValue(0.001)).toBe("0.001");
  });

  it("degrades non-finite values to a placeholder, never NaN text", () => {
    expect(formatMeasureValue(NaN)).toBe("—");
    expect(formatMeasureValue(Infinity)).toBe("—");
    expect(formatMeasureValue(0)).toBe("0");
  });
});
