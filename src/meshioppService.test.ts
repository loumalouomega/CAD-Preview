import { describe, expect, it } from "vitest";
import { skinTopology } from "./meshioppService";

// A unit tetrahedron, consistently wound outward, with every triangle's
// vertices duplicated (exact coordinates) — the way an STL repeats them.
function tetra(faces: number[][]): { points: number[]; blocks: Array<{ type: string; data: number[] }> } {
  const P = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const points: number[] = [];
  const data: number[] = [];
  for (const face of faces) {
    for (const id of face) {
      data.push(points.length / 3);
      points.push(...P[id]);
    }
  }
  return { points, blocks: [{ type: "triangle", data }] };
}

const CLOSED = [
  [0, 2, 1],
  [0, 1, 3],
  [0, 3, 2],
  [1, 2, 3],
];

describe("skinTopology", () => {
  it("sees a closed, consistently wound skin through duplicated vertices", () => {
    const t = tetra(CLOSED);
    expect(skinTopology(t.points, t.blocks)).toEqual({
      numTriangles: 4,
      numOpenEdges: 0,
      numNonManifoldEdges: 0,
      numMisorientedEdges: 0,
    });
  });

  it("counts a missing triangle's three edges as open", () => {
    const t = tetra(CLOSED.slice(0, 3));
    expect(skinTopology(t.points, t.blocks)).toMatchObject({ numTriangles: 3, numOpenEdges: 3 });
  });

  it("counts a reversed triangle's three edges as misoriented", () => {
    const t = tetra([...CLOSED.slice(0, 3), [1, 3, 2]]);
    expect(skinTopology(t.points, t.blocks)).toMatchObject({ numMisorientedEdges: 3 });
  });

  it("counts an edge shared by three triangles as non-manifold", () => {
    const t = tetra(CLOSED);
    // A fin on the welded edge 0-1, already shared by two tetra faces.
    t.points.push(5, 5, 0);
    t.blocks[0].data.push(12, 0, 1);
    const topo = skinTopology(t.points, t.blocks);
    expect(topo.numTriangles).toBe(5);
    expect(topo.numNonManifoldEdges).toBe(1);
  });
});
