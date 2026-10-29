import { describe, expect, it } from "vitest";
import { buildPrismCall, plannedPrismThickness, summarizePrismLayers, wedgesToMsh41 } from "./prismLayers";

describe("buildPrismCall", () => {
  it("requires firstHeight and forwards only the keys that were given", () => {
    expect(() => buildPrismCall({})).toThrow(/firstHeight is required/);
    const r = buildPrismCall({ firstHeight: 0.05 });
    expect(r.call).toEqual({ firstHeight: 0.05 });
    expect(r.numLayers).toBe(3);
    expect(r.growth).toBe(1.2);
    const full = buildPrismCall({ firstHeight: 0.05, numLayers: 4, growth: 1.5, reverse: true, collapse: "layers", frontCheck: false });
    expect(full.call).toEqual({ firstHeight: 0.05, numLayers: 4, growth: 1.5, reverse: true, collapse: "layers", frontCheck: false });
    expect(Object.keys(full.call)).toEqual(["firstHeight", "numLayers", "growth", "reverse", "collapse", "frontCheck"]);
  });

  it("rejects out-of-range values by name", () => {
    const bad = (o: object, re: RegExp) => expect(() => buildPrismCall({ firstHeight: 1, ...o } as never)).toThrow(re);
    bad({ firstHeight: 0 }, /firstHeight/);
    bad({ numLayers: 0 }, /numLayers must be an integer from 1 to 1000/);
    bad({ numLayers: 1.5 }, /numLayers/);
    bad({ growth: 0.9 }, /growth/);
    bad({ growth: 11 }, /growth/);
    bad({ collapse: "x" }, /collapse must be/);
    bad({ collisionFraction: 0 }, /collisionFraction/);
    bad({ smoothIterations: -1 }, /smoothIterations/);
  });
});

describe("plannedPrismThickness", () => {
  it("is the geometric series, and linear for growth 1", () => {
    expect(plannedPrismThickness(0.05, 3, 1.2)).toBeCloseTo(0.182, 12); // block.stp probe: thickness 0.182
    expect(plannedPrismThickness(0.1, 4, 1)).toBeCloseTo(0.4, 12);
  });
});

describe("summarizePrismLayers", () => {
  const planned = { firstHeight: 0.05, numLayers: 3, growth: 1.2 };
  const clean = { numCells: 756, numWedges: 756, numShrunk: 0, numCollapsed: 0, numFewerLayers: 0, numFrontCrossings: 0, minScaledJacobian: 0.27, minThickness: 0.182, maxThickness: 0.182, capClosed: true, warnings: [] };

  it("reports no shortfall warning for a clean run", () => {
    const r = summarizePrismLayers(clean, planned);
    expect(r.warnings).toEqual([]);
    expect(r.plannedThickness).toBeCloseTo(0.182, 12);
    expect(r.numWedges).toBe(756);
  });

  it("warns about shrunk points and a non-positive Jacobian, and keeps upstream warnings first", () => {
    const r = summarizePrismLayers({ ...clean, numShrunk: 113, minScaledJacobian: -0.1, minThickness: 0, warnings: ["1 points do not grow"] }, planned);
    expect(r.warnings[0]).toBe("1 points do not grow");
    expect(r.warnings.some((w) => /113 point\(s\) grew a thinner stack/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /not positive/.test(w))).toBe(true);
  });

  it("flags an open cap", () => {
    expect(summarizePrismLayers({ ...clean, capClosed: false }, planned).warnings.some((w) => /cap is not a closed/.test(w))).toBe(true);
  });
});

describe("wedgesToMsh41", () => {
  const pts = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1];
  it("writes ONE volume entity (dim 3, tag 1) of Gmsh type 6 with 1-based nodes and drops triangle blocks", () => {
    const msh = wedgesToMsh41(pts, [
      { type: "triangle", data: BigInt64Array.from([0n, 1n, 2n]) },
      { type: "wedge", data: BigInt64Array.from([0n, 1n, 2n, 3n, 4n, 5n]) },
    ]);
    expect(msh).toContain("$Nodes\n1 6 1 6\n3 1 0 6");
    expect(msh).toContain("$Elements\n1 1 1 1\n3 1 6 1\n1 1 2 3 4 5 6");
    expect(msh).not.toMatch(/\n2 1 2 /); // no dim-2 block
  });

  it("keeps pyramid / tetra cells of points that could not grow, on the same entity", () => {
    const msh = wedgesToMsh41(pts, [
      { type: "wedge", data: [0, 1, 2, 3, 4, 5] },
      { type: "pyramid", data: [0, 1, 4, 3, 5] },
    ]);
    expect(msh).toContain("$Elements\n2 2 1 2\n3 1 6 1\n1 1 2 3 4 5 6\n3 1 7 1\n2 1 2 5 4 6");
  });
});
