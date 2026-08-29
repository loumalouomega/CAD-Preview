import { describe, expect, it } from "vitest";
import {
  fitMeshRegion,
  simplestOf,
  SIMPLEST_FIT_RESIDUAL_FRAC,
  FIT_SIMPLICITY_ORDER,
  type FitCandidate,
  type FitKind,
} from "./meshRegionFit";
import { weldedMeshToStlBytes } from "./meshComponents";

/** A unit cube as binary STL bytes, so this exercises the real parse path. */
function cubeStl(): Uint8Array {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ]);
  return weldedMeshToStlBytes({ positions, indices });
}

/** A tessellated sphere as binary STL bytes. */
function sphereStl(radius: number, centre: [number, number, number], seg = 24): Uint8Array {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const phi = (i / seg) * Math.PI;
    for (let j = 0; j <= seg; j++) {
      const theta = (j / seg) * Math.PI * 2;
      pos.push(
        centre[0] + radius * Math.sin(phi) * Math.cos(theta),
        centre[1] + radius * Math.sin(phi) * Math.sin(theta),
        centre[2] + radius * Math.cos(phi)
      );
    }
  }
  const at = (i: number, j: number) => i * (seg + 1) + j;
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      // Skip the degenerate pole triangles: at i=0 and i=seg every meridian
      // collapses to one point, so those "triangles" have zero area.
      if (i > 0) idx.push(at(i, j), at(i + 1, j), at(i + 1, j + 1));
      if (i < seg - 1) idx.push(at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  return weldedMeshToStlBytes({ positions: new Float32Array(pos), indices: new Uint32Array(idx) });
}

describe("fitMeshRegion — a flat region", () => {
  const fit = () => fitMeshRegion(cubeStl(), "stl", [0.5, 0.5, 5]);

  it("grows only the seeded face, stopping at the cube's edges", async () => {
    expect((await fit()).triangleCount).toBe(2);
  });

  it("fits a plane with a residual at zero", async () => {
    const plane = (await fit()).candidates.find((c) => c.kind === "plane")!;
    expect(plane).toBeDefined();
    expect(plane.residual!).toBeLessThan(1e-5);
  });

  it("reports its normal along the seeded face's axis", async () => {
    const plane = (await fit()).candidates.find((c) => c.kind === "plane")!;
    const n = (plane.primitive as { normal: [number, number, number] }).normal;
    expect(Math.abs(n[2])).toBeCloseTo(1, 6);
  });

  it("offers NO cylinder candidate — parallel normals determine no axis", async () => {
    const r = await fit();
    expect(r.candidates.find((c) => c.kind === "cylinder")).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/no cylinder fit/i);
  });

  it("names plane as simplest", async () => {
    expect((await fit()).simplest).toBe("plane");
  });

  it("offers NO sphere candidate either — Kasa is singular on coplanar points", async () => {
    // Worth pinning as a correctness property, not just an observation: an
    // algebraic sphere fit over coplanar points has rank-deficient normal
    // equations, and the failure mode to avoid is returning an ARBITRARY
    // enormous sphere that happens to have a tiny residual. Refusing is right.
    expect((await fit()).candidates.find((c) => c.kind === "sphere")).toBeUndefined();
  });

  it("publishes candidates simplest-first, and the rule used", async () => {
    const r = await fit();
    const order = r.candidates.map((c) => c.kind);
    const expected = FIT_SIMPLICITY_ORDER.filter((k) => order.includes(k));
    expect(order).toEqual(expected);
    expect(r.simplestRule).toContain("residualFrac");
  });
});

describe("fitMeshRegion — a curved region", () => {
  const fit = () => fitMeshRegion(sphereStl(5, [3, -4, 7]), "stl", [8, -4, 7]);

  it("grows across the tessellated curve rather than stopping at each facet", async () => {
    // The default gate is deliberately looser than meshFacets' 15° for this.
    expect((await fit()).triangleCount).toBeGreaterThan(100);
  });

  it("recovers the sphere's centre and radius", async () => {
    const sphere = (await fit()).candidates.find((c) => c.kind === "sphere")!;
    const p = sphere.primitive as { center: [number, number, number]; radius: number };
    expect(p.radius).toBeCloseTo(5, 2);
    expect(p.center[0]).toBeCloseTo(3, 2);
    expect(p.center[1]).toBeCloseTo(-4, 2);
    expect(p.center[2]).toBeCloseTo(7, 2);
  });

  it("does NOT name plane as simplest for a sphere", async () => {
    // The ordering prefers the simpler shape only at comparable quality — a
    // plane fitted to a whole sphere has a huge residual and must lose.
    const r = await fit();
    expect(r.simplest).not.toBe("plane");
  });
});

