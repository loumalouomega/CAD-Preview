import { describe, it, expect } from "vitest";
import { viridis, viridisHex, valueToColor, viridisCssGradientStops } from "./colorMap";

describe("viridis", () => {
  it("returns the exact stop colours at t=0, 0.25, 0.5, 0.75, 1", () => {
    expect(viridis(0)).toEqual([68 / 255, 1 / 255, 84 / 255]);
    expect(viridis(1)).toEqual([253 / 255, 231 / 255, 37 / 255]);
    const mid = viridis(0.5);
    expect(mid[0]).toBeCloseTo(33 / 255, 5);
    expect(mid[1]).toBeCloseTo(144 / 255, 5);
    expect(mid[2]).toBeCloseTo(141 / 255, 5);
  });

  it("clamps out-of-range t", () => {
    expect(viridis(-1)).toEqual(viridis(0));
    expect(viridis(2)).toEqual(viridis(1));
  });

  it("is monotonically interpolated between stops (no NaN, values in [0,1])", () => {
    for (let i = 0; i <= 20; i++) {
      const [r, g, b] = viridis(i / 20);
      for (const c of [r, g, b]) {
        expect(Number.isNaN(c)).toBe(false);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("viridisHex", () => {
  it("returns a well-formed #rrggbb string", () => {
    expect(viridisHex(0)).toMatch(/^#[0-9a-f]{6}$/);
    expect(viridisHex(1)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("valueToColor", () => {
  it("maps min/max to the same colours as t=0/t=1", () => {
    expect(valueToColor(0, 0, 10)).toEqual(viridis(0));
    expect(valueToColor(10, 0, 10)).toEqual(viridis(1));
    expect(valueToColor(5, 0, 10)).toEqual(viridis(0.5));
  });

  it("degenerates to the ramp midpoint for a constant field (min === max)", () => {
    expect(valueToColor(7, 7, 7)).toEqual(viridis(0.5));
  });

  it("handles an inverted/invalid range (max < min) the same way as constant", () => {
    expect(valueToColor(3, 10, 0)).toEqual(viridis(0.5));
  });
});

describe("viridisCssGradientStops", () => {
  it("produces steps+1 comma-separated '#hex N%' entries from 0% to 100%", () => {
    const stops = viridisCssGradientStops(4).split(", ");
    expect(stops).toHaveLength(5);
    expect(stops[0]).toMatch(/^#[0-9a-f]{6} 0%$/);
    expect(stops[4]).toMatch(/^#[0-9a-f]{6} 100%$/);
  });
});
