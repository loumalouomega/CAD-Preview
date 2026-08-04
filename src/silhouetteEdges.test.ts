import { describe, it, expect } from "vitest";
import { silhouetteEdges } from "./silhouetteEdges";
import { weldTriangleSoup } from "./meshComponents";

/** A closed unit cube spanning 0..1, as a welded indexed mesh. */
function unitCube() {
  const v = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const faces = [
    [0, 3, 2], [0, 2, 1], // z = 0
    [4, 5, 6], [4, 6, 7], // z = 1
    [0, 1, 5], [0, 5, 4], // y = 0
    [1, 2, 6], [1, 6, 5], // x = 1
    [2, 3, 7], [2, 7, 6], // y = 1
    [3, 0, 4], [3, 4, 7], // x = 0
  ];
  const soup: number[] = [];
  for (const f of faces) for (const i of f) soup.push(...v[i]);
  return weldTriangleSoup(new Float32Array(soup));
}

describe("silhouetteEdges", () => {
  it("a cube viewed straight down an axis has a 4-edge square outline", () => {
    const { positions, indices } = unitCube();
    const edges = silhouetteEdges(positions, indices, [0, 0, 1]);
    expect(edges).toHaveLength(4);
  });

  it("gives the same 4-edge outline from the opposite direction", () => {
    const { positions, indices } = unitCube();
    expect(silhouetteEdges(positions, indices, [0, 0, -1])).toHaveLength(4);
  });

  it("a cube viewed down a body diagonal has a 6-edge hexagonal outline", () => {
    const { positions, indices } = unitCube();
    expect(silhouetteEdges(positions, indices, [1, 1, 1])).toHaveLength(6);
  });

  it("keeps every open-boundary edge of a lone triangle", () => {
    const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const { positions, indices } = weldTriangleSoup(soup);
    // All three edges are referenced by exactly one triangle.
    expect(silhouetteEdges(positions, indices, [0, 0, 1])).toHaveLength(3);
  });

  it("always keeps a non-manifold edge (3+ adjacent triangles)", () => {
    // Three triangles fanning out from one shared edge — the same non-manifold
    // fixture shape `meshTopology.test.ts` uses.
    const soup = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0, 1, 0, 0, 0, 0, 1,
      0, 0, 0, 1, 0, 0, 0, -1, 1,
    ]);
    const { positions, indices } = weldTriangleSoup(soup);
    const edges = silhouetteEdges(positions, indices, [0, 0, 1]);
    // The shared (0,0,0)-(1,0,0) edge is referenced 3×, so it is always kept.
    const shared = edges.filter(([a, b]) => {
      const pa = [positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]];
      const pb = [positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]];
      const isOrigin = (p: number[]) => p[0] === 0 && p[1] === 0 && p[2] === 0;
      const isX = (p: number[]) => p[0] === 1 && p[1] === 0 && p[2] === 0;
      return (isOrigin(pa) && isX(pb)) || (isOrigin(pb) && isX(pa));
    });
    expect(shared).toHaveLength(1);
  });

  it("treats an exactly edge-on triangle deterministically (as back-facing)", () => {
    // A single triangle in the XZ plane, viewed along +Z: its normal is
    // perpendicular to the view, so dot === 0. It must not crash or vary; all
    // three edges are boundary edges and are kept regardless.
    const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const { positions, indices } = weldTriangleSoup(soup);
    expect(silhouetteEdges(positions, indices, [0, 1, 0])).toHaveLength(3);
  });

  it("returns nothing for an empty mesh", () => {
    expect(silhouetteEdges(new Float32Array(0), new Uint32Array(0), [0, 0, 1])).toEqual([]);
  });

  it("skips degenerate zero-length triangle edges", () => {
    // A triangle with two coincident corners welds to only 2 distinct vertices.
    const soup = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0]);
    const { positions, indices } = weldTriangleSoup(soup);
    const edges = silhouetteEdges(positions, indices, [0, 0, 1]);
    for (const [a, b] of edges) expect(a).not.toBe(b);
  });
});