/** A tessellated cylinder's lateral surface (no caps), as binary STL bytes. */
function cylinderStl(radius: number, height: number, base: [number, number, number], seg = 48): Uint8Array {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= 1; i++) {
    for (let j = 0; j <= seg; j++) {
      const t = (j / seg) * Math.PI * 2;
      pos.push(base[0] + radius * Math.cos(t), base[1] + radius * Math.sin(t), base[2] + i * height);
    }
  }
  const at = (i: number, j: number) => i * (seg + 1) + j;
  for (let j = 0; j < seg; j++) {
    idx.push(at(0, j), at(1, j), at(1, j + 1));
    idx.push(at(0, j), at(1, j + 1), at(0, j + 1));
  }
  return weldedMeshToStlBytes({ positions: new Float32Array(pos), indices: new Uint32Array(idx) });
}

describe("fitMeshRegion — a cylindrical region", () => {
  const R = 4;
  const H = 9;
  const BASE: [number, number, number] = [2, -3, 5];
  const fit = () => fitMeshRegion(cylinderStl(R, H, BASE), "stl", [2 + R, -3, 5 + H / 2]);

  it("fits a cylinder with the right radius", async () => {
    const cyl = (await fit()).candidates.find((c) => c.kind === "cylinder")!;
    expect(cyl).toBeDefined();
    expect((cyl.primitive as { radius: number }).radius).toBeCloseTo(R, 3);
  });

  it("recovers the axis direction", async () => {
    const cyl = (await fit()).candidates.find((c) => c.kind === "cylinder")!;
    const a = (cyl.primitive as { axis: [number, number, number] }).axis;
    expect(Math.abs(a[2])).toBeCloseTo(1, 6);
  });

  it("CLIPS the infinite fitted axis to the region's own extent", async () => {
    // The fit itself is an infinite cylinder; Primitive's is bounded. Without
    // the clip this height would be arbitrary — and the RESIDUAL cannot catch
    // that, because a point on the lateral surface is at distance 0 from a
    // capped cylinder of any height. Only asserting the bounds does.
    const cyl = (await fit()).candidates.find((c) => c.kind === "cylinder")!;
    const p = cyl.primitive as { base: [number, number, number]; height: number };
    expect(p.height).toBeCloseTo(H, 3);
    expect(p.base[2]).toBeCloseTo(BASE[2], 3);
  });

  it("fits it far better than a plane does", async () => {
    const r = await fit();
    const cyl = r.candidates.find((c) => c.kind === "cylinder")!;
    const plane = r.candidates.find((c) => c.kind === "plane")!;
    expect(cyl.residual!).toBeLessThan(plane.residual! / 10);
  });
});

describe("simplestOf — the ordering rule", () => {
  const c = (kind: FitKind, residualFrac: number | null): FitCandidate => ({
    kind,
    // The rule reads only `kind` and `residualFrac`; the rest is filler.
    primitive: { kind: "sphere", center: [0, 0, 0], radius: 1 },
    residual: residualFrac,
    residualFrac,
  });

  it("prefers the SIMPLER shape when both fit well enough", () => {
    // The case this design exists for, and the one no fixture produces: a
    // sphere with a BETTER residual must still lose to a good-enough plane.
    // Choosing by residual alone would pick the sphere here.
    expect(simplestOf([c("plane", 1e-6), c("sphere", 1e-12)])).toBe("plane");
    expect(simplestOf([c("cylinder", 1e-6), c("sphere", 1e-12)])).toBe("cylinder");
  });

  it("skips a shape that does not fit well enough, however simple", () => {
    expect(simplestOf([c("plane", 0.5), c("cylinder", 1e-9)])).toBe("cylinder");
  });

  it("is independent of the order the candidates arrive in", () => {
    expect(simplestOf([c("sphere", 1e-12), c("plane", 1e-6)])).toBe("plane");
  });

  it("returns null when nothing fits, rather than the least-bad candidate", () => {
    expect(simplestOf([c("plane", 0.5), c("sphere", 0.4)])).toBeNull();
  });

  it("ignores a candidate whose residual could not be computed", () => {
    expect(simplestOf([c("plane", null), c("cylinder", 1e-9)])).toBe("cylinder");
  });

  it("uses a strict threshold", () => {
    expect(simplestOf([c("plane", SIMPLEST_FIT_RESIDUAL_FRAC)])).toBeNull();
  });
});

describe("fitMeshRegion — degenerate input", () => {
  it("reports no candidates and an explanatory warning for an empty mesh", async () => {
    const empty = weldedMeshToStlBytes({ positions: new Float32Array(), indices: new Uint32Array() });
    const r = await fitMeshRegion(empty, "stl", [0, 0, 0]);
    expect(r.candidates).toEqual([]);
    expect(r.simplest).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("warns when the region hit its cap, so a partial fit is never silent", async () => {
    const r = await fitMeshRegion(sphereStl(5, [0, 0, 0]), "stl", [5, 0, 0], { maxTriangles: 20 });
    expect(r.capped).toBe(true);
    expect(r.triangleCount).toBe(20);
    expect(r.warnings.join(" ")).toMatch(/cap/i);
  });
});
