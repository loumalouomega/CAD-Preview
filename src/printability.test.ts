import { describe, expect, it } from "vitest";
import { analyzePrintability, overhangFlags, NOT_CHECKED, type PrintMesh } from "./printability";
import { box } from "./triangleRay.test";

const merge = (...ms: PrintMesh[]): PrintMesh => {
  const positions = new Float32Array(ms.flatMap((m) => [...m.positions]));
  let off = 0;
  const indices: number[] = [];
  for (const m of ms) {
    for (const i of m.indices) indices.push(i + off);
    off += m.positions.length / 3;
  }
  return { positions, indices: new Uint32Array(indices) };
};
/** Reverse every triangle (inward-facing winding) — a cavity wall. */
const invert = (m: PrintMesh): PrintMesh => {
  const idx = new Uint32Array(m.indices);
  for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  return { positions: m.positions, indices: idx };
};
const rotateX = (m: PrintMesh, deg: number, cy: number, cz: number): PrintMesh => {
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  const p = new Float32Array(m.positions);
  for (let i = 0; i < p.length; i += 3) {
    const y = p[i + 1] - cy, z = p[i + 2] - cz;
    p[i + 1] = cy + y * c - z * s;
    p[i + 2] = cz + y * s + z * c;
  }
  return { positions: p, indices: m.indices };
};
const orient = (r: ReturnType<typeof analyzePrintability>, up: string) => r.orientations.find((o) => o.up === up)!;

describe("analyzePrintability — closure, bodies, units", () => {
  it("a cube is one closed body of volume 1000 with a 10 mm bbox", () => {
    const r = analyzePrintability(box(10, 10, 10));
    expect(r.bodyCount).toBe(1);
    expect(r.bodies[0].closed).toBe(true);
    expect(r.bodies[0].volume).toBeCloseTo(1000, 3);
    expect(r.unitsSuspect.suspect).toBe(false);
  });

  it("two disjoint cubes are two bodies", () => {
    const r = analyzePrintability(merge(box(10, 10, 10), box(5, 5, 5, 30, 0, 0)));
    expect(r.bodyCount).toBe(2);
    expect(r.bodies.map((b) => b.closed)).toEqual([true, true]);
  });

  it("an open shell (one facet removed) is reported not closed, with a warning", () => {
    const c = box(10, 10, 10);
    const r = analyzePrintability({ positions: c.positions, indices: c.indices.slice(0, c.indices.length - 3) });
    expect(r.bodies[0].closed).toBe(false);
    expect(r.bodies[0].freeEdges).toBeGreaterThan(0);
    expect(r.warnings.join(" ")).toMatch(/not a closed manifold/);
  });

  it("flags a sub-millimetre model as units-suspect", () => {
    expect(analyzePrintability(box(0.01, 0.01, 0.01)).unitsSuspect.suspect).toBe(true);
    expect(analyzePrintability(box(2e4, 1, 1)).unitsSuspect.suspect).toBe(true);
  });
});

describe("analyzePrintability — overhang", () => {
  it("a cube sitting on a face has no overhang, and its bottom is plate contact", () => {
    const o = orient(analyzePrintability(box(10, 10, 10)), "+Z");
    expect(o.overhangArea).toBe(0);
    expect(o.plateContactArea).toBeCloseTo(100, 6);
    expect(o.buildHeight).toBeCloseTo(10, 6);
  });

  it("the same cube tilted onto an edge (30° limit) has more overhang than on its face", () => {
    const flat = orient(analyzePrintability(box(10, 10, 10), { overhangLimitDeg: 30 }), "+Z");
    const tilted = rotateX(box(10, 10, 10), 45, 5, 5);
    const edge = orient(analyzePrintability(tilted, { overhangLimitDeg: 30 }), "+Z");
    expect(edge.overhangArea).toBeGreaterThan(flat.overhangArea);
    // Two 10×10 faces each inclined 45° from the plate: both are down-facing overhangs.
    expect(edge.overhangArea).toBeCloseTo(200, 3);
    expect(edge.supportVolumeUpperBound).toBeGreaterThan(0);
  });

  it("a face exactly at the limit is not an overhang (control for the strict comparison)", () => {
    const tilted = rotateX(box(10, 10, 10), 45, 5, 5);
    expect(orient(analyzePrintability(tilted, { overhangLimitDeg: 45 }), "+Z").overhangArea).toBe(0);
    expect(orient(analyzePrintability(tilted, { overhangLimitDeg: 44 }), "+Z").overhangArea).toBeCloseTo(200, 3);
  });

  it("flipping the build direction swaps the plate face (+Z vs -Z)", () => {
    const r = analyzePrintability(box(10, 10, 10));
    // Cube is symmetric: both ±Z rest a full face on the plate, no overhang.
    expect(orient(r, "-Z").plateContactArea).toBeCloseTo(100, 6);
    expect(orient(r, "-Z").overhangArea).toBe(0);
  });

  it("a body floating above another needs support under it", () => {
    const m = merge(box(10, 10, 10), box(10, 10, 10, 0, 0, 20));
    const up = orient(analyzePrintability(m), "+Z");
    expect(up.overhangArea).toBeCloseTo(100, 6); // the upper cube's underside
    expect(up.plateContactArea).toBeCloseTo(100, 6); // the lower cube's underside is on the plate
    expect(up.supportVolumeUpperBound).toBeCloseTo(100 * 20, 3); // column from z=20 down to the plate
  });

  it("overhangFlags marks exactly the triangles that overhangArea counts", () => {
    const tilted = rotateX(box(10, 10, 10), 45, 5, 5);
    const flags = overhangFlags(tilted, "+Z", 30);
    const marked = flags.reduce((n, f) => n + f, 0);
    expect(marked).toBe(orient(analyzePrintability(tilted, { overhangLimitDeg: 30 }), "+Z").overhangTriangles);
    expect(marked).toBe(4);
  });

  it("uses the process limit when no explicit angle is given", () => {
    const tilted = rotateX(box(10, 10, 10), 45, 5, 5);
    const r = analyzePrintability(tilted, { process: { name: "p", maxOverhangDeg: 30, source: "test" } });
    expect(r.overhangLimitDeg).toBe(30);
    expect(orient(r, "+Z").overhangArea).toBeCloseTo(200, 3);
  });
});

