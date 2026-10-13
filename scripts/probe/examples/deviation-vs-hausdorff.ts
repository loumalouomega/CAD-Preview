/**
 * Independent cross-check of the CAD-to-mesh deviation map (`measureDeviation`,
 * src/meshDeviation.ts) against meshio++'s `hausdorffDistance`.
 *
 *   npm run probe -- scripts/probe/examples/deviation-vs-hausdorff.ts
 *
 * `measureDeviation` is SAMPLED (area-weighted interior points, exact
 * point-to-triangle distances) and had no independent oracle: the only thing
 * that could catch a bug in its sampling, grid or direction handling was
 * itself. meshio++'s `hausdorffDistance` is a different implementation of the
 * same class of quantity — it samples vertices plus the centroids of an
 * `s*s` sub-triangle grid, and reports the two one-sided maxima.
 *
 * What is compared, and why those tolerances:
 *   - Both are LOWER bounds on the true two-sided Hausdorff distance, so for a
 *     case with an ANALYTIC answer each must be <= it (+ float noise). A value
 *     above it is a bug in that implementation, not sampling.
 *   - Where the worst point is a vertex or corner (the cube cases), meshio++
 *     samples vertices and must hit the analytic value; `measureDeviation`
 *     samples interior points only, so it approaches it from below and the
 *     probe asserts a sampling-justified lower margin rather than equality.
 *   - Direction mapping: with reference = A and mesh = B, `forward` is
 *     A -> B and `reverse` is B -> A. The symmetric value is the max of the
 *     two; `measureDeviation` never computes it, so it is derived here.
 *
 * Exits 1 on any violated bound. A disagreement is a finding: record it in
 * src/meshDeviation.ts's header rather than loosening a tolerance.
 */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";
import { measureDeviation, type DeviationSurface } from "../../../src/meshDeviation";
import { parseToWeldedMesh } from "../../../src/meshParse";
import { kernelVersions } from "../../../src/kernelVersions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = any;

function surface(bytes: Uint8Array): DeviationSurface {
  const w = parseToWeldedMesh(bytes, "stl");
  return { positions: w.positions, indices: w.indices };
}

function translated(s: DeviationSurface, d: [number, number, number]): DeviationSurface {
  const p = Float32Array.from(s.positions as ArrayLike<number>);
  for (let i = 0; i < p.length; i += 3) {
    p[i] += d[0];
    p[i + 1] += d[1];
    p[i + 2] += d[2];
  }
  return { positions: p, indices: s.indices };
}

function scaled(s: DeviationSurface, k: number): DeviationSurface {
  return { positions: Float32Array.from(s.positions as ArrayLike<number>, (v) => v * k), indices: s.indices };
}

/**
 * A thin needle attached to the cube's top face: a four-triangle pyramid with a
 * 0.2-unit base at z = 5.5 and its apex at (0, 0, 15). Its surface area is
 * ~1 unit^2 against the cube's 600, so an interior-point sampler sees it
 * rarely — while its apex is a VERTEX, which meshio++ always samples.
 */
function withNeedle(s: DeviationSurface): DeviationSurface {
  const base = Array.from(s.positions as ArrayLike<number>);
  const n = base.length / 3;
  base.push(-0.1, -0.1, 5.5, 0.1, -0.1, 5.5, 0, 0.1, 5.5, 0, 0, 15);
  const idx = Array.from(s.indices as ArrayLike<number>);
  idx.push(n, n + 1, n + 3, n + 1, n + 2, n + 3, n + 2, n, n + 3, n, n + 2, n + 1);
  return { positions: Float32Array.from(base), indices: Uint32Array.from(idx) };
}

function meshioMesh(s: DeviationSurface) {
  return {
    points: Float64Array.from(s.positions as ArrayLike<number>),
    dim: 3,
    cells: [{ type: "triangle", nodesPerCell: 3, data: Int32Array.from(s.indices as ArrayLike<number>) }],
  };
}

interface Row {
  name: string;
  /** Analytic two-sided Hausdorff distance, when one exists. */
  analytic?: number;
  ours: { aToB: number; bToA: number; symmetric: number };
  meshio: { aToB: number; bToA: number; symmetric: number };
}

function compare(m: Api, name: string, a: DeviationSurface, b: DeviationSurface, analytic?: number): Row {
  const r = measureDeviation(a, b, { tolerance: 1, samples: 200_000 }).report;
  const h = m.hausdorffDistance(meshioMesh(a), meshioMesh(b), 4);
  return {
    name,
    analytic,
    ours: { aToB: r.forward.max, bToA: r.reverse.max, symmetric: Math.max(r.forward.max, r.reverse.max) },
    meshio: { aToB: h.aToB, bToA: h.bToA, symmetric: h.distance },
  };
}

async function main(): Promise<void> {
  const m: Api = await getMeshio();
  const cube = surface(new Uint8Array(fs.readFileSync("examples/STL/cube.stl")));
  const sphere = surface(new Uint8Array(fs.readFileSync("examples/STL/large-sphere-100k.stl")));

  const rows: Row[] = [
    compare(m, "cube vs itself", cube, cube, 0),
    // Two 10-unit cubes offset by 0.3 along x: the worst point is a corner at
    // exactly 0.3 from the other surface, in both directions.
    compare(m, "cube vs cube +0.3x", cube, translated(cube, [0.3, 0, 0]), 0.3),
    // Concentric spheres r=10 and r=10.1 (the fixture's radius is exactly 10):
    // 0.1, less the tessellation sagitta of the inner one.
    compare(m, "sphere r10 vs r10.1", sphere, scaled(sphere, 1.01), 0.1),
    // Same sphere shifted: Hausdorff of identical spheres offset by d is d.
    compare(m, "sphere vs sphere +0.25x", sphere, translated(sphere, [0.25, 0, 0]), 0.25),
    // The documented weak spot of an interior-point sampler: the needle's apex
    // is 10 from the cube (apex (0,0,15) to the top face at z = 5). meshio++
    // samples vertices, so it must report exactly 10; measureDeviation can only
    // under-report. How much is the number this row exists to record.
    compare(m, "cube vs cube+needle", cube, withNeedle(cube), 10),
  ];

  const problems: string[] = [];
  for (const r of rows) {
    if (r.analytic !== undefined) {
      const slack = Math.max(1e-4, r.analytic * 1e-3);
      for (const [who, v] of [["measureDeviation", r.ours.symmetric], ["meshio++", r.meshio.symmetric]] as const) {
        if (v > r.analytic + slack) problems.push(`${r.name}: ${who} ${v} exceeds the analytic bound ${r.analytic}`);
      }
      // Sampling can only under-report: both must reach most of the answer.
      if (r.analytic > 0) {
        // The needle is the sampler's known weak spot: allow it a wider margin.
        const floor = r.name.includes("needle") ? 0.9 : 0.95;
        if (r.ours.symmetric < floor * r.analytic) problems.push(`${r.name}: measureDeviation ${r.ours.symmetric} < ${floor * 100}% of ${r.analytic}`);
        if (r.meshio.symmetric < 0.95 * r.analytic) problems.push(`${r.name}: meshio++ ${r.meshio.symmetric} < 95% of ${r.analytic}`);
      } else if (r.ours.symmetric > 1e-5 || r.meshio.symmetric > 1e-5) {
        problems.push(`${r.name}: identical surfaces must report ~0`);
      }
    }
  }
  console.log(JSON.stringify({ versions: kernelVersions(), rows, problems }, null, 2));
  if (problems.length) {
    console.error("deviation map and meshio++ Hausdorff disagree");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
