import { describe, it, expect } from "vitest";
import {
  weldTriangleSoup,
  connectedComponents,
  boundsOfTriangles,
  boundsCenter,
  boundsDiagonal,
  volumeOfTriangles,
  areaOfTriangles,
  weldedMeshToStlBytes,
} from "./meshComponents";
import { parseStl } from "./stlParser";

/** Builds a flat, ungrouped triangle-soup Float32Array (matching
 * `stlParser.ts`'s output shape) for an axis-aligned box from `min` to
 * `max`. Each face's 2 triangles are wound so the normal points outward —
 * verified programmatically (via a cross-product/centroid check) rather than
 * hand-derived, so the fixture itself can't silently have a sign bug. */
function boxSoup(min: [number, number, number], max: [number, number, number]): Float32Array {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const center: [number, number, number] = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const corners: Record<string, [number, number, number]> = {
    "000": [x0, y0, z0], "100": [x1, y0, z0], "110": [x1, y1, z0], "010": [x0, y1, z0],
    "001": [x0, y0, z1], "101": [x1, y0, z1], "111": [x1, y1, z1], "011": [x0, y1, z1],
  };
  const faces: Array<[string, string, string, string]> = [
    ["000", "100", "110", "010"], // z0
    ["001", "101", "111", "011"], // z1
    ["000", "100", "101", "001"], // y0
    ["010", "110", "111", "011"], // y1
    ["000", "010", "011", "001"], // x0
    ["100", "110", "111", "101"], // x1
  ];
  const out: number[] = [];
  const cross = (a: number[], b: number[]): [number, number, number] => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const pushTri = (a: number[], b: number[], c: number[]) => {
    const normal = cross(sub(b, a), sub(c, a));
    const faceCenter = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const outward = dot(normal, sub(faceCenter, center));
    const [p0, p1, p2] = outward >= 0 ? [a, b, c] : [a, c, b];
    out.push(...p0, ...p1, ...p2);
  };
  for (const [k0, k1, k2, k3] of faces) {
    const [a, b, c, d] = [corners[k0], corners[k1], corners[k2], corners[k3]];
    pushTri(a, b, c);
    pushTri(a, c, d);
  }
  return new Float32Array(out);
}

describe("weldTriangleSoup", () => {
  it("dedups shared vertices between adjacent triangles", () => {
    // Two triangles sharing edge (1,0,0)-(0,1,0): 6 raw vertex instances, 4 unique.
    const soup = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, // triangle A
      1, 0, 0, 1, 1, 0, 0, 1, 0, // triangle B (shares 2 verts with A)
    ]);
    const { positions, indices } = weldTriangleSoup(soup);
    expect(positions.length / 3).toBe(4);
    expect(indices.length).toBe(6);
    // The shared vertices (1,0,0) and (0,1,0) must map to the same index in both triangles.
    expect(indices[1]).toBe(indices[3]); // (1,0,0)
    expect(indices[2]).toBe(indices[5]); // (0,1,0)
  });

  it("keeps genuinely distinct vertices distinct at the default epsilon", () => {
    const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const { positions } = weldTriangleSoup(soup);
    expect(positions.length / 3).toBe(3);
  });
});

describe("connectedComponents", () => {
  it("two triangles sharing an edge form one component", () => {
    const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const { indices } = weldTriangleSoup(soup);
    const components = connectedComponents(indices);
    expect(components).toHaveLength(1);
    expect(components[0]).toHaveLength(2);
  });

  it("two disjoint triangles (no shared vertices) form two components", () => {
    const soup = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, // triangle A
      100, 100, 100, 101, 100, 100, 100, 101, 100, // triangle B, far away
    ]);
    const { indices } = weldTriangleSoup(soup);
    const components = connectedComponents(indices);
    expect(components).toHaveLength(2);
  });

  it("two boxes side by side (touching at no vertex) segment into two components", () => {
    const boxA = boxSoup([0, 0, 0], [1, 1, 1]);
    const boxB = boxSoup([5, 0, 0], [6, 1, 1]);
    const soup = new Float32Array([...boxA, ...boxB]);
    const { indices } = weldTriangleSoup(soup);
    const components = connectedComponents(indices);
    expect(components).toHaveLength(2);
    expect(components[0]).toHaveLength(12); // each box is 12 triangles
    expect(components[1]).toHaveLength(12);
  });
});

