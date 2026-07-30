import { describe, it, expect } from "vitest";
import { parseStl } from "./stlParser";

const ASCII_TETRAHEDRON = `solid tetra
  facet normal 0 0 -1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
  facet normal 0 -1 0
    outer loop
      vertex 0 0 0
      vertex 0 0 1
      vertex 1 0 0
    endloop
  endfacet
endsolid tetra
`;

function buildBinaryStl(triangles: number[][][]): Uint8Array {
  const count = triangles.length;
  const buf = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buf);
  // 80-byte header left zeroed; deliberately starts with bytes that spell
  // "solid" to confirm binary detection doesn't fall for the classic
  // header-text-sniffing trap.
  const header = "solid deliberately-ascii-looking-binary-header";
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, count, true);
  let offset = 84;
  for (const triangle of triangles) {
    const [normal, a, b, c] = [[0, 0, 0], ...triangle];
    for (const [x, y, z] of [normal, a, b, c]) {
      view.setFloat32(offset, x, true); offset += 4;
      view.setFloat32(offset, y, true); offset += 4;
      view.setFloat32(offset, z, true); offset += 4;
    }
    offset += 2; // attribute byte count
  }
  return new Uint8Array(buf);
}

describe("parseStl", () => {
  it("parses ASCII STL vertex lines in order, 9 floats per triangle", () => {
    const bytes = new TextEncoder().encode(ASCII_TETRAHEDRON);
    const positions = parseStl(bytes);
    expect(positions.length).toBe(2 * 9);
    expect(Array.from(positions.slice(0, 9))).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(positions.slice(9, 18))).toEqual([0, 0, 0, 0, 0, 1, 1, 0, 0]);
  });

  it("parses binary STL correctly, even with an ASCII-looking header (not sniffed by header text)", () => {
    const bytes = buildBinaryStl([
      [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      [[0, 0, 0], [0, 0, 1], [1, 0, 0]],
    ]);
    const positions = parseStl(bytes);
    expect(positions.length).toBe(2 * 9);
    expect(Array.from(positions.slice(0, 9))).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(positions.slice(9, 18))).toEqual([0, 0, 0, 0, 0, 1, 1, 0, 0]);
  });

  it("returns an empty array for unparseable content, never throws", () => {
    expect(parseStl(new TextEncoder().encode("not an stl file at all")).length).toBe(0);
    expect(parseStl(new Uint8Array(0)).length).toBe(0);
  });
});
