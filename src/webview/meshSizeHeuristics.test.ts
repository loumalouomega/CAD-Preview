import { describe, expect, it } from "vitest";
import {
  COARSE_DIVISOR,
  DEFAULT_SIZE_DIVISOR,
  FINE_DIVISOR,
  PRESET_DIVISORS,
  defaultTargetSize,
  formatCount,
  formatSize,
  sizeToSlider,
  sliderToSize,
} from "./meshSizeHeuristics";

const DIAGONAL = 100;

describe("sliderToSize / sizeToSlider", () => {
  it("maps the endpoints to the coarse/fine divisors", () => {
    expect(sliderToSize(0, DIAGONAL)).toBeCloseTo(DIAGONAL / COARSE_DIVISOR);
    expect(sliderToSize(1, DIAGONAL)).toBeCloseTo(DIAGONAL / FINE_DIVISOR);
  });

  it("round-trips through both directions", () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(sizeToSlider(sliderToSize(t, DIAGONAL), DIAGONAL)).toBeCloseTo(t);
    }
    for (const size of [DIAGONAL / 5, DIAGONAL / 20, DIAGONAL / 200]) {
      expect(sliderToSize(sizeToSlider(size, DIAGONAL), DIAGONAL)).toBeCloseTo(size);
    }
  });

  it("is monotonically decreasing in t (right = finer = smaller)", () => {
    let prev = Infinity;
    for (let t = 0; t <= 1; t += 0.1) {
      const size = sliderToSize(t, DIAGONAL);
      expect(size).toBeLessThan(prev);
      prev = size;
    }
  });

  it("clamps out-of-range inputs to the ends", () => {
    expect(sliderToSize(-1, DIAGONAL)).toBeCloseTo(DIAGONAL / COARSE_DIVISOR);
    expect(sliderToSize(2, DIAGONAL)).toBeCloseTo(DIAGONAL / FINE_DIVISOR);
    // A typed size coarser/finer than the slider's range pegs the thumb.
    expect(sizeToSlider(DIAGONAL, DIAGONAL)).toBe(0);
    expect(sizeToSlider(DIAGONAL / 1e6, DIAGONAL)).toBe(1);
  });

  it("tolerates degenerate sizes/diagonals without NaN", () => {
    expect(sizeToSlider(0, DIAGONAL)).toBe(0);
    expect(sizeToSlider(10, 0)).toBe(0);
    expect(sizeToSlider(NaN, DIAGONAL)).toBe(0);
  });
});

describe("defaultTargetSize / presets", () => {
  it("derives the default from the diagonal", () => {
    expect(defaultTargetSize(DIAGONAL)).toBeCloseTo(DIAGONAL / DEFAULT_SIZE_DIVISOR);
  });

  it("keeps every preset inside the slider's range", () => {
    for (const divisor of Object.values(PRESET_DIVISORS)) {
      expect(divisor).toBeGreaterThanOrEqual(COARSE_DIVISOR);
      expect(divisor).toBeLessThanOrEqual(FINE_DIVISOR);
      const t = sizeToSlider(DIAGONAL / divisor, DIAGONAL);
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(1);
    }
  });

  it("the medium preset matches the default size", () => {
    expect(DIAGONAL / PRESET_DIVISORS.medium).toBeCloseTo(defaultTargetSize(DIAGONAL));
  });
});

describe("formatCount / formatSize", () => {
  it("formats counts compactly", () => {
    expect(formatCount(850)).toBe("~850");
    expect(formatCount(999)).toBe("~999");
    expect(formatCount(1200)).toBe("~1.2k");
    expect(formatCount(12345)).toBe("~12k");
    expect(formatCount(1_200_000)).toBe("~1.2M");
    expect(formatCount(25_000_000)).toBe("~25M");
  });

  it("formats sizes to 3 significant digits without exponent noise", () => {
    expect(formatSize(4.2137)).toBe("4.21");
    expect(formatSize(5)).toBe("5");
    expect(formatSize(0.012345)).toBe("0.0123");
    expect(formatSize(123.45)).toBe("123");
    expect(formatSize(Infinity)).toBe("—");
  });
});
