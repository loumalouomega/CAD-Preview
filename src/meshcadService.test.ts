import { describe, it, expect } from "vitest";
import { surfaceToMsh41 } from "./meshcadService";

// The live behaviour (meshio++ WASM, Gmsh merge) is pinned in `mcp:smoke`;
// the MSH writer is pure, so its exact layout is pinned here.
const quad = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];

describe("surfaceToMsh41", () => {
  it("writes every triangle on the ONE surface entity (dim 2, tag 1) with 1-based tags", () => {
    const text = surfaceToMsh41(quad, [{ type: "triangle", data: [0, 1, 2, 0, 2, 3] }]);
    expect(text).toBe(
      [
        "$MeshFormat", "4.1 0 8", "$EndMeshFormat",
        "$Nodes", "1 4 1 4", "2 1 0 4", "1", "2", "3", "4",
        "0 0 0", "1 0 0", "1 1 0", "0 1 0",
        "$EndNodes",
        "$Elements", "1 2 1 2", "2 1 2 2",
        "1 1 2 3", "2 1 3 4",
        "$EndElements", "",
      ].join("\n")
    );
  });

  it("maps triangle6 / triangle10 to Gmsh types 9 / 21 and numbers elements across blocks", () => {
    const pts = Array.from({ length: 10 * 3 }, (_, i) => i);
    const text = surfaceToMsh41(pts, [
      { type: "triangle", data: [0, 1, 2] },
      { type: "triangle6", data: [0, 1, 2, 3, 4, 5] },
      { type: "triangle10", data: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
    ]);
    const lines = text.split("\n");
    expect(lines.slice(lines.indexOf("$Elements") + 1)).toEqual([
      "3 3 1 3",
      "2 1 2 1", "1 1 2 3",
      "2 1 9 1", "2 1 2 3 4 5 6",
      "2 1 21 1", "3 1 2 3 4 5 6 7 8 9 10",
      "$EndElements", "",
    ]);
  });

  it("reads meshio++'s BigInt64Array connectivity", () => {
    const text = surfaceToMsh41(quad, [{ type: "triangle", data: BigInt64Array.from([0n, 1n, 2n]) }]);
    expect(text).toContain("1 1 2 3");
  });

  it("refuses a block it cannot place instead of dropping it silently", () => {
    expect(() => surfaceToMsh41(quad, [{ type: "line", data: [0, 1] }])).toThrow(/"line" block/);
    expect(() => surfaceToMsh41(quad, [{ type: "tetra", data: [0, 1, 2, 3] }])).toThrow(/"tetra" block/);
  });

  it("skips empty blocks and writes an explicit empty section for an empty mesh", () => {
    expect(surfaceToMsh41([], [{ type: "triangle", data: [] }])).toBe(
      ["$MeshFormat", "4.1 0 8", "$EndMeshFormat", "$Nodes", "0 0 0 0", "$EndNodes", "$Elements", "0 0 0 0", "$EndElements", ""].join("\n")
    );
  });
});
