import { describe, expect, it } from "vitest";
import { dimensionIssues, expectedFieldDimension, variableDimensions } from "./editVariables";
import { exprDimension } from "./paramExpr";
import { validateEditOp } from "./editOps";

describe("exprDimension", () => {
  it("reads units and propagates through sums, products and variables", () => {
    expect(exprDimension("5")).toBe("none");
    expect(exprDimension("2[in]")).toBe("length");
    expect(exprDimension("5[deg]")).toBe("angle");
    expect(exprDimension("2[in] + 3")).toBe("length");
    expect(exprDimension("2[in] + 5[deg]")).toBe("mixed");
    expect(exprDimension("2*W", { W: "length" })).toBe("length");
    expect(exprDimension("W/W", { W: "length" })).toBe("none");
    expect(exprDimension("W*W", { W: "length" })).toBe("none");
    expect(exprDimension("max(1[mm], 2)")).toBe("length");
    expect(exprDimension("sin(30[deg])")).toBe("none");
    expect(exprDimension("2[xx]")).toBeNull();
  });
});

describe("dimensionIssues", () => {
  const box = (exprs: Record<string, string>) => validateEditOp({ op: "addBox", center: [0, 0, 0], size: [1, 2, 3], exprs })!;
  it("classifies fields by name", () => {
    expect(expectedFieldDimension("angleDeg")).toBe("angle");
    expect(expectedFieldDimension("axisDir[0]")).toBe("none");
    expect(expectedFieldDimension("size[1]")).toBe("length");
  });
  it("warns on an angle driving a length, via a variable, and stays quiet otherwise", () => {
    const vars = [{ name: "W", expr: "5[deg]", value: 5 }, { name: "L", expr: "2[in]", value: 50.8 }];
    expect(variableDimensions(vars)).toEqual({ W: "angle", L: "length" });
    const issues = dimensionIssues([box({ "size[0]": "W", "size[1]": "L", "size[2]": "3" })], vars);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/size\[0\].*angle.*length/);
    expect(issues[0]).toMatch(/used as written/);
  });
});
