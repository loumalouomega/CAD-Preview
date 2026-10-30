import { describe, expect, it } from "vitest";
import {
  buildMpcLinks,
  findHangingConstraints,
  hangingInterfaceFilter,
  mpcFacts,
  patchTestMaxError,
  type MpcNode,
} from "./hangingConstraints";
import { boundaryFaceRings } from "./gmshElementTypes";

/** A 2×2×2 coarse hexahedron on x∈[0,2] beside 2×2×2 unit fine hexahedra on
 * x∈[2,4] — the smallest 2:1 interface (same layout as VSCode-MDPA-Preview's
 * `hanging_two_level.mdpa`). Its box is 4×2×2, so its true surface area is 40. */
function twoLevel(): { nodes: MpcNode[]; hexes: number[][] } {
  const coords: Record<number, [number, number, number]> = {
    1: [0, 0, 0], 2: [2, 0, 0], 3: [2, 2, 0], 4: [0, 2, 0], 5: [0, 0, 2], 6: [2, 0, 2], 7: [2, 2, 2], 8: [0, 2, 2],
    9: [3, 0, 0], 10: [3, 1, 0], 11: [2, 1, 0], 12: [2, 0, 1], 13: [3, 0, 1], 14: [3, 1, 1], 15: [2, 1, 1],
    16: [3, 0, 2], 17: [3, 1, 2], 18: [2, 1, 2], 19: [3, 2, 0], 20: [3, 2, 1], 21: [2, 2, 1], 22: [3, 2, 2],
    23: [4, 0, 0], 24: [4, 1, 0], 25: [4, 0, 1], 26: [4, 1, 1], 27: [4, 0, 2], 28: [4, 1, 2], 29: [4, 2, 0],
    30: [4, 2, 1], 31: [4, 2, 2],
  };
  const hexes = [
    [1, 2, 3, 4, 5, 6, 7, 8],
    [2, 9, 10, 11, 12, 13, 14, 15],
    [12, 13, 14, 15, 6, 16, 17, 18],
    [11, 10, 19, 3, 15, 14, 20, 21],
    [15, 14, 20, 21, 18, 17, 22, 7],
    [9, 23, 24, 10, 13, 25, 26, 14],
    [13, 25, 26, 14, 16, 27, 28, 17],
    [10, 24, 29, 19, 14, 26, 30, 20],
    [14, 26, 30, 20, 17, 28, 31, 22],
  ];
  const nodes = Object.entries(coords).map(([tag, [x, y, z]]) => ({ tag: Number(tag), x, y, z }));
  return { nodes, hexes };
}

/** Total area of the quad rings (each ring is planar and rectangular here). */
function ringArea(rings: number[][], nodes: MpcNode[]): number {
  const at = new Map(nodes.map((n) => [n.tag, n]));
  let area = 0;
  for (const ring of rings) {
    const [a, b, , d] = ring.map((t) => at.get(t)!);
    area += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * Math.hypot(d.x - a.x, d.y - a.y, d.z - a.z);
  }
  return area;
}

