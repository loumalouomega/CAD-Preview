import { describe, it, expect } from "vitest";
import { findPassages, type PassageFace, type SizeContext, type Vec3 } from "./passageAnalysis";

/** A cylinder face as the kernel would measure it: points ring around the axis over [z0, z1]. */
function cyl(id: string, r: number, z0: number, z1: number, outward: "away" | "toward", owner = "solid-0"): PassageFace {
  const points: Vec3[] = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * 2 * Math.PI;
    points.push([r * Math.cos(a), r * Math.sin(a), z0], [r * Math.cos(a), r * Math.sin(a), z1]);
  }
  return {
    faceId: id,
    owner,
    surface: { kind: "cylinder", radius: r, axisLocation: [0, 0, 0], axisDirection: [0, 0, 1] },
    sample: { point: [r, 0, (z0 + z1) / 2], normal: outward === "away" ? [1, 0, 0] : [-1, 0, 0] },
    points,
  };
}

/** A square planar face at height z with the given outward normal (±z). */
function plane(id: string, z: number, up: boolean, half = 5, dx = 0, owner = "solid-0"): PassageFace {
  const points: Vec3[] = [
    [dx - half, -half, z],
    [dx + half, -half, z],
    [dx + half, half, z],
    [dx - half, half, z],
  ];
  return {
    faceId: id,
    owner,
    surface: { kind: "plane", origin: [dx, 0, z], normal: [0, 0, 1] },
    sample: { point: [dx, 0, z], normal: up ? [0, 0, 1] : [0, 0, -1] },
    points,
  };
}

const ctx = (sizeMax: number | null, faceSizes: [string, number][] = [], solidSizes: [string, number][] = []): SizeContext => ({
  sizeMax,
  faceSizes: new Map(faceSizes),
  solidSizes: new Map(solidSizes),
});

describe("findPassages — annular gaps", () => {
  it("finds a void annulus (rod in a bore) with the radial width and axial overlap", () => {
    const rod = cyl("face-0", 7, 0, 10, "away");
    const bore = cyl("face-1", 8, 2, 12, "toward");
    const r = findPassages([rod, bore], ctx(2), { diagonal: 30 });
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.kind).toBe("annular");
    expect(f.width).toBeCloseTo(1);
    expect(f.overlap).toBeCloseTo(8);
    expect(f.cellsAcross).toBeCloseTo(0.5);
    expect(f.underResolved).toBe(true);
    expect(f.suggestedSize).toBeCloseTo(1 / 3);
  });

  it("skips a tube wall — material between the faces is not a passage", () => {
    const outerSkin = cyl("face-0", 10, 0, 10, "away");
    const innerSkin = cyl("face-1", 8, 0, 10, "toward");
    expect(findPassages([innerSkin, outerSkin], ctx(2), { diagonal: 30 }).findings).toHaveLength(0);
  });

  it("rejects merely coaxial, axially disjoint cylinders instead of reporting a passage", () => {
    const rod = cyl("face-0", 5, 0, 10, "away");
    const bore = cyl("face-1", 6, 20, 30, "toward");
    const r = findPassages([rod, bore], ctx(2), { diagonal: 40 });
    expect(r.findings).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/no axial overlap/);
  });

  it("ignores parallel but non-coaxial cylinders", () => {
    const a = cyl("face-0", 5, 0, 10, "away");
    const b = { ...cyl("face-1", 6, 0, 10, "toward"), surface: { kind: "cylinder" as const, radius: 6, axisLocation: [20, 0, 0] as Vec3, axisDirection: [0, 0, 1] as Vec3 } };
    expect(findPassages([a, b], ctx(2), { diagonal: 40 }).findings).toHaveLength(0);
  });
});

