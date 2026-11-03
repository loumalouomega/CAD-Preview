import { describe, expect, it } from "vitest";
import { applyCompletion, completeExpression, moveCompletionIndex } from "./expressionCompletion";

const labels = (r: ReturnType<typeof completeExpression>): string[] => (r ? r.items.map((i) => i.label) : []);

describe("completeExpression", () => {
  it("offers variables before functions, filtered by case-insensitive prefix", () => {
    expect(labels(completeExpression("s", 1, ["size", "L"]))).toEqual(["size", "sqrt", "sin"]);
    expect(labels(completeExpression("SI", 2, ["size"]))).toEqual(["size", "sin"]);
  });

  it("completes the identifier before the caret inside a larger expression", () => {
    const r = completeExpression("2*(wid + 1)", 6, ["width", "L"])!;
    expect(r.from).toBe(3);
    expect(r.to).toBe(6);
    expect(labels(r)).toEqual(["width"]);
  });

  it("offers constants", () => {
    expect(labels(completeExpression("p", 1, []))).toEqual(["pi"]);
  });

  it("has nothing to offer with no prefix, a numeric prefix, or inside a unit bracket", () => {
    expect(completeExpression("", 0, ["L"])).toBeNull();
    expect(completeExpression("2*", 2, ["L"])).toBeNull();
    expect(completeExpression("2e", 2, ["e1"])).toBeNull();
    expect(completeExpression("5[m", 3, ["mm1"])).toBeNull();
    expect(completeExpression("5[mm] + L", 9, ["L2"])).not.toBeNull();
  });

  it("does not offer a word that is already whole, but still offers a bare function", () => {
    expect(completeExpression("L", 1, ["L"])).toBeNull();
    expect(completeExpression("pi", 2, [])).toBeNull();
    expect(labels(completeExpression("sqrt", 4, []))).toEqual(["sqrt"]);
    expect(completeExpression("sqrt(", 4, [])).toBeNull();
  });

  it("only names the caller passes are offered (the 'defined above' filter is the caller's)", () => {
    expect(labels(completeExpression("b", 1, ["a"]))).toEqual([]);
    expect(completeExpression("b", 1, ["a"])).toBeNull();
  });
});

describe("applyCompletion", () => {
  it("inserts a variable and puts the caret after it", () => {
    const r = completeExpression("2*wi", 4, ["width"])!;
    expect(applyCompletion("2*wi", r, r.items[0])).toEqual({ text: "2*width", caret: 7 });
  });

  it("a function gains its opening parenthesis; text after the caret is kept", () => {
    const r = completeExpression("sq + 1", 2, [])!;
    expect(applyCompletion("sq + 1", r, r.items[0])).toEqual({ text: "sqrt( + 1", caret: 5 });
  });
});

describe("moveCompletionIndex", () => {
  it("wraps both ways", () => {
    expect(moveCompletionIndex(0, -1, 3)).toBe(2);
    expect(moveCompletionIndex(2, 1, 3)).toBe(0);
    expect(moveCompletionIndex(1, 1, 3)).toBe(2);
    expect(moveCompletionIndex(0, 1, 0)).toBe(0);
  });
});
