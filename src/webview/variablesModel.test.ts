import { describe, it, expect, vi } from "vitest";
import { VariablesModel } from "./variablesModel";

describe("VariablesModel", () => {
  it("load replaces without firing onChange", () => {
    const onChange = vi.fn();
    const m = new VariablesModel(onChange);
    m.load([{ name: "L", expr: "20", value: 20 }]);
    expect(onChange).not.toHaveBeenCalled();
    expect(m.list()).toEqual([{ name: "L", expr: "20", value: 20 }]);
  });

  it("list returns clones", () => {
    const m = new VariablesModel(() => {});
    m.load([{ name: "L", expr: "20", value: 20 }]);
    m.list()[0].name = "hacked";
    expect(m.list()[0].name).toBe("L");
  });

  it("add auto-names uniquely and fires", () => {
    const onChange = vi.fn();
    const m = new VariablesModel(onChange);
    m.add();
    m.add();
    expect(m.list().map((v) => v.name)).toEqual(["L1", "L2"]);
    expect(onChange).toHaveBeenCalledTimes(2);
    // collision skipping
    expect(m.rename(0, "L3")).toBe(true);
    m.add();
    expect(m.list().map((v) => v.name)).toEqual(["L3", "L2", "L4"]);
  });

  it("rename enforces valid, unique names", () => {
    const onChange = vi.fn();
    const m = new VariablesModel(onChange);
    m.load([
      { name: "L", expr: "20", value: 20 },
      { name: "W", expr: "10", value: 10 },
    ]);
    expect(m.rename(0, "2bad")).toBe(false);
    expect(m.rename(0, "pi")).toBe(false); // reserved
    expect(m.rename(0, "W")).toBe(false);  // duplicate
    expect(onChange).not.toHaveBeenCalled();
    expect(m.rename(0, "length")).toBe(true);
    expect(m.list()[0].name).toBe("length");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("setExpr updates and fires only on real change", () => {
    const onChange = vi.fn();
    const m = new VariablesModel(onChange);
    m.load([{ name: "L", expr: "20", value: 20 }]);
    m.setExpr(0, "20");   // unchanged
    m.setExpr(0, "  ");   // empty
    expect(onChange).not.toHaveBeenCalled();
    m.setExpr(0, "L2*4");
    expect(m.list()[0].expr).toBe("L2*4");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("remove drops the row and fires", () => {
    const onChange = vi.fn();
    const m = new VariablesModel(onChange);
    m.load([
      { name: "L", expr: "20", value: 20 },
      { name: "W", expr: "10", value: 10 },
    ]);
    m.remove(0);
    expect(m.list().map((v) => v.name)).toEqual(["W"]);
    expect(onChange).toHaveBeenCalledTimes(1);
    m.remove(5); // out of range: no-op
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
