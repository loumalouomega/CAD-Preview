import { describe, it, expect } from "vitest";
import { extractFaceGeometry, polylineFromDiscretizer } from "./meshExtract";

/** Minimal mock of a Poly_Triangulation face with 3 nodes forming one triangle. */
function makeTriMock(
  nodes: [number, number, number][],
  triangles: [number, number, number][]
) {
  return {
    NbNodes: () => nodes.length,
    NbTriangles: () => triangles.length,
    Node: (i: number) => {
      const [x, y, z] = nodes[i - 1]; // 1-based
      return { X: () => x, Y: () => y, Z: () => z, delete: () => {} };
    },
    Triangle: (i: number) => {
      const [a, b, c] = triangles[i - 1]; // 1-based
      return { Value: (j: number) => [a, b, c][j - 1], delete: () => {} };
    },
  };
}

describe("extractFaceGeometry", () => {
  it("packs positions for a single triangle (identity transform, not reversed)", () => {
    const tri = makeTriMock(
      [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      [[1, 2, 3]]
    );
    const { positions, indices } = extractFaceGeometry(tri, null, false);

    expect(positions.length).toBe(9); // 3 vertices × 3 coords
    expect(Array.from(positions.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(positions.slice(3, 6))).toEqual([1, 0, 0]);
    expect(Array.from(positions.slice(6, 9))).toEqual([0, 1, 0]);
    expect(Array.from(indices)).toEqual([0, 1, 2]); // remapped to 0-based
  });

  it("reverses winding order for REVERSED faces", () => {
    const tri = makeTriMock(
      [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      [[1, 2, 3]]
    );
    const { indices } = extractFaceGeometry(tri, null, true);
    // reversed: swap second and third index
    expect(Array.from(indices)).toEqual([0, 2, 1]);
  });

  it("applies a transform to node positions", () => {
    const tri = makeTriMock([[1, 0, 0]], [[1, 1, 1]]);
    // transform: translate all points by (10, 20, 30)
    const trsf = {
      TransformCoord: (x: number, y: number, z: number) =>
        [x + 10, y + 20, z + 30] as [number, number, number],
    };
    const { positions } = extractFaceGeometry(tri, trsf as never, false);
    expect(Array.from(positions)).toEqual([11, 20, 30]);
  });

  it("handles multiple triangles and remaps indices per face", () => {
    const tri = makeTriMock(
      [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]],
      [[1, 2, 3], [2, 4, 3]]
    );
    const { positions, indices } = extractFaceGeometry(tri, null, false);
    expect(positions.length).toBe(12); // 4 nodes × 3
    expect(indices.length).toBe(6);    // 2 triangles × 3
    expect(indices[0]).toBe(0);
    expect(indices[3]).toBe(1); // second triangle first index remapped (node 2 → 1)
  });
});

describe("polylineFromDiscretizer", () => {
  /** Mock of a GCPnts discretizer with 1-based Value(i). */
  function makeDiscMock(points: [number, number, number][]) {
    let deleted = 0;
    const mock = {
      NbPoints: () => points.length,
      Value: (i: number) => {
        const [x, y, z] = points[i - 1];
        return { X: () => x, Y: () => y, Z: () => z, delete: () => { deleted++; } };
      },
      deletedCount: () => deleted,
    };
    return mock;
  }

  it("packs discretized points into a flat xyz array in curve order", () => {
    const disc = makeDiscMock([[0, 0, 0], [1, 2, 3], [4, 5, 6]]);
    const positions = polylineFromDiscretizer(disc);
    expect(positions.length).toBe(9);
    expect(Array.from(positions)).toEqual([0, 0, 0, 1, 2, 3, 4, 5, 6]);
  });

  it("releases every gp_Pnt handle it reads (OCCT memory discipline)", () => {
    const disc = makeDiscMock([[0, 0, 0], [1, 1, 1]]);
    polylineFromDiscretizer(disc);
    expect(disc.deletedCount()).toBe(2);
  });
});
