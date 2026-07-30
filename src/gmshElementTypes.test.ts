import { describe, it, expect } from "vitest";
import {
  GMSH_ELEMENT_TYPES,
  MDPA_KIND_INFO,
  VOLUME_KIND_ORDER,
  SURFACE_KIND_ORDER,
  surfaceTriangles,
  boundaryTriangles,
  boundaryFaceRings,
  triangulateRing,
  faceRingKey,
  surfaceElementRings,
  surfaceEdges,
  boundaryEdges,
  type MdpaCellKind,
} from "./gmshElementTypes";

/** Undirected edge set (sorted "a_b" keys) from a flat line-index buffer. */
const edgeSet = (buf: number[]): Set<string> => {
  const s = new Set<string>();
  for (let i = 0; i < buf.length; i += 2) {
    const [a, b] = buf[i] < buf[i + 1] ? [buf[i], buf[i + 1]] : [buf[i + 1], buf[i]];
    s.add(`${a}_${b}`);
  }
  return s;
};

describe("GMSH_ELEMENT_TYPES table invariants", () => {
  it("each face ring references only corner indices, in bounds", () => {
    for (const info of GMSH_ELEMENT_TYPES.values()) {
      for (const face of info.faces) {
        expect(face.length === 3 || face.length === 4).toBe(true);
        for (const c of face) expect(c).toBeLessThan(info.numCorners);
      }
    }
  });

  it("each permutation is a bijection over its own length and in bounds of numNodes", () => {
    for (const info of GMSH_ELEMENT_TYPES.values()) {
      const perm = info.mdpa.permutation;
      const seen = new Set(perm);
      expect(seen.size).toBe(perm.length); // no duplicates
      for (const p of perm) expect(p).toBeLessThan(info.numNodes);
    }
  });

  it("permutation length equals the target Kratos kind's node count", () => {
    for (const info of GMSH_ELEMENT_TYPES.values()) {
      expect(info.mdpa.permutation.length).toBe(MDPA_KIND_INFO[info.mdpa.kind].numNodes);
    }
  });

  it("every MdpaCellKind is reachable from at least one gmsh type", () => {
    const reachable = new Set<MdpaCellKind>();
    for (const info of GMSH_ELEMENT_TYPES.values()) reachable.add(info.mdpa.kind);
    for (const kind of Object.keys(MDPA_KIND_INFO) as MdpaCellKind[]) {
      expect(reachable.has(kind)).toBe(true);
    }
  });

  it("kind orders cover every kind exactly once, volume vs surface split matches info", () => {
    const all = [...VOLUME_KIND_ORDER, ...SURFACE_KIND_ORDER];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(Object.keys(MDPA_KIND_INFO)));
    for (const k of VOLUME_KIND_ORDER) expect(MDPA_KIND_INFO[k].elementName).not.toBeNull();
    for (const k of SURFACE_KIND_ORDER) expect(MDPA_KIND_INFO[k].conditionName).not.toBeNull();
  });

  it("tet10 permutation swaps the last two mid-edge nodes", () => {
    expect(GMSH_ELEMENT_TYPES.get(11)!.mdpa.permutation).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9, 8]);
  });
});

/** Simple tagToIndex where every tag maps to itself. */
const identityMap = (maxTag: number): Map<number, number> => {
  const m = new Map<number, number>();
  for (let i = 0; i <= maxTag; i++) m.set(i, i);
  return m;
};

