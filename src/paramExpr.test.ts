import { describe, it, expect } from "vitest";
import {
  evalExpr, parseExprSyntax, extractIdentifiers, isValidVariableName,
  parseFieldPath, getNumericField, setNumericField,
} from "./paramExpr";

function val(src: string, vars: Record<string, number> = {}): number {
  const r = evalExpr(src, vars);
  if (!r.ok) throw new Error(`expected ok for '${src}': ${r.error}`);
  return r.value;
}

function err(src: string, vars: Record<string, number> = {}): string {
  const r = evalExpr(src, vars);
  if (r.ok) throw new Error(`expected error for '${src}', got ${r.value}`);
  return r.error;
}

describe("evalExpr", () => {
  it("evaluates numeric literals", () => {
    expect(val("42")).toBe(42);
    expect(val("3.5")).toBe(3.5);
    expect(val(".5")).toBe(0.5);
    expect(val("1e3")).toBe(1000);
    expect(val("2.5e-2")).toBe(0.025);
  });

  it("applies precedence and associativity", () => {
    expect(val("1+2*3")).toBe(7);
    expect(val("(1+2)*3")).toBe(9);
    expect(val("10-4-3")).toBe(3); // left-assoc
    expect(val("12/3/2")).toBe(2); // left-assoc
    expect(val("2^3^2")).toBe(512); // right-assoc
    expect(val("2*3^2")).toBe(18); // ^ binds tighter than *
    expect(val("-2^2")).toBe(-4); // unary minus outside the power
  });

  it("handles unary signs", () => {
    expect(val("-5")).toBe(-5);
    expect(val("+5")).toBe(5);
    expect(val("--5")).toBe(5);
    expect(val("2*-3")).toBe(-6);
  });

  it("resolves variables", () => {
    expect(val("L", { L: 20 })).toBe(20);
    expect(val("L*2 + W/4", { L: 20, W: 8 })).toBe(42);
  });

  it("supports functions (trig in degrees) and pi", () => {
    expect(val("sqrt(16)")).toBe(4);
    expect(val("abs(-3)")).toBe(3);
    expect(val("min(3, 1, 2)")).toBe(1);
    expect(val("max(3, 1, 2)")).toBe(3);
    expect(val("floor(1.9)")).toBe(1);
    expect(val("ceil(1.1)")).toBe(2);
    expect(val("round(1.5)")).toBe(2);
    expect(val("sin(30)")).toBeCloseTo(0.5, 10);
    expect(val("cos(60)")).toBeCloseTo(0.5, 10);
    expect(val("tan(45)")).toBeCloseTo(1, 10);
    expect(val("pi")).toBeCloseTo(Math.PI, 12);
  });

  it("errors on unknown variables and functions", () => {
    expect(err("L")).toContain("unknown variable");
    expect(err("nope(1)")).toContain("unknown function");
  });

  it("errors on non-finite results", () => {
    expect(err("1/0")).toContain("finite");
    expect(err("sqrt(-1)")).toContain("finite");
  });

  it("errors on syntax problems", () => {
    err("");
    err("   ");
    err("1 +");
    err("(1+2");
    err("1 2");
    err("2 ** 3");
    err("a & b", { a: 1, b: 2 });
  });
});

describe("parseExprSyntax", () => {
  it("accepts expressions with unknown identifiers", () => {
    expect(parseExprSyntax("L*2 + notYetDefined")).toBe(true);
    expect(parseExprSyntax("sqrt(L)")).toBe(true);
  });
  it("rejects malformed input", () => {
    expect(parseExprSyntax("")).toBe(false);
    expect(parseExprSyntax("1 +")).toBe(false);
    expect(parseExprSyntax("$L")).toBe(false);
    expect(parseExprSyntax("nope(1)")).toBe(false); // unknown function is still a syntax-level error
  });
});

describe("extractIdentifiers", () => {
  it("lists variables, not functions/constants", () => {
    expect(extractIdentifiers("L*2 + sqrt(W) - pi").sort()).toEqual(["L", "W"]);
    expect(extractIdentifiers("42")).toEqual([]);
  });
  it("returns [] on unparseable input", () => {
    expect(extractIdentifiers("1 +")).toEqual([]);
  });
});

describe("isValidVariableName", () => {
  it("accepts identifier-shaped names", () => {
    expect(isValidVariableName("L")).toBe(true);
    expect(isValidVariableName("wall_thickness2")).toBe(true);
    expect(isValidVariableName("_x")).toBe(true);
  });
  it("rejects non-identifiers and reserved names", () => {
    expect(isValidVariableName("")).toBe(false);
    expect(isValidVariableName("2L")).toBe(false);
    expect(isValidVariableName("a-b")).toBe(false);
    expect(isValidVariableName("sqrt")).toBe(false);
    expect(isValidVariableName("pi")).toBe(false);
  });
});

describe("field paths", () => {
  it("parses scalar, vec, and point paths", () => {
    expect(parseFieldPath("length")).toEqual(["length"]);
    expect(parseFieldPath("size[1]")).toEqual(["size", 1]);
    expect(parseFieldPath("points[2][0]")).toEqual(["points", 2, 0]);
  });

  it("rejects malformed and unsafe paths", () => {
    expect(parseFieldPath("")).toBeNull();
    expect(parseFieldPath("size[x]")).toBeNull();
    expect(parseFieldPath("a[0][0][0]")).toBeNull(); // depth > 2
    expect(parseFieldPath("__proto__")).toBeNull();
    expect(parseFieldPath("__proto__[0]")).toBeNull();
    expect(parseFieldPath("a.b")).toBeNull();
  });

  it("gets numeric fields only", () => {
    const op = { op: "addBox", center: [0, 1, 2], size: [10, 20, 30] };
    expect(getNumericField(op, ["size", 1])).toBe(20);
    expect(getNumericField(op, ["center", 0])).toBe(0);
    expect(getNumericField(op, ["op"])).toBeNull(); // string slot
    expect(getNumericField(op, ["size", 5])).toBeNull(); // out of range
    expect(getNumericField(op, ["missing"])).toBeNull();
  });

  it("sets only slots that currently hold a finite number", () => {
    const op = { op: "extrude", profile: "face-1", dir: [0, 0, 1], length: 5, points: [[1, 2, 3], [4, 5, 6]] };
    expect(setNumericField(op, ["length"], 9)).toBe(true);
    expect(op.length).toBe(9);
    expect(setNumericField(op, ["points", 1, 2], 60)).toBe(true);
    expect(op.points[1][2]).toBe(60);
    expect(setNumericField(op, ["profile"], 1)).toBe(false); // string slot untouched
    expect(op.profile).toBe("face-1");
    expect(setNumericField(op, ["points", 9, 0], 1)).toBe(false); // out of range
  });
});
