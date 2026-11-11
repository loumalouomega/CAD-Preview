import { describe, it, expect } from "vitest";
import { formatRefinementRegions, parseRefinementRegionText } from "./refinementRegionText";

describe("refinementRegionText", () => {
  const text = [
    "sphere 0 0 0 1.5 0.4 1  # wake",
    "box -1 -1 -1  1 1 1  0.5",
    "cylinder 0 0 0  2 0 0  0.8 0.3  # weld",
  ].join("\n");

  it("parses all three kinds, with optional thickness and trailing names", () => {
    const { regions, problems } = parseRefinementRegionText(text);
    expect(problems).toEqual([]);
    expect(regions).toEqual([
      { kind: "sphere", center: [0, 0, 0], radius: 1.5, sizeIn: 0.4, thickness: 1, name: "wake" },
      { kind: "box", min: [-1, -1, -1], max: [1, 1, 1], sizeIn: 0.5, thickness: 0 },
      { kind: "cylinder", center: [0, 0, 0], axis: [2, 0, 0], radius: 0.8, sizeIn: 0.3, name: "weld" },
    ]);
  });

  it("round-trips through format", () => {
    const { regions } = parseRefinementRegionText(text);
    expect(parseRefinementRegionText(formatRefinementRegions(regions)).regions).toEqual(regions);
    expect(formatRefinementRegions(undefined)).toBe("");
  });

  it("reports each rejected line by number and keeps the good ones", () => {
    const { regions, problems } = parseRefinementRegionText(
      ["", "torus 1 2 3", "sphere 0 0 0 1", "sphere 0 0 0 -1 0.5", "box 0 0 0 0 1 1 0.5", "cylinder 0 0 0 0 0 0 1 0.5", "sphere 0 0 0 1 0.5"].join("\n")
    );
    expect(regions).toHaveLength(1);
    expect(problems.map((p) => p.slice(0, 7))).toEqual(["Line 2:", "Line 3:", "Line 4:", "Line 5:", "Line 6:"]);
  });

  it("treats blank and comment-only lines as nothing", () => {
    expect(parseRefinementRegionText("\n  \n# just a note\n")).toEqual({ regions: [], problems: [] });
  });
});
