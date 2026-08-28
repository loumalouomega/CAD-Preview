import { describe, it, expect } from "vitest";
import { tetsToMsh41 } from "./ftetwildService";

/** Splits an MSH file into its top-level `$Section ... $EndSection` blocks,
 * keyed by section name, body lines only (no header/footer markers). */
function sections(msh: string): Record<string, string[]> {
  const lines = msh.split("\n");
  const out: Record<string, string[]> = {};
  let current: string | null = null;
  let body: string[] = [];
  for (const line of lines) {
    if (line.startsWith("$End")) {
      if (current) out[current] = body;
      current = null;
      body = [];
      continue;
    }
    if (line.startsWith("$")) {
      current = line.slice(1);
      body = [];
      continue;
    }
    if (current) body.push(line);
  }
  return out;
}

describe("tetsToMsh41", () => {
  it("emits a valid $MeshFormat 4.1 header", () => {
    const msh = tetsToMsh41([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 2, 3]);
    const s = sections(msh);
    expect(s["MeshFormat"]).toEqual(["4.1 0 8"]);
  });

  it("writes one node entity block with 1-based sequential tags matching input order", () => {
    const vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    const msh = tetsToMsh41(vertices, [0, 1, 2, 3]);
    const nodes = sections(msh)["Nodes"];
    // header: numEntityBlocks numNodes minTag maxTag
    expect(nodes[0]).toBe("1 4 1 4");
    // entity block: dim tag parametric numNodesInBlock
    expect(nodes[1]).toBe("3 1 0 4");
    // 4 node tags, then 4 coordinate lines, in that order
    expect(nodes.slice(2, 6)).toEqual(["1", "2", "3", "4"]);
    expect(nodes.slice(6, 10)).toEqual(["0 0 0", "1 0 0", "0 1 0", "0 0 1"]);
  });

  it("writes one element entity block, tet4 (type 4), 1-based node references offset from 0-based input, with the 3rd/4th node swapped to correct fTetWild's winding", () => {
    const vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    const msh = tetsToMsh41(vertices, [0, 1, 2, 3]);
    const elements = sections(msh)["Elements"];
    // header: numEntityBlocks numElements minTag maxTag
    expect(elements[0]).toBe("1 1 1 1");
    // entity block: dim tag elementType numElementsInBlock — type 4 = tet4
    expect(elements[1]).toBe("3 1 4 1");
    // element: tag n1 n2 n3 n4 — 0-based [0,1,2,3] becomes 1-based [1,2,3,4],
    // then nodes 3 and 4 (the input's c/d) are swapped: "1 1 2 4 3".
    expect(elements[2]).toBe("1 1 2 4 3");
  });

  it("handles multiple tetrahedra with correctly incrementing element tags and node references", () => {
    // Two disjoint tets sharing no vertices: 8 nodes, 2 elements.
    const vertices = [
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, // tet 1: nodes 0-3
      10, 0, 0, 11, 0, 0, 10, 1, 0, 10, 0, 1, // tet 2: nodes 4-7
    ];
    const tets = [0, 1, 2, 3, 4, 5, 6, 7];
    const msh = tetsToMsh41(vertices, tets);
    const s = sections(msh);
    expect(s["Nodes"][0]).toBe("1 8 1 8");
    const elements = s["Elements"];
    expect(elements[0]).toBe("1 2 1 2");
    // c/d swapped per tet: [1,2,3,4] -> "1 2 4 3", [5,6,7,8] -> "5 6 8 7".
    expect(elements[2]).toBe("1 1 2 4 3");
    expect(elements[3]).toBe("2 5 6 8 7");
  });

  it("produces a structurally valid, empty MSH for a zero-tet result rather than a malformed tag range", () => {
    const msh = tetsToMsh41([], []);
    const s = sections(msh);
    expect(s["Nodes"]).toEqual(["0 0 0 0"]);
    expect(s["Elements"]).toEqual(["0 0 0 0"]);
  });

  it("accepts a typed-array input identically to a plain array", () => {
    const vertices = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const tets = new Uint32Array([0, 1, 2, 3]);
    const fromTyped = tetsToMsh41(vertices, tets);
    const fromPlain = tetsToMsh41(Array.from(vertices), Array.from(tets));
    expect(fromTyped).toBe(fromPlain);
  });
});
