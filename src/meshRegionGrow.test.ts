import { describe, expect, it } from "vitest";
import {
  growRegion,
  nearestTriangleToPoint,
  regionPoints,
  regionNormals,
  DEFAULT_GROW_ANGLE_DEG,
} from "./meshRegionGrow";

/**
 * A unit cube from (0,0,0) to (1,1,1) as 12 triangles with consistent outward
 * winding — the canonical fixture for a dihedral gate, since every face pair
 * meets at exactly 90°.
 */
function cube(): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, // z = 0
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, // z = 1
  ]);
  const indices = new Uint32Array([
    // -z
    0, 2, 1, 0, 3, 2,
    // +z
    4, 5, 6, 4, 6, 7,
    // -y
    0, 1, 5, 0, 5, 4,
    // +x
    1, 2, 6, 1, 6, 5,
    // +y
    2, 3, 7, 2, 7, 6,
    // -x
    3, 0, 4, 3, 4, 7,
  ]);
  return { positions, indices };
}

/** A flat 4x4 grid of quads in the z=0 plane, split into triangles. */
function grid(n = 4): { positions: Float32Array; indices: Uint32Array } {
  const pos: number[] = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) pos.push(x, y, 0);
  const idx: number[] = [];
  const at = (x: number, y: number) => y * (n + 1) + x;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      idx.push(at(x, y), at(x + 1, y), at(x + 1, y + 1));
      idx.push(at(x, y), at(x + 1, y + 1), at(x, y + 1));
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

describe("growRegion — the dihedral gate", () => {
  it("stops at a cube's 90-degree edges, keeping the seed's face only", () => {
    // THE point of the gate. Without it the walk floods all 12 triangles.
    const { positions, indices } = cube();
    const r = growRegion(positions, indices, 0);
    expect(r.triangles).toHaveLength(2);
    expect(r.capped).toBe(false);
  });

  it("crosses a flat interior, growing the whole coplanar patch", () => {
    const { positions, indices } = grid(4);
    const r = growRegion(positions, indices, 0);
    expect(r.triangles).toHaveLength(32); // 4x4 quads x 2
  });

  it("floods the whole cube once the gate is opened past 90 degrees", () => {
    // Confirms the gate — not some other bound — is what limits the region.
    const { positions, indices } = cube();
    const r = growRegion(positions, indices, 0, { angleDeg: 100 });
    expect(r.triangles).toHaveLength(12);
  });

  it("uses a default loose enough for a curved surface but tight enough for a cube", () => {
    expect(DEFAULT_GROW_ANGLE_DEG).toBeGreaterThan(15);
    expect(DEFAULT_GROW_ANGLE_DEG).toBeLessThan(90);
  });
});

describe("growRegion — the size cap", () => {
  it("stops at maxTriangles and says so, rather than silently truncating", () => {
    const { positions, indices } = grid(4);
    const r = growRegion(positions, indices, 0, { maxTriangles: 5 });
    expect(r.triangles).toHaveLength(5);
    expect(r.capped).toBe(true);
  });

  it("does not report capped when the region ended at a real edge", () => {
    const { positions, indices } = cube();
    const r = growRegion(positions, indices, 0, { maxTriangles: 100 });
    expect(r.capped).toBe(false);
  });
});

describe("growRegion — degenerate input", () => {
  it("returns an empty region for an out-of-range seed rather than throwing", () => {
    const { positions, indices } = cube();
    expect(growRegion(positions, indices, 999).triangles).toEqual([]);
    expect(growRegion(positions, indices, -1).triangles).toEqual([]);
    expect(() => growRegion(positions, indices, 1.5)).not.toThrow();
  });

  it("returns just the seed for a mesh of one triangle", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    expect(growRegion(positions, indices, 0).triangles).toEqual([0]);
  });
});

describe("nearestTriangleToPoint", () => {
  it("finds a triangle on the face the point sits above", () => {
    const { positions, indices } = cube();
    // Well above the +z face's centre.
    const t = nearestTriangleToPoint(positions, indices, [0.5, 0.5, 5]);
    // Growing from it must stay on that face.
    const r = growRegion(positions, indices, t);
    expect(r.triangles).toHaveLength(2);
    // Every vertex of the region is on z = 1.
    for (const p of regionPoints(positions, indices, r.triangles)) expect(p[2]).toBeCloseTo(1, 9);
  });

  it("returns -1 for an empty mesh", () => {
    expect(nearestTriangleToPoint(new Float32Array(), new Uint32Array(), [0, 0, 0])).toBe(-1);
  });
});

describe("regionPoints / regionNormals", () => {
  it("de-duplicates shared vertices", () => {
    const { positions, indices } = cube();
    // Two triangles of one face share an edge: 4 unique vertices, not 6.
    expect(regionPoints(positions, indices, [0, 1])).toHaveLength(4);
  });

  it("returns unit normals", () => {
    const { positions, indices } = cube();
    for (const n of regionNormals(positions, indices, [0, 1])) {
      expect(Math.hypot(...n)).toBeCloseTo(1, 9);
    }
  });

  it("gives a flat region parallel normals — which is why no cylinder fits it", () => {
    const { positions, indices } = grid(2);
    const ns = regionNormals(positions, indices, [0, 1, 2, 3]);
    for (const n of ns) expect(Math.abs(n[2])).toBeCloseTo(1, 9);
  });
});
