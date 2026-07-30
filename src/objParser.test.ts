import { describe, it, expect } from "vitest";
import { parseObj } from "./objParser";
import { connectedComponents, volumeOfTriangles, boundsOfTriangles, boundsCenter } from "./meshComponents";

// A unit cube (0,0,0)-(1,1,1), quad faces wound outward — cross-checked the
// same way meshComponents.test.ts's boxSoup fixture is (each face listed
// counterclockwise as seen from outside).
const UNIT_CUBE_OBJ = `
# comment line, ignored
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 1
v 1 0 1
v 1 1 1
v 0 1 1
f 1 4 3 2
f 5 6 7 8
f 1 2 6 5
f 2 3 7 6
f 3 4 8 7
f 4 1 5 8
`;

describe("parseObj", () => {
  it("parses vertex positions in file order", () => {
    const { positions } = parseObj(new TextEncoder().encode(UNIT_CUBE_OBJ));
    expect(positions.length / 3).toBe(8);
    expect(Array.from(positions.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(positions.slice(21, 24))).toEqual([0, 1, 1]);
  });

  it("fan-triangulates each quad face into 2 triangles, sharing the existing vertex indices", () => {
    const { indices } = parseObj(new TextEncoder().encode(UNIT_CUBE_OBJ));
    expect(indices.length).toBe(6 * 2 * 3); // 6 quad faces * 2 triangles * 3 indices
  });

  it("resolves a real closed unit cube: 1 connected component, volume 1", () => {
    const { positions, indices } = parseObj(new TextEncoder().encode(UNIT_CUBE_OBJ));
    const components = connectedComponents(indices);
    expect(components).toHaveLength(1);
    expect(volumeOfTriangles(positions, indices, components[0])).toBeCloseTo(1, 5);
    const bounds = boundsOfTriangles(positions, indices, components[0])!;
    expect(boundsCenter(bounds)).toEqual([0.5, 0.5, 0.5]);
  });

  it("resolves vertex/texture/normal composite references (v/vt/vn, v//vn)", () => {
    const text = `
v 0 0 0
v 1 0 0
v 0 1 0
vt 0 0
vn 0 0 1
f 1/1/1 2/1/1 3/1/1
f 1//1 2//1 3//1
`;
    const { indices } = parseObj(new TextEncoder().encode(text));
    expect(indices.length).toBe(6); // 2 faces * 3 indices
    expect(Array.from(indices.slice(0, 3))).toEqual([0, 1, 2]);
  });

  it("resolves negative (relative) vertex indices", () => {
    const text = `
v 0 0 0
v 1 0 0
v 0 1 0
f -3 -2 -1
`;
    const { indices } = parseObj(new TextEncoder().encode(text));
    expect(Array.from(indices)).toEqual([0, 1, 2]);
  });

  it("skips a face referencing an out-of-range vertex rather than throwing", () => {
    const text = `
v 0 0 0
v 1 0 0
v 0 1 0
f 1 2 99
`;
    const { indices } = parseObj(new TextEncoder().encode(text));
    expect(indices.length).toBe(0);
  });

  it("returns an empty mesh for content with no v/f lines, never throws", () => {
    const { positions, indices } = parseObj(new TextEncoder().encode("mtllib foo.mtl\nusemtl bar\n"));
    expect(positions.length).toBe(0);
    expect(indices.length).toBe(0);
  });

  it("ignores a face with fewer than 3 references", () => {
    const text = "v 0 0 0\nv 1 0 0\nf 1 2\n";
    const { indices } = parseObj(new TextEncoder().encode(text));
    expect(indices.length).toBe(0);
  });
});
