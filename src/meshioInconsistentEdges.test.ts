import { describe, expect, it } from "vitest";
import { inconsistentEdgesFromFeatureEdges } from "./meshioService";

// Welded mesh with 5 vertices; the component uses vertices 4,2,0 as local 0,1,2.
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 4, 4]);
const original = [4, 2, 0];

describe("inconsistentEdgesFromFeatureEdges", () => {
  it("keeps only kind 4, maps local indices back, and reports midpoints", () => {
    // meshio++ >= 11.2 delivers integer cell data as BigInt64Array.
    const kinds = BigInt64Array.from([1n, 4n, 2n, 4n]);
    const lines = { data: Int32Array.from([0, 1, 1, 2, 0, 2, 2, 0]) };
    const r = inconsistentEdgesFromFeatureEdges(lines, kinds, original, positions);
    expect(r.total).toBe(2);
    expect(r.edges).toEqual([[2, 0], [0, 4]]);
    expect(r.points[0]).toEqual([1, 0, 0]);
    expect(r.points[1]).toEqual([2, 2, 2]);
  });

  it("accepts plain-number kinds too", () => {
    const r = inconsistentEdgesFromFeatureEdges({ data: [0, 1] }, [4], original, positions);
    expect(r.edges).toEqual([[4, 2]]);
  });

  it("caps the list but keeps the true total", () => {
    const lines = { data: Int32Array.from([0, 1, 1, 2, 0, 2]) };
    const r = inconsistentEdgesFromFeatureEdges(lines, [4, 4, 4], original, positions, 2);
    expect(r.edges).toHaveLength(2);
    expect(r.points).toHaveLength(2);
    expect(r.total).toBe(3);
  });

  it("returns nothing for an absent line block or no matching kinds", () => {
    expect(inconsistentEdgesFromFeatureEdges(undefined, undefined, original, positions).total).toBe(0);
    expect(inconsistentEdgesFromFeatureEdges({ data: [0, 1] }, [2], original, positions).edges).toEqual([]);
  });
});