describe("surfaceTriangles", () => {
  it("passes tri3 through unchanged", () => {
    const out = surfaceTriangles({ elementTypes: [2], nodeTags: [[10, 11, 12]] }, new Map([[10, 0], [11, 1], [12, 2]]));
    expect(out).toEqual([0, 1, 2]);
  });

  it("splits quad4 into two triangles (fan from corner 0)", () => {
    const out = surfaceTriangles({ elementTypes: [3], nodeTags: [[0, 1, 2, 3]] }, identityMap(3));
    expect(out).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it("uses only corner nodes for tri6 / quad9 (mid-side ignored)", () => {
    const tri6 = surfaceTriangles({ elementTypes: [9], nodeTags: [[0, 1, 2, 3, 4, 5]] }, identityMap(5));
    expect(tri6).toEqual([0, 1, 2]);
    const quad9 = surfaceTriangles({ elementTypes: [10], nodeTags: [[0, 1, 2, 3, 4, 5, 6, 7, 8]] }, identityMap(8));
    expect(quad9).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it("skips unknown and 3D types", () => {
    const out = surfaceTriangles({ elementTypes: [4, 999], nodeTags: [[0, 1, 2, 3], [0, 1, 2]] }, identityMap(3));
    expect(out).toEqual([]);
  });
});

describe("boundaryTriangles", () => {
  it("two tets sharing a face -> 6 boundary triangles, shared face dropped", () => {
    // tetA corners 0,1,2,3 ; tetB corners 1,2,3,4 ; shared face = {1,2,3}
    const out = boundaryTriangles({ elementTypes: [4], nodeTags: [[0, 1, 2, 3, 1, 2, 3, 4]] }, identityMap(4));
    // 2 tets * 4 faces = 8 faces, shared {1,2,3} appears twice -> 6 boundary tris * 3 = 18 indices
    expect(out.length).toBe(18);
    // the shared corner-set {1,2,3} must not appear as an output triangle
    for (let i = 0; i < out.length; i += 3) {
      const set = [out[i], out[i + 1], out[i + 2]].sort().join(",");
      expect(set).not.toBe("1,2,3");
    }
  });

  it("a single hex -> 6 quad faces -> 12 triangles", () => {
    const out = boundaryTriangles({ elementTypes: [5], nodeTags: [[0, 1, 2, 3, 4, 5, 6, 7]] }, identityMap(7));
    expect(out.length).toBe(12 * 3);
  });

  it("watertight: every corner-edge on the boundary appears in exactly two triangles", () => {
    const out = boundaryTriangles({ elementTypes: [5], nodeTags: [[0, 1, 2, 3, 4, 5, 6, 7]] }, identityMap(7));
    const edgeCount = new Map<string, number>();
    for (let i = 0; i < out.length; i += 3) {
      const t = [out[i], out[i + 1], out[i + 2]];
      for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
        const key = [a, b].sort((x, y) => x - y).join("_");
        edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      }
    }
    // The 2 triangulation-diagonal edges per face are internal to that face
    // (count 2), and every real cube edge is shared by two faces (count 2).
    for (const c of edgeCount.values()) expect(c).toBe(2);
  });

  it("hex and pyramid sharing a quad face dedup that face", () => {
    // hex top face corners 4,5,6,7 ; pyramid base corners 4,5,6,7
    const out = boundaryTriangles(
      { elementTypes: [5, 7], nodeTags: [[0, 1, 2, 3, 4, 5, 6, 7], [4, 5, 6, 7, 8]] },
      identityMap(8)
    );
    // hex 6 faces + pyr (1 quad base + 4 tris); shared {4,5,6,7} cancels ->
    // hex: 5 remaining quads (10 tris) + pyr: 4 tris = 14 tris
    expect(out.length).toBe(14 * 3);
  });

  it("two tet10s dedup identically to tet4s (mid nodes excluded from keys)", () => {
    // corners as above (0,1,2,3 / 1,2,3,4), mid-node tags are distinct fillers.
    const a = [0, 1, 2, 3, 10, 11, 12, 13, 14, 15];
    const b = [1, 2, 3, 4, 20, 21, 22, 23, 24, 25];
    const out = boundaryTriangles({ elementTypes: [11], nodeTags: [[...a, ...b]] }, identityMap(25));
    expect(out.length).toBe(18);
  });

  it("skips unknown and 2D types", () => {
    const out = boundaryTriangles({ elementTypes: [2, 999], nodeTags: [[0, 1, 2], [0, 1, 2]] }, identityMap(2));
    expect(out).toEqual([]);
  });
});

describe("faceRingKey / triangulateRing", () => {
  it("is order-independent (same face, different winding, same key)", () => {
    expect(faceRingKey([3, 1, 2])).toBe(faceRingKey([1, 2, 3]));
    expect(faceRingKey([1, 2, 3])).toBe(faceRingKey([2, 3, 1]));
  });

  it("a triangle and a quad sharing 3 corners never collide", () => {
    expect(faceRingKey([1, 2, 3])).not.toBe(faceRingKey([1, 2, 3, 4]));
  });

  it("triangulates a triangle ring to itself, a quad ring by fan-from-0", () => {
    expect(triangulateRing([10, 11, 12], identityMap(12))).toEqual([[10, 11, 12]]);
    expect(triangulateRing([0, 1, 2, 3], identityMap(3))).toEqual([
      [0, 1, 2],
      [0, 2, 3],
    ]);
  });
});

describe("boundaryFaceRings / surfaceElementRings correlation", () => {
  it("a hex's kept boundary-face rings key-match the corresponding surface mesh's element rings", () => {
    // A single hex (tags 0-7) is the 3D mesh; its top quad face (4,5,6,7) is
    // separately meshed as a 2D surface element (as Gmsh would, generating
    // the volume mesh from its own boundary surface mesh) with a different
    // corner order/winding — the correlation `gmshService.ts`'s
    // `buildIndices3D` relies on must still match them by faceRingKey.
    const hexEls = { elementTypes: [5], nodeTags: [[0, 1, 2, 3, 4, 5, 6, 7]] };
    const boundaryKeys = new Set(boundaryFaceRings(hexEls).map(faceRingKey));
    expect(boundaryKeys.size).toBe(6); // a hex has 6 boundary quad faces

    const topFaceSurfaceEls = { elementTypes: [3], nodeTags: [[6, 7, 4, 5]] }; // quad4, reordered/rewound
    const surfaceKeys = surfaceElementRings(topFaceSurfaceEls).map(faceRingKey);
    expect(surfaceKeys).toHaveLength(1);
    expect(boundaryKeys.has(surfaceKeys[0])).toBe(true);
  });

  it("a surface element with no matching boundary face (interior/foreign) does not spuriously match", () => {
    const hexEls = { elementTypes: [5], nodeTags: [[0, 1, 2, 3, 4, 5, 6, 7]] };
    const boundaryKeys = new Set(boundaryFaceRings(hexEls).map(faceRingKey));
    const unrelatedSurfaceEls = { elementTypes: [2], nodeTags: [[100, 101, 102]] };
    const surfaceKeys = surfaceElementRings(unrelatedSurfaceEls).map(faceRingKey);
    expect(boundaryKeys.has(surfaceKeys[0])).toBe(false);
  });
});

describe("surfaceEdges", () => {
  it("emits triangle perimeter edges (3), no extras", () => {
    const s = edgeSet(surfaceEdges({ elementTypes: [2], nodeTags: [[0, 1, 2]] }, identityMap(2)));
    expect(s).toEqual(new Set(["0_1", "1_2", "0_2"]));
  });

  it("emits quad perimeter edges (4) with NO diagonal", () => {
    const s = edgeSet(surfaceEdges({ elementTypes: [3], nodeTags: [[0, 1, 2, 3]] }, identityMap(3)));
    expect(s).toEqual(new Set(["0_1", "1_2", "2_3", "0_3"]));
    expect(s.has("0_2")).toBe(false); // diagonal must not appear
    expect(s.has("1_3")).toBe(false);
  });

  it("uses only corner nodes for a quad9 (no mid-side edges)", () => {
    const s = edgeSet(surfaceEdges({ elementTypes: [10], nodeTags: [[0, 1, 2, 3, 4, 5, 6, 7, 8]] }, identityMap(8)));
    expect(s).toEqual(new Set(["0_1", "1_2", "2_3", "0_3"]));
  });
});

describe("boundaryEdges", () => {
  it("a single hex yields 12 unique quad-perimeter edges (no diagonals)", () => {
    const s = edgeSet(boundaryEdges({ elementTypes: [5], nodeTags: [[0, 1, 2, 3, 4, 5, 6, 7]] }, identityMap(7)));
    expect(s.size).toBe(12); // a cube has 12 edges
    // face diagonals like 0_2 / 1_3 must never appear
    expect(s.has("0_2")).toBe(false);
    expect(s.has("4_6")).toBe(false);
  });

  it("shares edges between adjacent boundary faces (drawn once)", () => {
    // two tets sharing face {1,2,3}; the outer boundary is an octahedron-ish
    // surface — every emitted edge is unique.
    const out = boundaryEdges({ elementTypes: [4], nodeTags: [[0, 1, 2, 3, 1, 2, 3, 4]] }, identityMap(4));
    const s = edgeSet(out);
    expect(s.size).toBe(out.length / 2); // no duplicate line segments
  });
});
