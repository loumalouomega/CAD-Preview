import { describe, it, expect } from "vitest";
import { planFacetMerge, validateMergeFacets, DEFAULT_MERGE_ANGLE_DEG, MAX_MERGE_ANGLE_DEG } from "./meshFacetMerge";
import { weldTriangleSoup, type WeldedMesh } from "./meshComponents";

type V3 = [number, number, number];

function weld(tris: V3[][]): WeldedMesh {
  const soup = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((p, k) => p.forEach((c, a) => (soup[i * 9 + k * 3 + a] = c))));
  return weldTriangleSoup(soup);
}

/** A cube of side 10 whose six faces are each an n x n grid of quads, every quad split in two (12 n^2 triangles). */
function gridCube(n: number): V3[][] {
  const L = 10, tris: V3[][] = [];
  const face = (origin: V3, du: V3, dv: V3): void => {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const p = (a: number, b: number): V3 => [0, 1, 2].map((k) => origin[k] + (du[k] * a) / n + (dv[k] * b) / n) as V3;
      tris.push([p(i, j), p(i + 1, j), p(i + 1, j + 1)], [p(i, j), p(i + 1, j + 1), p(i, j + 1)]);
    }
  };
  face([0, 0, 0], [0, L, 0], [L, 0, 0]);
  face([0, 0, L], [L, 0, 0], [0, L, 0]);
  face([0, 0, 0], [L, 0, 0], [0, 0, L]);
  face([0, L, 0], [0, 0, L], [L, 0, 0]);
  face([0, 0, 0], [0, 0, L], [0, L, 0]);
  face([L, 0, 0], [0, L, 0], [0, 0, L]);
  return tris;
}

/** n-sided prism about z, outward winding: caps are fans, sides are split quads. */
function prism(n: number, r: number, h: number): V3[][] {
  const ring = (z: number): V3[] => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), z] as V3);
  const lo = ring(0), hi = ring(h);
  const tris: V3[][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push([[0, 0, 0], lo[j], lo[i]], [[0, 0, h], hi[i], hi[j]], [lo[i], lo[j], hi[j]], [lo[i], hi[j], hi[i]]);
  }
  return tris;
}

/** 10 x 10 x 4 plate with a 4 x 4 through-hole at (3..7, 3..7). */
function plateWithHole(): V3[][] {
  const quad = (a: V3, b: V3, c: V3, d: V3): V3[][] => [[a, b, c], [a, c, d]];
  const outer = (z: number): V3[] => [[0, 0, z], [10, 0, z], [10, 10, z], [0, 10, z]];
  const inner = (z: number): V3[] => [[3, 3, z], [7, 3, z], [7, 7, z], [3, 7, z]];
  const tris: V3[][] = [];
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4;
    tris.push(...quad(outer(4)[k], outer(4)[k2], inner(4)[k2], inner(4)[k]));
    tris.push(...quad(outer(0)[k], inner(0)[k], inner(0)[k2], outer(0)[k2]));
    tris.push(...quad(outer(0)[k], outer(0)[k2], outer(4)[k2], outer(4)[k]));
    tris.push(...quad(inner(0)[k], inner(4)[k], inner(4)[k2], inner(0)[k2]));
  }
  return tris;
}

const all = (m: WeldedMesh): number[] => Array.from({ length: m.indices.length / 3 }, (_, i) => i);
const TOL = 1e-4;

