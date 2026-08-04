import { describe, it, expect } from "vitest";
import { analyzeMeshTopology } from "./meshTopology";
import { weldTriangleSoup } from "./meshComponents";

/** A regular tetrahedron, 4 triangles, wound outward — every edge shared by
 * exactly 2 triangles (closed, manifold, 0 free edges). */
function tetrahedronSoup(): Float32Array {
  const p0: [number, number, number] = [0, 0, 0];
  const p1: [number, number, number] = [1, 0, 0];
  const p2: [number, number, number] = [0, 1, 0];
  const p3: [number, number, number] = [0, 0, 1];
  // Outward-wound faces (verified by inspection: centroid is at (0.25,0.25,0.25),
  // each face's normal via right-hand winding points away from it).
  return new Float32Array([
    ...p0, ...p2, ...p1, // base (z=0), wound so normal points -z (away from centroid)
    ...p0, ...p1, ...p3,
    ...p1, ...p2, ...p3,
    ...p2, ...p0, ...p3,
  ]);
}

describe("analyzeMeshTopology", () => {
  it("a closed tetrahedron has 0 free edges, 6 manifold edges, 0 non-manifold, 0 degenerate", () => {
    const { positions, indices } = weldTriangleSoup(tetrahedronSoup());
    const all = Array.from({ length: indices.length / 3 }, (_, i) => i);
    const stats = analyzeMeshTopology(positions, indices, all);
    expect(stats.freeEdgeCount).toBe(0);
    expect(stats.manifoldEdgeCount).toBe(6); // a tetrahedron has exactly 6 edges
    expect(stats.nonManifoldEdgeCount).toBe(0);
    expect(stats.degenerateFaceCount).toBe(0);
  });

  it("removing one face from the tetrahedron leaves exactly 3 free edges (the hole's boundary)", () => {
    const soup = tetrahedronSoup();
    const withoutOneFace = soup.slice(0, soup.length - 9); // drop the last triangle (9 floats)
    const { positions, indices } = weldTriangleSoup(withoutOneFace);
    const all = Array.from({ length: indices.length / 3 }, (_, i) => i);
    const stats = analyzeMeshTopology(positions, indices, all);
    expect(stats.freeEdgeCount).toBe(3);
    expect(stats.manifoldEdgeCount).toBe(3);
    expect(stats.nonManifoldEdgeCount).toBe(0);
  });

  it("counts a collinear (zero-area) triangle as degenerate", () => {
    const soup = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, // a genuine triangle
      0, 0, 0, 1, 0, 0, 2, 0, 0, // collinear along x — zero area
    ]);
    const { positions, indices } = weldTriangleSoup(soup);
    const all = Array.from({ length: indices.length / 3 }, (_, i) => i);
    const stats = analyzeMeshTopology(positions, indices, all);
    expect(stats.degenerateFaceCount).toBe(1);
  });

  it("counts a duplicated (repeated-vertex) triangle as degenerate", () => {
    const soup = new Float32Array([0, 0, 0, 0, 0, 0, 1, 0, 0]); // two identical points + one more
    const { positions, indices } = weldTriangleSoup(soup);
    const all = Array.from({ length: indices.length / 3 }, (_, i) => i);
    const stats = analyzeMeshTopology(positions, indices, all);
    expect(stats.degenerateFaceCount).toBe(1);
  });

  it("an edge shared by 3 triangles is reported as non-manifold", () => {
    // Three triangles all sharing the edge (0,0,0)-(1,0,0), fanning out to
    // three different third points — a genuine non-manifold edge.
    const soup = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0, 1, 0, 0, 0, -1, 0,
      0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    const { positions, indices } = weldTriangleSoup(soup);
    const all = Array.from({ length: indices.length / 3 }, (_, i) => i);
    const stats = analyzeMeshTopology(positions, indices, all);
    expect(stats.nonManifoldEdgeCount).toBe(1);
  });

  it("returns all zeros for an empty triangle list", () => {
    const stats = analyzeMeshTopology(new Float32Array(), new Uint32Array(), []);
    expect(stats).toEqual({ freeEdgeCount: 0, manifoldEdgeCount: 0, nonManifoldEdgeCount: 0, degenerateFaceCount: 0 });
  });
});