describe("findPassages — slots", () => {
  it("finds two faces facing each other across a void, with the plane distance as width", () => {
    const floor = plane("face-0", 0, true); // outward up, into the gap
    const ceiling = plane("face-1", 0.5, false); // outward down, into the gap
    const r = findPassages([floor, ceiling], ctx(1), { diagonal: 20 });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].kind).toBe("slot");
    expect(r.findings[0].width).toBeCloseTo(0.5);
    expect(r.findings[0].overlap).toBeCloseTo(10);
  });

  it("rejects a disk facing an annulus it never overlaps, even though their bounding intervals do", () => {
    const ring = (id: string, r0: number, r1: number, z: number, up: boolean): PassageFace => {
      const points: Vec3[] = [];
      const triangles: number[] = [];
      const n = 24;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * 2 * Math.PI;
        points.push([r0 * Math.cos(a), r0 * Math.sin(a), z], [r1 * Math.cos(a), r1 * Math.sin(a), z]);
      }
      for (let k = 0; k < n; k++) {
        const i = 2 * k, j = 2 * ((k + 1) % n);
        triangles.push(i, i + 1, j + 1, i, j + 1, j);
      }
      return { faceId: id, owner: "solid-0", surface: { kind: "plane", origin: [0, 0, z], normal: [0, 0, 1] }, sample: { point: [(r0 + r1) / 2, 0, z], normal: up ? [0, 0, 1] : [0, 0, -1] }, points, triangles };
    };
    const disk = ring("face-0", 0, 5, 10, true); // rod end, outward up
    const annulus = ring("face-1", 6, 10, 20, false); // tube bottom, outward down
    expect(findPassages([disk, annulus], ctx(2), { diagonal: 40 }).findings).toHaveLength(0);
    const cap = ring("face-2", 0, 8, 20, false); // a real facing disk
    expect(findPassages([disk, cap], ctx(2), { diagonal: 40 }).findings).toHaveLength(1);
  });

  it("skips a slab (outward normals pointing apart) and faces that don't overlap in plane", () => {
    const bottom = plane("face-0", 0, false);
    const top = plane("face-1", 3, true);
    expect(findPassages([bottom, top], ctx(1), { diagonal: 20 }).findings).toHaveLength(0);
    const floor = plane("face-2", 0, true);
    const shifted = plane("face-3", 0.5, false, 5, 30);
    expect(findPassages([floor, shifted], ctx(1), { diagonal: 60 }).findings).toHaveLength(0);
  });
});

describe("findPassages — requested size", () => {
  const floor = plane("face-0", 0, true);
  const ceiling = plane("face-1", 0.6, false, 5, 0, "solid-1");
  it("prefers a smaller Part size (face or owning solid) over the global size", () => {
    const byFace = findPassages([floor, ceiling], ctx(1, [["face-0", 0.1]]), { diagonal: 20 }).findings[0];
    expect(byFace.requestedSize).toBe(0.1);
    expect(byFace.sizeSource).toBe("part");
    expect(byFace.underResolved).toBe(false); // 6 cells across
    const bySolid = findPassages([floor, ceiling], ctx(1, [], [["solid-1", 0.2]]), { diagonal: 20 }).findings[0];
    expect(bySolid.requestedSize).toBe(0.2);
  });
  it("reports no cells-across when no size is set (Gmsh then sizes from geometry)", () => {
    const f = findPassages([floor, ceiling], ctx(null), { diagonal: 20 }).findings[0];
    expect(f.cellsAcross).toBeNull();
    expect(f.sizeSource).toBe("none");
    expect(f.underResolved).toBe(false);
  });
  it("sorts narrowest first and honours targetCells", () => {
    const g1 = [plane("face-0", 0, true), plane("face-1", 2, false)];
    const g2 = [plane("face-2", 10, true, 5, 40), plane("face-3", 10.5, false, 5, 40)];
    const r = findPassages([...g1, ...g2], ctx(1), { diagonal: 60, targetCells: 5 });
    expect(r.findings.map((f) => f.width)).toEqual([0.5, 2].map((w) => expect.closeTo(w, 9)));
    expect(r.findings[0].suggestedSize).toBeCloseTo(0.1);
  });
});
