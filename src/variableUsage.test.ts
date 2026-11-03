import { describe, expect, it } from "vitest";
import { collectVariableUsage, deleteTooltip, EMPTY_USAGE, usageSummary } from "./variableUsage";

const ops: Array<{ op: string; exprs?: Record<string, string> }> = [
  { op: "addBox", exprs: { "size[0]": "L*2", "size[1]": "L" } },
  { op: "translate" },
  { op: "fillet", exprs: { amount: "r + L", angleDeg: "sqrt(W)" } },
];
const vars = [
  { name: "L", expr: "10" },
  { name: "W", expr: "L / 2" },
  { name: "r", expr: "W + L" },
];

describe("collectVariableUsage", () => {
  const usage = collectVariableUsage(ops, vars);

  it("lists each referencing op with its field paths and a field total", () => {
    const l = usage.get("L")!;
    expect(l.ops).toEqual([
      { opIndex: 0, op: "addBox", fields: ["size[0]", "size[1]"] },
      { opIndex: 2, op: "fillet", fields: ["amount"] },
    ]);
    expect(l.fieldCount).toBe(3);
  });

  it("lists other variables that reference it, once each, never itself", () => {
    expect(usage.get("L")!.variables).toEqual(["W", "r"]);
    expect(usage.get("W")!.variables).toEqual(["r"]);
    expect(usage.get("r")!.variables).toEqual([]);
  });

  it("omits unused variables and ignores functions and constants", () => {
    expect(usage.has("sqrt")).toBe(false);
    expect(collectVariableUsage([{ op: "x", exprs: { a: "pi*2" } }], [{ name: "K", expr: "1" }]).size).toBe(0);
  });

  it("the delete tooltip and the summary quote the same field count", () => {
    const l = usage.get("L")!;
    expect(usageSummary(l)).toBe("3 edit fields and 2 variables");
    expect(deleteTooltip(l)).toContain(`referenced by ${usageSummary(l)}`);
    expect(deleteTooltip(l)).toContain("freeze");
    expect(deleteTooltip(EMPTY_USAGE)).toBe("Delete variable");
  });

  it("singular wording and variable-only references", () => {
    expect(usageSummary({ ops: [], fieldCount: 1, variables: [] })).toBe("1 edit field");
    const t = deleteTooltip({ ops: [], fieldCount: 0, variables: ["a"] });
    expect(t).toBe("Delete variable (referenced by 1 variable)");
  });

  it("a malformed expression references nothing", () => {
    expect(collectVariableUsage([{ op: "x", exprs: { a: "L +" } }], [{ name: "L", expr: "1" }]).size).toBe(0);
  });
});
