import { describe, it, expect } from "vitest";
import { remeshedParts } from "./mmgParts";
import type { Part } from "./protocol";

const part = (name: string, face: string, color = "#123456"): Part => ({ name, color, volumes: [], surfaces: [face], lines: [], points: [] });
describe("remeshed Parts", () => {
  it("keeps colour and size, uses NEW facet ids and never copies CAD selectors", () => {
    const old = { ...part("Wall", "face-99", "#ff0000"), meshSize: 0.5,
      selector: { version: 1 as const, source: { kind: "scene" as const, filter: { kind: "planar" as const } } } };
    const result = remeshedParts([part("Wall", "face-0")], [old], ["Wall"]);
    expect(result.parts).toEqual([{ ...part("Wall", "face-0", "#ff0000"), meshSize: 0.5 }]);
    expect(result.warnings.join(" ")).toMatch(/selectors/);
  });
  it("refuses positional Parts that have no cell-region counterpart", () => {
    expect(() => remeshedParts([], [part("Manual", "face-0")], [])).toThrow(/no named cell region/);
  });
  it("warns about surviving interior-only or overlapping regions without boundary Parts", () => {
    expect(remeshedParts([], [part("Interior", "face-0")], ["Interior"]).warnings.join(" ")).toMatch(/survives in the mesh/);
  });
});