describe("analyzePrintability — plate fit", () => {
  it("fits when the footprint can sit on the plate turned about the vertical", () => {
    const r = analyzePrintability(box(30, 10, 5), { plate: { x: 12, y: 40, z: 6 } });
    expect(orient(r, "+Z").fitsPlate).toBe(true); // 30×10 on a 12×40 plate, turned 90°
    expect(orient(r, "+X").fitsPlate).toBe(false); // up=X: height 30 > z 6
  });
  it("omits fitsPlate without a plate", () => {
    expect(orient(analyzePrintability(box(1, 1, 1)), "+Z").fitsPlate).toBeUndefined();
  });
});

describe("analyzePrintability — wall thickness (sampled)", () => {
  it("a 20×20×1 slab reports a 1 mm wall", () => {
    const w = analyzePrintability(box(20, 20, 1)).bodies[0].wall;
    expect(w.min).toBeCloseTo(1, 3);
    expect(w.median).toBeCloseTo(1, 3);
    expect(w.noHit).toBe(0);
  });

  it("a solid cube reports 10 mm", () => {
    const w = analyzePrintability(box(10, 10, 10)).bodies[0].wall;
    expect(w.min).toBeCloseTo(10, 3);
  });

  it("a hollow cube (10 outer, 8 inner) reports its 1 mm wall — cavity winding handled", () => {
    const hollow = merge(box(10, 10, 10), invert(box(8, 8, 8, 1, 1, 1)));
    const r = analyzePrintability(hollow);
    // The cavity shell floats inside the outer one: two components, the inner with negative signed volume.
    const cavity = r.bodies.find((x) => x.bounds && x.bounds.max[0] - x.bounds.min[0] < 9)!;
    const outer = r.bodies.find((x) => x !== cavity)!;
    // Both shells see the same 1 mm wall; a flipped cavity would read 8 (the void across).
    expect(cavity.wall.min).toBeCloseTo(1, 2);
    expect(outer.wall.min).toBeCloseTo(1, 2);
  });

  it("counts samples below the process minimum wall (control: none below a thinner limit)", () => {
    const r = analyzePrintability(box(20, 20, 1), { process: { name: "p", minWallMm: 1.5, source: "test" } });
    const w = r.bodies[0].wall;
    // Top and bottom (840 of 880 mm²) measure 1 mm; the four 20×1 sides measure 20 mm.
    expect(w.belowMinWall!).toBeGreaterThan(0.9 * w.samples);
    expect(w.belowMinWall!).toBeLessThan(w.samples);
    const loose = analyzePrintability(box(20, 20, 1), { process: { name: "p", minWallMm: 0.5, source: "test" } });
    expect(loose.bodies[0].wall.belowMinWall).toBe(0);
  });

  it("respects the sample cap and says it is sampled", () => {
    const r = analyzePrintability(box(10, 10, 10), { maxSamples: 64 });
    expect(r.sampling.used).toBe(64);
    expect(r.sampling.note).toMatch(/sampled/i);
    expect(analyzePrintability(box(10, 10, 10), { maxSamples: 0 }).bodies[0].wall.samples).toBe(0);
  });

  it("is deterministic", () => {
    const a = analyzePrintability(box(20, 20, 1));
    const b = analyzePrintability(box(20, 20, 1));
    expect(a.bodies[0].wall).toEqual(b.bodies[0].wall);
  });
});

describe("analyzePrintability — not checked, validation", () => {
  it("lists unmeasured rules as checked:false, never as passed", () => {
    const r = analyzePrintability(box(1, 1, 1));
    expect(r.notChecked.length).toBe(NOT_CHECKED.length);
    expect(r.notChecked.every((n) => n.checked === false && n.reason.length > 0)).toBe(true);
    expect(r.notChecked.map((n) => n.rule).join(" ")).toMatch(/bridge/);
  });

  it("rejects a bad angle or sample cap", () => {
    expect(() => analyzePrintability(box(1, 1, 1), { overhangLimitDeg: 95 })).toThrow(/between 0 and 90/);
    expect(() => analyzePrintability(box(1, 1, 1), { maxSamples: -1 })).toThrow(/maxSamples/);
  });

  it("handles an empty mesh", () => {
    const r = analyzePrintability({ positions: new Float32Array(), indices: new Uint32Array() });
    expect(r.bodyCount).toBe(0);
    expect(r.bounds).toBeNull();
  });
});