describe("findHangingConstraints", () => {
  it("ties the four edge midpoints at 1/2-1/2 and the face centre at 1/4 each", () => {
    const { nodes, hexes } = twoLevel();
    const r = findHangingConstraints(nodes, hexes);
    expect(r.cellsChecked).toBe(9);
    expect(r.chained).toBe(0);
    expect(r.constraints.map((c) => c.slave)).toEqual([11, 12, 15, 18, 21]);
    const bySlave = new Map(r.constraints.map((c) => [c.slave, c]));
    expect(bySlave.get(11)).toEqual({ slave: 11, masters: [2, 3], weights: [0.5, 0.5] });
    expect(bySlave.get(12)).toEqual({ slave: 12, masters: [2, 6], weights: [0.5, 0.5] });
    expect(bySlave.get(18)).toEqual({ slave: 18, masters: [6, 7], weights: [0.5, 0.5] });
    expect(bySlave.get(21)).toEqual({ slave: 21, masters: [3, 7], weights: [0.5, 0.5] });
    const centre = bySlave.get(15)!;
    expect(centre.masters).toEqual([2, 3, 6, 7]);
    for (const w of centre.weights) expect(w).toBeCloseTo(0.25, 12);
  });

  it("reproduces a linear field exactly at every hanging node (patch test)", () => {
    const { nodes, hexes } = twoLevel();
    const r = findHangingConstraints(nodes, hexes);
    expect(patchTestMaxError(r.constraints, nodes)).toBeLessThan(1e-12);
  });

  it("the patch test sees a hanging node that has moved off its parents", () => {
    const { nodes, hexes } = twoLevel();
    const r = findHangingConstraints(nodes, hexes);
    const moved = nodes.map((n) => (n.tag === 11 ? { ...n, y: n.y + 0.05 } : n));
    // Control: the unmoved mesh is exact, the moved one is not.
    expect(patchTestMaxError(r.constraints, nodes)).toBeLessThan(1e-12);
    expect(patchTestMaxError(r.constraints, moved)).toBeGreaterThan(1e-3);
  });

  it("returns nothing for a conforming mesh", () => {
    const nodes: MpcNode[] = [];
    let tag = 1;
    for (const z of [0, 1]) for (const y of [0, 1]) for (const x of [0, 1]) nodes.push({ tag: tag++, x, y, z });
    const r = findHangingConstraints(nodes, [[1, 2, 4, 3, 5, 6, 8, 7]]);
    expect(r.constraints).toEqual([]);
    expect(r.hostFaces).toEqual([]);
  });

  it("composes a chain down to end masters", () => {
    // A: edge (0,0,0)-(4,0,0) is the long edge; B hangs h1=(2,0,0) as a corner and
    // has h2=(3,0,0) on its own edge h1-(4,0,0). B first so h2 is found through B.
    const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, tag0: number) => {
      const c: [number, number, number][] = [
        [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
        [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
      ];
      return c.map(([x, y, z], i) => ({ tag: tag0 + i, x, y, z }));
    };
    const A = box(0, 4, -4, 0, -4, 0, 1); // tags 1..8: n(0,0,0)=1, n(4,0,0)=2
    const B = box(2, 4, 0, 2, 0, 2, 11); // tags 11..18: h1=(2,0,0)=11, n(4,0,0)=12 (a twin of tag 2)
    const nodes: MpcNode[] = [...A, ...B, { tag: 20, x: 3, y: 0, z: 0 }, { tag: 21, x: 1, y: 0, z: 0 }];
    const hexes = [B.map((n) => n.tag), A.map((n) => n.tag)];
    const r = findHangingConstraints(nodes, hexes);
    const c20 = r.constraints.find((c) => c.slave === 20)!;
    // h2 sits on B's edge 11-12 at t = 1/2; 11 (a B corner) is not hanging onto A's tag-1/tag-2 edge
    // because 11 is a corner of B but lies at the middle of A's edge: chain 20 -> 11 -> {1, 2}.
    expect(r.chained).toBeGreaterThanOrEqual(1);
    // 20 = 1/2·11 + 1/2·12 and 11 = 1/2·7 + 1/2·8  →  {7: 1/4, 8: 1/4, 12: 1/2} (7 is A's corner at x=4, 8 at x=0).
    expect(c20.masters).toEqual([7, 8, 12]);
    expect(c20.weights).toEqual([0.25, 0.25, 0.5]);
    // An asymmetric edge node (x = 1 on the edge 8 (x=0) → 7 (x=4)) keeps the weight order.
    const c21 = r.constraints.find((c) => c.slave === 21)!;
    expect(c21.masters).toEqual([7, 8]);
    expect(c21.weights[0]).toBeCloseTo(0.25, 12);
    expect(c21.weights[1]).toBeCloseTo(0.75, 12);
    expect(c20.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(patchTestMaxError(r.constraints, nodes)).toBeLessThan(1e-12);
  });

  it("refuses a cycle by name instead of writing it", () => {
    const hex = (x0: number, dx: number, tag0: number): MpcNode[] => {
      const x1 = x0 + dx;
      const c: [number, number, number][] = [
        [x0, 0, 0], [x1, 0, 0], [x1, 1, 0], [x0, 1, 0], [x0, 0, 1], [x1, 0, 1], [x1, 1, 1], [x0, 1, 1],
      ];
      return c.map(([x, y, z], i) => ({ tag: tag0 + i, x, y, z }));
    };
    // X's edge runs h2=(1,0,0) -> (5,0,0) with h1=(3,0,0) at its middle; Y's runs
    // h1 -> (-1,0,0) with h2 at its middle: each hangs on the other.
    const X = hex(1, 4, 1);
    const Y = hex(3, -4, 11);
    const nodes = [...X, ...Y];
    expect(() => findHangingConstraints(nodes, [X.map((n) => n.tag), Y.map((n) => n.tag)])).toThrow(/cycle/);
  });
});

describe("hangingInterfaceFilter", () => {
  const rings = (hexes: number[][]) =>
    boundaryFaceRings({ elementTypes: [5], nodeTags: [hexes.flat()] });

  it("without the filter the interface is drawn as boundary (control)", () => {
    const { nodes, hexes } = twoLevel();
    // 40 true surface + the coarse face (4) + its four fine faces (4).
    expect(ringArea(rings(hexes), nodes)).toBeCloseTo(48, 12);
  });

  it("drops both sides of the coarse/fine interface, leaving the true surface (40)", () => {
    const { nodes, hexes } = twoLevel();
    const drop = hangingInterfaceFilter(findHangingConstraints(nodes, hexes));
    const kept = rings(hexes).filter((r) => !drop(r));
    expect(ringArea(kept, nodes)).toBeCloseTo(40, 12);
    // 5 outer faces of the coarse hexahedron + 20 unit faces on the fine block's other sides.
    expect(kept).toHaveLength(25);
  });
});

describe("buildMpcLinks / mpcFacts", () => {
  it("emits one slave→master pair per master and reports a cap as truncated", () => {
    const { nodes, hexes } = twoLevel();
    const r = findHangingConstraints(nodes, hexes);
    const tagToIndex = new Map(nodes.map((n, i) => [n.tag, i]));
    const links = buildMpcLinks(r.constraints, tagToIndex);
    expect(links.indices.length / 2).toBe(4 * 2 + 4); // 4 edge nodes × 2 + 1 face node × 4
    expect(links.truncated).toBe(0);
    const capped = buildMpcLinks(r.constraints, tagToIndex, 5);
    expect(capped.indices.length / 2).toBe(5);
    expect(capped.truncated).toBe(7);
  });

  it("counts rows as hanging nodes × variables", () => {
    const { nodes, hexes } = twoLevel();
    const f = mpcFacts(findHangingConstraints(nodes, hexes), ["DISPLACEMENT_X", "DISPLACEMENT_Y", "DISPLACEMENT_Z"]);
    expect(f).toEqual({ hangingNodes: 5, constraints: 15, chained: 0, variables: ["DISPLACEMENT_X", "DISPLACEMENT_Y", "DISPLACEMENT_Z"] });
  });
});
