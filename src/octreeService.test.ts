import { describe, it, expect } from "vitest";
import { octreeToMsh41, octreeElementMix } from "./octreeService";

/** Splits an MSH file into its `$Section ... $EndSection` bodies. */
function sections(msh: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let current: string | null = null;
  let body: string[] = [];
  for (const line of msh.split("\n")) {
    if (line.startsWith("$End")) {
      if (current) out[current] = body;
      current = null;
      body = [];
    } else if (line.startsWith("$")) {
      current = line.slice(1);
      body = [];
    } else if (current) body.push(line);
  }
  return out;
}

// Unit cube corners in Gmsh order: base ring 0..3 then the ring above it.
const CUBE = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const HEX = [0, 1, 2, 3, 4, 5, 6, 7];

describe("octreeToMsh41", () => {
  it("writes a single hexahedron as element type 5 with 1-based tags", () => {
    const s = sections(octreeToMsh41(CUBE, [{ type: "hexahedron", data: HEX }]));
    expect(s["MeshFormat"]).toEqual(["4.1 0 8"]);
    expect(s["Nodes"][0]).toBe("1 8 1 8");
    expect(s["Nodes"]).toContain("1 1 1"); // node 8's coordinates, after the 8 tag lines
    expect(s["Elements"]).toEqual(["1 1 1 1", "3 1 5 1", "1 1 2 3 4 5 6 7 8"]);
  });

  it("writes one block per class, all on volume entity 1, with element tags sequential across blocks", () => {
    const pts = [...CUBE, 0.5, 0.5, 2];
    const s = sections(
      octreeToMsh41(pts, [
        { type: "hexahedron", data: HEX },
        { type: "pyramid", data: [4, 5, 6, 7, 8] },
        { type: "tetra", data: [0, 1, 2, 4, 1, 2, 3, 5] },
      ])
    );
    expect(s["Elements"]).toEqual([
      "3 4 1 4", // 3 blocks, 4 elements, tags 1..4
      "3 1 5 1", "1 1 2 3 4 5 6 7 8",
      "3 1 7 1", "2 5 6 7 8 9",
      "3 1 4 2", "3 1 2 3 5", "4 2 3 4 6",
    ]);
  });

  it("accepts BigInt64Array connectivity (meshio++ >= 11.2 integer arrays)", () => {
    const s = sections(octreeToMsh41(CUBE, [{ type: "hexahedron", data: BigInt64Array.from(HEX.map(BigInt)) }]));
    expect(s["Elements"][2]).toBe("1 1 2 3 4 5 6 7 8");
  });

  it("refuses a block the templates transition never emits instead of dropping it", () => {
    expect(() => octreeToMsh41(CUBE, [{ type: "polyhedron", data: [1, 2, 3] }])).toThrow(/polyhedron/);
    expect(() => octreeToMsh41(CUBE, [{ type: "quad", data: [0, 1, 2, 3] }])).toThrow(/"quad"/);
  });

  it("stays a structurally valid empty file with no cells", () => {
    const s = sections(octreeToMsh41([], []));
    expect(s["Nodes"]).toEqual(["0 0 0 0"]);
    expect(s["Elements"]).toEqual(["0 0 0 0"]);
  });
});

describe("octreeElementMix", () => {
  it("counts cells by class from connectivity length", () => {
    expect(
      octreeElementMix([
        { type: "hexahedron", data: new Array(16).fill(0) },
        { type: "pyramid", data: new Array(15).fill(0) },
        { type: "tetra", data: new Array(8).fill(0) },
        { type: "vertex", data: [0, 1] },
      ])
    ).toEqual({ hexahedra: 2, pyramids: 3, tetrahedra: 2 });
  });
});
