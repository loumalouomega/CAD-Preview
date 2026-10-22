import { describe, expect, test } from "vitest";
import { extractHoles, groupHoleCallouts, trimLength, type CylinderFace } from "./holeCallouts";

/** A cylinder face's triangles; `inward` flips the winding so normals face the axis. */
function cylinderTris(
  faceId: string,
  cx: number,
  cy: number,
  r: number,
  z0: number,
  z1: number,
  inward: boolean,
  pos: number[],
  idx: number[],
  ids: string[]
): void {
  const n = 24;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * 2 * Math.PI;
    const a1 = ((i + 1) / n) * 2 * Math.PI;
    const base = pos.length / 3;
    pos.push(
      cx + r * Math.cos(a0), cy + r * Math.sin(a0), z0,
      cx + r * Math.cos(a1), cy + r * Math.sin(a1), z0,
      cx + r * Math.cos(a1), cy + r * Math.sin(a1), z1,
      cx + r * Math.cos(a0), cy + r * Math.sin(a0), z1
    );
    const tris = inward ? [[0, 2, 1], [0, 3, 2]] : [[0, 1, 2], [0, 2, 3]];
    for (const t of tris) {
      idx.push(base + t[0], base + t[1], base + t[2]);
      ids.push(faceId);
    }
  }
}

/** A 40×40×10 slab's corner geometry (one triangle per z extreme) plus the given cylinders. */
function slab(cyls: Array<{ id: string; x: number; y: number; r: number; z0: number; z1: number; inward: boolean }>) {
  const pos: number[] = [0, 0, 0, 40, 0, 0, 40, 40, 0, 0, 0, 10, 40, 0, 10, 40, 40, 10];
  const idx: number[] = [0, 1, 2, 3, 4, 5];
  const ids: string[] = ["face-0", "face-1"];
  for (const c of cyls) cylinderTris(c.id, c.x, c.y, c.r, c.z0, c.z1, c.inward, pos, idx, ids);
  const faces: CylinderFace[] = cyls.map((c) => ({
    faceId: c.id,
    radius: c.r,
    axisLocation: [c.x, c.y, 0],
    axisDirection: [0, 0, 1],
  }));
  return { pos, idx, ids, faces };
}

describe("extractHoles", () => {
  test("four through holes of one size group into one callout with a designation", () => {
    const cyls = [10, 30].flatMap((x, i) =>
      [10, 30].map((y, j) => ({ id: `face-${2 + i * 2 + j}`, x, y, r: 2.5, z0: 0, z1: 10, inward: true }))
    );
    const { pos, idx, ids, faces } = slab(cyls);
    const holes = extractHoles(pos, idx, ids, faces);
    expect(holes).toHaveLength(4);
    expect(holes.every((h) => h.through)).toBe(true);
    const groups = groupHoleCallouts(holes);
    expect(groups).toHaveLength(1);
    expect(groups[0].holes).toHaveLength(4);
    expect(groups[0].text).toMatch(/^4× Ø5 THRU/);
    expect(groups[0].text).toContain("M6 TAP DRILL");
    expect(holes[0].centre[2]).toBeCloseTo(5, 6);
  });

  test("a blind hole reports its depth and is not THRU", () => {
    const { pos, idx, ids, faces } = slab([{ id: "face-2", x: 20, y: 20, r: 3, z0: 4, z1: 10, inward: true }]);
    const [h] = extractHoles(pos, idx, ids, faces);
    expect(h.through).toBe(false);
    expect(h.depth).toBeCloseTo(6, 6);
    expect(groupHoleCallouts([h])[0].text).toMatch(/^1× Ø6 ↧6/);
  });

  test("an outward-facing cylinder (a boss) is not a hole", () => {
    const { pos, idx, ids, faces } = slab([{ id: "face-2", x: 20, y: 20, r: 3, z0: 0, z1: 10, inward: false }]);
    expect(extractHoles(pos, idx, ids, faces)).toEqual([]);
  });

  test("two half-cylinders on one axis merge into one hole", () => {
    const { pos, idx, ids, faces } = slab([
      { id: "face-2", x: 20, y: 20, r: 3, z0: 0, z1: 5, inward: true },
      { id: "face-3", x: 20, y: 20, r: 3, z0: 5, z1: 10, inward: true },
    ]);
    const holes = extractHoles(pos, idx, ids, faces);
    expect(holes).toHaveLength(1);
    expect(holes[0].through).toBe(true);
    expect(holes[0].faceIds).toEqual(["face-2", "face-3"]);
  });

  test("different sizes make separate groups, smallest first", () => {
    const { pos, idx, ids, faces } = slab([
      { id: "face-2", x: 10, y: 10, r: 4, z0: 0, z1: 10, inward: true },
      { id: "face-3", x: 30, y: 30, r: 2, z0: 0, z1: 10, inward: true },
    ]);
    const groups = groupHoleCallouts(extractHoles(pos, idx, ids, faces));
    expect(groups.map((g) => g.diameter)).toEqual([4, 8]);
  });
});

test("trimLength drops float noise", () => {
  expect(trimLength(6.8000000001)).toBe("6.8");
  expect(trimLength(5)).toBe("5");
});