describe("bounds helpers", () => {
  it("computes the bounding box, center, and diagonal of a unit box", () => {
    const soup = boxSoup([0, 0, 0], [1, 1, 1]);
    const { positions, indices } = weldTriangleSoup(soup);
    const all = Array.from({ length: indices.length / 3 }, (_, i) => i);
    const bounds = boundsOfTriangles(positions, indices, all)!;
    expect(bounds.min).toEqual([0, 0, 0]);
    expect(bounds.max).toEqual([1, 1, 1]);
    expect(boundsCenter(bounds)).toEqual([0.5, 0.5, 0.5]);
    expect(boundsDiagonal(bounds)).toBeCloseTo(Math.sqrt(3), 6);
  });

  it("returns undefined for an empty triangle list", () => {
    expect(boundsOfTriangles(new Float32Array(), new Uint32Array(), [])).toBeUndefined();
  });
});

describe("volumeOfTriangles", () => {
  it("computes a unit box's volume as exactly 1", () => {
    const soup = boxSoup([0, 0, 0], [1, 1, 1]);
    const { positions, indices } = weldTriangleSoup(soup);
    const all = Array.from({ length: indices.length / 3 }, (_, i) => i);
    expect(volumeOfTriangles(positions, indices, all)).toBeCloseTo(1, 5);
  });

  it("computes a 2x3x4 box's volume as 24, matching CLAUDE.md's B-rep verification fixture", () => {
    const soup = boxSoup([0, 0, 0], [2, 3, 4]);
    const { positions, indices } = weldTriangleSoup(soup);
    const all = Array.from({ length: indices.length / 3 }, (_, i) => i);
    expect(volumeOfTriangles(positions, indices, all)).toBeCloseTo(24, 4);
  });

  it("is unaffected by translation (uses per-triangle geometry, not distance from the origin)", () => {
    const soup = boxSoup([100, 200, 300], [101, 201, 301]);
    const { positions, indices } = weldTriangleSoup(soup);
    const all = Array.from({ length: indices.length / 3 }, (_, i) => i);
    expect(volumeOfTriangles(positions, indices, all)).toBeCloseTo(1, 4);
  });
});

describe("areaOfTriangles", () => {
  it("computes a unit box's surface area as exactly 6", () => {
    const soup = boxSoup([0, 0, 0], [1, 1, 1]);
    const { positions, indices } = weldTriangleSoup(soup);
    const all = Array.from({ length: indices.length / 3 }, (_, i) => i);
    expect(areaOfTriangles(positions, indices, all)).toBeCloseTo(6, 5);
  });

  it("computes a 2x3x4 box's surface area as 2*(2*3+2*4+3*4) = 52, matching CLAUDE.md's B-rep verification fixture", () => {
    const soup = boxSoup([0, 0, 0], [2, 3, 4]);
    const { positions, indices } = weldTriangleSoup(soup);
    const all = Array.from({ length: indices.length / 3 }, (_, i) => i);
    expect(areaOfTriangles(positions, indices, all)).toBeCloseTo(52, 4);
  });

  it("is unaffected by translation", () => {
    const soup = boxSoup([100, 200, 300], [101, 201, 301]);
    const { positions, indices } = weldTriangleSoup(soup);
    const all = Array.from({ length: indices.length / 3 }, (_, i) => i);
    expect(areaOfTriangles(positions, indices, all)).toBeCloseTo(6, 4);
  });

  it("returns 0 for an empty triangle list", () => {
    expect(areaOfTriangles(new Float32Array(), new Uint32Array(), [])).toBe(0);
  });
});

describe("weldedMeshToStlBytes", () => {
  it("round-trips a welded box through ASCII STL with the same triangle count and volume", () => {
    const soup = boxSoup([0, 0, 0], [2, 3, 4]);
    const welded = weldTriangleSoup(soup);
    const stlBytes = weldedMeshToStlBytes(welded);
    const text = Buffer.from(stlBytes).toString("utf8");
    expect(text.startsWith("solid ")).toBe(true);
    expect(text.trim().endsWith("endsolid mesh")).toBe(true);

    const reparsed = parseStl(stlBytes);
    const triangleCount = reparsed.length / 9;
    expect(triangleCount).toBe(soup.length / 9);

    const reWelded = weldTriangleSoup(reparsed);
    const all = Array.from({ length: reWelded.indices.length / 3 }, (_, i) => i);
    expect(volumeOfTriangles(reWelded.positions, reWelded.indices, all)).toBeCloseTo(2 * 3 * 4, 4);
    expect(areaOfTriangles(reWelded.positions, reWelded.indices, all)).toBeCloseTo(52, 4);
  });

  it("emits a valid, empty STL for a mesh with no triangles", () => {
    const stlBytes = weldedMeshToStlBytes({ positions: new Float32Array(), indices: new Uint32Array() });
    const text = Buffer.from(stlBytes).toString("utf8");
    expect(text).toBe("solid mesh\nendsolid mesh");
    expect(parseStl(stlBytes).length).toBe(0);
  });
});
