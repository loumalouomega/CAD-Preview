import { describe, it, expect } from "vitest";
import { namesForSolids } from "./xcafWrite";
import type { Part } from "./protocol";

function part(name: string, volumes: string[]): Part {
  return { name, color: "#ffffff", volumes, surfaces: [], lines: [], points: [] };
}

describe("namesForSolids", () => {
  it("returns undefined for every solid when there are no parts", () => {
    expect(namesForSolids(["solid-0", "solid-1"], [])).toEqual([undefined, undefined]);
  });

  it("names only the solids a part actually claims", () => {
    const parts = [part("Bracket", ["solid-0"]), part("Pin", ["solid-2"])];
    expect(namesForSolids(["solid-0", "solid-1", "solid-2"], parts)).toEqual(["Bracket", undefined, "Pin"]);
  });

  it("a part naming multiple solids names each of them", () => {
    const parts = [part("Frame", ["solid-0", "solid-1"])];
    expect(namesForSolids(["solid-0", "solid-1"], parts)).toEqual(["Frame", "Frame"]);
  });

  it("a solid claimed by two parts takes the first match", () => {
    const parts = [part("First", ["solid-0"]), part("Second", ["solid-0"])];
    expect(namesForSolids(["solid-0"], parts)).toEqual(["First"]);
  });

  it("preserves input order and length regardless of part order", () => {
    const parts = [part("Pin", ["solid-2"]), part("Bracket", ["solid-0"])];
    expect(namesForSolids(["solid-0", "solid-1", "solid-2"], parts)).toEqual(["Bracket", undefined, "Pin"]);
  });
});
