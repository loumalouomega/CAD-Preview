import { describe, expect, it } from "vitest";
import { annotatedLabelText, evaluateToleranceBand, formatToleranceBand } from "./toleranceBand";

describe("evaluateToleranceBand", () => {
  it("reports a signed deviation and in-band membership for a symmetric band", () => {
    const r = evaluateToleranceBand(10.02, { nominal: 10, plus: 0.05, minus: 0.05 });
    expect(r).not.toBeNull();
    expect(r!.deviation).toBeCloseTo(0.02, 12);
    expect(r!.withinTolerance).toBe(true);
  });

  it("is a fact about position relative to the band — out-of-band on either side", () => {
    expect(evaluateToleranceBand(10.2, { nominal: 10, plus: 0.05, minus: 0.05 })!.withinTolerance).toBe(false);
    expect(evaluateToleranceBand(9.9, { nominal: 10, plus: 0.05, minus: 0.05 })!.withinTolerance).toBe(false);
  });

  it("honours an asymmetric band (more above than below)", () => {
    const band = { nominal: 10, plus: 0.2, minus: 0.05 };
    expect(evaluateToleranceBand(10.15, band)!.withinTolerance).toBe(true);
    expect(evaluateToleranceBand(10.25, band)!.withinTolerance).toBe(false);
    expect(evaluateToleranceBand(9.96, band)!.withinTolerance).toBe(true);
    expect(evaluateToleranceBand(9.94, band)!.withinTolerance).toBe(false);
  });

  it("includes values exactly on either band limit (integer-exact boundary case)", () => {
    const band = { nominal: 10, plus: 2, minus: 1 };
    expect(evaluateToleranceBand(12, band)!.withinTolerance).toBe(true); // exactly +plus
    expect(evaluateToleranceBand(9, band)!.withinTolerance).toBe(true); // exactly −minus
    expect(evaluateToleranceBand(12.000001, band)!.withinTolerance).toBe(false);
    expect(evaluateToleranceBand(8.999999, band)!.withinTolerance).toBe(false);
  });

  it("treats the exact nominal as in-band with deviation 0", () => {
    const r = evaluateToleranceBand(10, { nominal: 10, plus: 0.01, minus: 0.01 })!;
    expect(r.deviation).toBe(0);
    expect(r.withinTolerance).toBe(true);
  });

  it("returns null for non-finite input rather than fabricating a comparison", () => {
    expect(evaluateToleranceBand(NaN, { nominal: 10, plus: 1, minus: 1 })).toBeNull();
    expect(evaluateToleranceBand(10, { nominal: NaN, plus: 1, minus: 1 })).toBeNull();
    expect(evaluateToleranceBand(Infinity, { nominal: 10, plus: 1, minus: 1 })).toBeNull();
  });
});

describe("formatToleranceBand", () => {
  it("uses the symmetric ± form when plus equals minus", () => {
    expect(formatToleranceBand({ nominal: 10, plus: 0.05, minus: 0.05 })).toBe("±0.05");
  });

  it("uses the asymmetric form otherwise", () => {
    expect(formatToleranceBand({ nominal: 10, plus: 0.2, minus: 0.05 })).toBe("+0.2/−0.05");
  });
});

describe("annotatedLabelText", () => {
  it("appends the band after the verbatim frozen measurement text", () => {
    expect(annotatedLabelText("12.5 mm", { nominal: 10, plus: 0.05, minus: 0.05 })).toBe("12.5 mm [10 ±0.05]");
    expect(annotatedLabelText("R = 3 mm", { nominal: 3, plus: 0.1, minus: 0.02 })).toBe("R = 3 mm [3 +0.1/−0.02]");
  });

  it("returns the plain text for a missing or malformed band — every existing annotation renders unchanged", () => {
    expect(annotatedLabelText("12.5 mm")).toBe("12.5 mm");
    expect(annotatedLabelText("12.5 mm", undefined)).toBe("12.5 mm");
    expect(annotatedLabelText("12.5 mm", { nominal: NaN } as never)).toBe("12.5 mm");
    expect(annotatedLabelText("42°", { nominal: 40, plus: "x" as unknown as number, minus: 1 })).toBe("42°");
  });
});
