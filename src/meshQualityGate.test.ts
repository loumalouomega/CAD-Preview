import { describe, it, expect } from "vitest";
import { normalizeQualityGate, describeGateCheck } from "./meshQualityGate";

const raw = (over: object = {}) => ({
  passed: false,
  numCells: 100n,
  numInverted: 0,
  numDegenerate: 0,
  summary: "s",
  checks: [
    { name: "scaled_jacobian >= 0.99", metric: "quality:scaled_jacobian", min: 0.99, max: null, maxFraction: 0, evaluated: 80, violations: 80, fraction: 1, worst: 0.2, worstCell: 18n, passed: false, ...over },
  ],
});

describe("normalizeQualityGate", () => {
  it("passes the caller's facts through and converts bigint counts", () => {
    const r = normalizeQualityGate(raw());
    expect(r.numCells).toBe(100);
    expect(r.passed).toBe(false);
    expect(r.checks[0]).toMatchObject({ min: 0.99, max: null, evaluated: 80, violations: 80, worst: 0.2, worstCell: 18, vacuous: false });
    expect(r.vacuousChecks).toBe(0);
  });

  it("flags a clause that evaluated no cell as vacuous and drops its meaningless worst value", () => {
    const r = normalizeQualityGate(raw({ evaluated: 0, violations: 0, fraction: 0, worst: 0, worstCell: -1, passed: true }));
    expect(r.checks[0]).toMatchObject({ vacuous: true, worst: null, worstCell: null });
    expect(r.vacuousChecks).toBe(1);
  });

  it("maps non-finite bounds to null and tolerates a malformed result", () => {
    expect(normalizeQualityGate(raw({ min: Infinity, max: NaN })).checks[0]).toMatchObject({ min: null, max: null });
    expect(normalizeQualityGate(undefined)).toMatchObject({ passed: false, checks: [], numCells: 0 });
  });
});

describe("describeGateCheck", () => {
  it("states violations, fraction and worst cell; names a vacuous clause", () => {
    const [c] = normalizeQualityGate(raw()).checks;
    expect(describeGateCheck(c)).toBe("scaled_jacobian >= 0.99: 80 of 80 cells violate (100.0%), worst 0.2 at cell 18");
    const [v] = normalizeQualityGate(raw({ evaluated: 0 })).checks;
    expect(describeGateCheck(v)).toMatch(/vacuous/);
  });
});
