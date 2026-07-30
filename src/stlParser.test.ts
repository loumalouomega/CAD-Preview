import { describe, it, expect } from "vitest";
import { parseStl, scaleStlBytes } from "./stlParser";

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

describe("scaleStlBytes", () => {
  it("scales every vertex coordinate by the given factor and re-parses back correctly", () => {
    const bytes = new TextEncoder().encode(ASCII_TETRAHEDRON);
    const scaled = scaleStlBytes(bytes, 25.4);
    const original = parseStl(bytes);
    const positions = parseStl(scaled);
    expect(positions.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(positions[i]).toBeCloseTo(original[i] * 25.4, 5);
    }
  });

  it("recomputes facet normals from the (post-scale) winding order, never trusting the input file's", () => {
    // First facet: vertices (0,0,0),(1,0,0),(0,1,0) — file says "normal 0 0 -1",
    // but (v1-v0) x (v2-v0) = (1,0,0) x (0,1,0) = (0,0,1), so the recomputed
    // normal must be the OPPOSITE sign of the file's stale/untrusted one.
    const bytes = new TextEncoder().encode(ASCII_TETRAHEDRON);
    const text = Buffer.from(scaleStlBytes(bytes, 2)).toString("utf8");
    const match = /facet normal ([-\d.]+) ([-\d.]+) ([-\d.]+)/.exec(text);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeCloseTo(0, 5);
    expect(Number(match![2])).toBeCloseTo(0, 5);
    expect(Number(match![3])).toBeCloseTo(1, 5);
  });

  it("round-trips a factor of 1 as a pure identity scale", () => {
    const bytes = new TextEncoder().encode(ASCII_TETRAHEDRON);
    const original = parseStl(bytes);
    const positions = parseStl(scaleStlBytes(bytes, 1));
    expect(Array.from(positions)).toEqual(Array.from(original));
  });

  it("handles an empty triangle soup gracefully", () => {
    const positions = parseStl(scaleStlBytes(new Uint8Array(0), 2));
    expect(positions.length).toBe(0);
  });
});
