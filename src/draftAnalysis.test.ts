import { describe, it, expect } from "vitest";
import { analyzeDraft, resolvePull, type DraftMesh } from "./draftAnalysis";

/** Closed box [x0,x1]×[y0,y1]×[z0,z1], outward winding, 12 triangles; face ids per side. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, base = 0): { v: number[][]; t: number[][]; ids: string[] } {
  const v = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  const q: Array<[number[], string]> = [
    [[0,3,2,1], "bottom"], [[4,5,6,7], "top"], [[0,1,5,4], "front"], [[2,3,7,6], "back"], [[1,2,6,5], "right"], [[3,0,4,7], "left"],
  ];
  const t: number[][] = [], ids: string[] = [];
  for (const [[a, b, c, d], id] of q) {
    t.push([a + base, b + base, c + base], [a + base, c + base, d + base]);
    ids.push(id, id);
  }
  return { v, t, ids };
}
function toMesh(v: number[][], t: number[][]): DraftMesh {
  return { positions: new Float32Array(v.flat()), indices: new Uint32Array(t.flat()) };
}

/** Frustum: square base half-width `w0` at z=0, top half-width `w1` at z=h. */
function frustum(w0: number, w1: number, h: number) {
  const v = [[-w0,-w0,0],[w0,-w0,0],[w0,w0,0],[-w0,w0,0],[-w1,-w1,h],[w1,-w1,h],[w1,w1,h],[-w1,w1,h]];
  const quads: Array<[number[], string]> = [
    [[0,3,2,1], "bottom"], [[4,5,6,7], "top"], [[0,1,5,4], "front"], [[2,3,7,6], "back"], [[1,2,6,5], "right"], [[3,0,4,7], "left"],
  ];
  const t: number[][] = [], ids: string[] = [];
  for (const [[a, b, c, d], id] of quads) { t.push([a,b,c],[a,c,d]); ids.push(id, id); }
  return { mesh: toMesh(v, t), ids };
}

describe("analyzeDraft", () => {
  it("a box about +Z has four zero-draft walls and two caps", () => {
    const b = box(-1, 1, -1, 1, 0, 2);
    const r = analyzeDraft(toMesh(b.v, b.t), { faceIds: b.ids });
    expect(r.zeroDraft.map((f) => f.id).sort()).toEqual(["back", "front", "left", "right"]);
    for (const f of r.zeroDraft) expect(Math.abs(f.minDraftDeg)).toBeLessThan(1e-9);
    expect(r.capFaceCount).toBe(2);
    expect(r.counts).toEqual({ zeroDraft: 4, negativeDraft: 0, undercut: 0 });
    expect(r.projectedArea).toBeCloseTo(4, 6);
  });

  it("a frustum narrowing along +pull has the taper as positive draft; widening is negative one-sided", () => {
    const deg = 5;
    const h = 10;
    const w1 = 5 - h * Math.tan((deg * Math.PI) / 180);
    const up = frustum(5, w1, h);
    const r = analyzeDraft(up.mesh, { faceIds: up.ids });
    expect(r.minWallDraftDeg).toBeCloseTo(deg, 4);
    expect(r.maxWallDraftDeg).toBeCloseTo(deg, 4);
    expect(r.counts).toEqual({ zeroDraft: 0, negativeDraft: 0, undercut: 0 });
    // Reversing the pull flips the sign: the same walls now tilt away.
    const rev = analyzeDraft(up.mesh, { faceIds: up.ids, pull: "-Z" });
    expect(rev.minWallDraftDeg).toBeCloseTo(-deg, 4);
    expect(rev.counts.negativeDraft).toBe(4);
    // Two-sided measures each face against its own release side.
    const two = analyzeDraft(up.mesh, { faceIds: up.ids, pull: "-Z", twoSided: true });
    expect(two.counts.negativeDraft).toBe(0);
    expect(two.minWallDraftDeg).toBeCloseTo(deg, 4);
  });

  it("a block roofed over a slot shadows the slot wall along the pull", () => {
    // Lower block with a taller block offset above it overhanging the +x side.
    const lower = box(0, 4, 0, 4, 0, 2, 0);
    const upper = box(2, 8, 0, 4, 2, 4, 8);
    const v = [...lower.v, ...upper.v];
    const t = [...lower.t, ...upper.t];
    const ids = [...lower.ids.map((i) => `L${i}`), ...upper.ids.map((i) => `U${i}`)];
    // One body? They touch only at a face region without shared vertices, so they are two components — fine for shadowing.
    const r = analyzeDraft(toMesh(v, t), { faceIds: ids, pull: "+Z", twoSided: true });
    // Lower block's right wall (x=4, z 0..2) sits under the upper block's overhang? Upper spans x 2..8 above it → shadowed.
    expect(r.undercut.map((f) => f.id)).toContain("Lright");
    expect(r.undercut.find((f) => f.id === "Lright")!.shadowedFraction).toBeGreaterThan(0.9);
    // The upper block's walls are not shadowed.
    expect(r.undercut.map((f) => f.id)).not.toContain("Uright");
    // Without the roof: no undercut.
    const free = analyzeDraft(toMesh(lower.v, lower.t), { faceIds: lower.ids, twoSided: true });
    expect(free.counts.undercut).toBe(0);
  });

  it("groups coplanar facets when no ids are given, and reports the sample cap", () => {
    const b = box(-1, 1, -1, 1, 0, 2);
    const r = analyzeDraft(toMesh(b.v, b.t));
    expect(r.faceCount).toBe(6);
    expect(r.sampling.used).toBe(2000);
    expect(analyzeDraft(toMesh(b.v, b.t), { maxSamples: 0 }).warnings.join(" ")).toMatch(/undercut test was skipped/);
  });

  it("validates its inputs", () => {
    expect(resolvePull([0, 0, 2])).toEqual([0, 0, 1]);
    expect(() => resolvePull([0, 0, 0])).toThrow(/non-zero/);
    expect(() => resolvePull("up" as never)).toThrow(/pull must be one of/);
    const b = box(0, 1, 0, 1, 0, 1);
    expect(() => analyzeDraft(toMesh(b.v, b.t), { minDraftDeg: 90 })).toThrow(/minDraftDeg/);
    expect(() => analyzeDraft(toMesh(b.v, b.t), { faceIds: ["a"] })).toThrow(/faceIds/);
  });
});