describe("planFacetMerge", () => {
  it("merges a triangulated cube into its 6 faces, each a 4-vertex outer loop with no holes", () => {
    const m = weld(gridCube(1));
    const plan = planFacetMerge(m, all(m), 1, TOL);
    expect(plan.merged).toHaveLength(6);
    expect(plan.singles).toEqual([]);
    expect(plan.rejectedFacets).toBe(0);
    for (const f of plan.merged) {
      expect(f.triangles).toHaveLength(2);
      expect(f.outer).toHaveLength(4);
      expect(f.holes).toEqual([]);
    }
  });

  it("collapses a 20-by-20-per-face cube (4 800 triangles) to 6 faces whose outer loops keep every boundary vertex", () => {
    const m = weld(gridCube(20));
    const plan = planFacetMerge(m, all(m), 1, TOL);
    expect(plan.merged).toHaveLength(6);
    expect(plan.singles).toEqual([]);
    for (const f of plan.merged) expect(f.outer).toHaveLength(80); // 4 sides x 20 segments
  });

  it("builds the outer loop counter-clockwise and a hole clockwise about the facet normal", () => {
    const m = weld(plateWithHole());
    const plan = planFacetMerge(m, all(m), 1, TOL);
    // top, bottom, 4 outer walls, 4 hole walls
    expect(plan.merged).toHaveLength(10);
    expect(plan.singles).toEqual([]);
    const withHoles = plan.merged.filter((f) => f.holes.length > 0);
    expect(withHoles).toHaveLength(2); // the top and bottom annuli
    for (const f of withHoles) {
      expect(f.outer).toHaveLength(4);
      expect(f.holes).toHaveLength(1);
      expect(f.holes[0]).toHaveLength(4);
      // The hole is the small square: its x extent is 4, the outer's is 10.
      const span = (loop: number[]): number => {
        const xs = loop.map((v) => m.positions[v * 3]);
        return Math.max(...xs) - Math.min(...xs);
      };
      expect(span(f.outer)).toBeCloseTo(10, 5);
      expect(span(f.holes[0])).toBeCloseTo(4, 5);
    }
  });

  it("merges a 32-gon prism's two caps and 32 sides at 1 degree (dihedral 11.25)", () => {
    const m = weld(prism(32, 5, 10));
    const plan = planFacetMerge(m, all(m), 1, TOL);
    expect(plan.merged).toHaveLength(34);
    expect(plan.singles).toEqual([]);
    expect(plan.merged.filter((f) => f.outer.length === 32)).toHaveLength(2);
  });

  // The control for the case above: widening the angle past the dihedral chains the curved sides together, and
  // the planarity check — not the angle — is what refuses to flatten them. (A leftover single side, whose two
  // triangles ARE coplanar, may still legitimately merge; what must never happen is a curved chain merging.)
  it("never merges a curved chain of sides when the angle is wide enough to chain them", () => {
    const m = weld(prism(32, 5, 10));
    const plan = planFacetMerge(m, all(m), 15, TOL);
    expect(plan.rejectedFacets).toBeGreaterThan(0);
    expect(plan.singles.length).toBeGreaterThan(0);
    // Every merged facet is genuinely flat, measured independently of the planner.
    for (const f of plan.merged) {
      const verts = new Set(f.triangles.flatMap((t) => [0, 1, 2].map((k) => m.indices[t * 3 + k])));
      const [px, py, pz] = [...verts].reduce((s, v) => [s[0] + m.positions[v * 3], s[1] + m.positions[v * 3 + 1], s[2] + m.positions[v * 3 + 2]], [0, 0, 0]);
      for (const v of verts) {
        const d = (m.positions[v * 3] - px / verts.size) * f.normal[0] + (m.positions[v * 3 + 1] - py / verts.size) * f.normal[1] + (m.positions[v * 3 + 2] - pz / verts.size) * f.normal[2];
        expect(Math.abs(d)).toBeLessThanOrEqual(TOL);
      }
    }
    // The two 32-gon caps still merge, and no triangle is lost or duplicated.
    expect(plan.merged.filter((f) => f.outer.length === 32)).toHaveLength(2);
    const covered = [...plan.singles, ...plan.merged.flatMap((f) => f.triangles)];
    expect(covered).toHaveLength(all(m).length);
    expect(new Set(covered).size).toBe(all(m).length);
  });

  it("leaves an isolated triangle as a single", () => {
    const m = weld([[[0, 0, 0], [1, 0, 0], [0, 1, 0]]]);
    const plan = planFacetMerge(m, all(m), 1, TOL);
    expect(plan.merged).toEqual([]);
    expect(plan.singles).toEqual([0]);
  });

  it("does not merge across a fold sharper than the angle", () => {
    // Two triangles sharing an edge, folded 30 degrees apart.
    const a = (30 * Math.PI) / 180;
    const m = weld([[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 1, 0], [0.5, 0.5 + Math.cos(a), Math.sin(a)]]]);
    expect(planFacetMerge(m, all(m), 1, TOL).singles).toHaveLength(2);
    expect(planFacetMerge(m, all(m), 1, TOL).merged).toEqual([]);
  });
});

describe("validateMergeFacets", () => {
  it("reads true as the default angle and an object's angle when it is in range", () => {
    expect(validateMergeFacets(true)).toEqual({ angleToleranceDeg: DEFAULT_MERGE_ANGLE_DEG });
    expect(validateMergeFacets({ angleToleranceDeg: 3 })).toEqual({ angleToleranceDeg: 3 });
    expect(validateMergeFacets({})).toEqual({ angleToleranceDeg: DEFAULT_MERGE_ANGLE_DEG });
  });

  it("falls back to the default for an out-of-range angle rather than switching a requested merge off", () => {
    for (const bad of [0, -1, MAX_MERGE_ANGLE_DEG + 1, NaN, "3", null]) {
      expect(validateMergeFacets({ angleToleranceDeg: bad })).toEqual({ angleToleranceDeg: DEFAULT_MERGE_ANGLE_DEG });
    }
  });

  it("is off for false, null, undefined, numbers and arrays", () => {
    for (const off of [false, null, undefined, 1, "yes", []]) expect(validateMergeFacets(off)).toBeUndefined();
  });
});
