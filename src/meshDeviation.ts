/**
 * CAD-to-mesh deviation map — the PURE core (roadmap "CAD-to-mesh deviation
 * map"). Element quality says nothing about whether a well-shaped mesh
 * flattened a fillet, bridged a gap or dropped a small face; this measures
 * GEOMETRIC fidelity between a reference surface and a mesh boundary, in both
 * directions:
 *   - FORWARD, reference → mesh: a missing or flattened region shows up here;
 *   - REVERSE, mesh → reference: an extraneous surface shows up here.
 *
 * What it is, stated plainly: SAMPLED, not a certified maximum. Samples are
 * area-weighted and deterministic (cumulative-area stratification + an R2
 * low-discrepancy sequence inside each triangle), distances are exact
 * point-to-triangle distances (`triangleDistance.ts`), and the reference is
 * whatever triangulation the caller passes — the B-rep host uses the CAD's
 * own fine tessellation, an explicitly approximate stand-in for the exact
 * surface. Raw statistics are always reported; the "filtered" set only drops
 * Tukey outliers and says how many — a missing region is never hidden,
 * because per-face failures and coverage are computed from the RAW samples.
 */
import { buildTriangleGrid3D, nearestOnGrid, type TriangleGrid, type Vec3 } from "./triangleDistance";

export interface DeviationSurface {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** Optional per-triangle region id (e.g. the CAD face-N each reference triangle came from). */
  triangleRegion?: ArrayLike<number>;
  regionNames?: readonly string[];
}

export interface DeviationStats {
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  samples: number;
}

export interface DeviationReport {
  tolerance: number;
  forward: DeviationStats & { withinTolerance: number; coverage: number };
  reverse: DeviationStats & { withinTolerance: number };
  /** Forward stats with Tukey outliers (> Q3 + 3·IQR) excluded, and how many were. */
  filtered: DeviationStats & { excluded: number };
  /** Reference regions whose forward samples exceed the tolerance (worst first). */
  regionFailures: Array<{ region: string; maxDeviation: number; fractionOver: number; samples: number }>;
  /** Reverse samples beyond tolerance, as a fraction — extraneous mesh surface. */
  extraneousFraction: number;
}

export interface DeviationOptions {
  tolerance: number;
  /** Target sample count per direction (default 20 000, capped at 200 000). */
  samples?: number;
  /** Return per-corner distances for the mesh triangles (the overlay). */
  perCorner?: boolean;
}

export interface DeviationResult {
  report: DeviationReport;
  /** Per mesh-triangle corner (3 per triangle): distance to the reference. */
  cornerDistances?: Float32Array;
}

const G = 1.32471795724474602596; // plastic number (R2 sequence)
const A1 = 1 / G, A2 = 1 / (G * G);

function triArea(p: ArrayLike<number>, i: number, j: number, k: number): number {
  const ux = p[j * 3] - p[i * 3], uy = p[j * 3 + 1] - p[i * 3 + 1], uz = p[j * 3 + 2] - p[i * 3 + 2];
  const vx = p[k * 3] - p[i * 3], vy = p[k * 3 + 1] - p[i * 3 + 1], vz = p[k * 3 + 2] - p[i * 3 + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/** Deterministic, area-weighted sample points: returns [points, triangle index per point]. */
export function sampleSurface(s: DeviationSurface, count: number): { points: Vec3[]; triangles: number[] } {
  const n = Math.floor(s.indices.length / 3);
  if (n === 0 || count <= 0) return { points: [], triangles: [] };
  const cum = new Float64Array(n);
  let total = 0;
  for (let t = 0; t < n; t++) {
    total += triArea(s.positions, s.indices[t * 3], s.indices[t * 3 + 1], s.indices[t * 3 + 2]);
    cum[t] = total;
  }
  if (!(total > 0)) return { points: [], triangles: [] };
  const points: Vec3[] = [];
  const triangles: number[] = [];
  let t = 0;
  for (let k = 0; k < count; k++) {
    const target = ((k + 0.5) / count) * total;
    while (t < n - 1 && cum[t] < target) t++;
    let r1 = (0.5 + A1 * (k + 1)) % 1;
    let r2 = (0.5 + A2 * (k + 1)) % 1;
    if (r1 + r2 > 1) {
      r1 = 1 - r1;
      r2 = 1 - r2;
    }
    const a = s.indices[t * 3] * 3, b = s.indices[t * 3 + 1] * 3, c = s.indices[t * 3 + 2] * 3;
    const w0 = 1 - r1 - r2;
    points.push([
      w0 * s.positions[a] + r1 * s.positions[b] + r2 * s.positions[c],
      w0 * s.positions[a + 1] + r1 * s.positions[b + 1] + r2 * s.positions[c + 1],
      w0 * s.positions[a + 2] + r1 * s.positions[b + 2] + r2 * s.positions[c + 2],
    ]);
    triangles.push(t);
  }
  return { points, triangles };
}

function statsOf(values: number[]): DeviationStats {
  if (values.length === 0) return { max: 0, mean: 0, p50: 0, p95: 0, p99: 0, samples: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  return {
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    samples: sorted.length,
  };
}

function distancesTo(grid: TriangleGrid, points: Vec3[]): number[] {
  const out: number[] = new Array(points.length);
  for (let i = 0; i < points.length; i++) out[i] = nearestOnGrid(grid, points[i])?.distance ?? Infinity;
  return out;
}

export function measureDeviation(reference: DeviationSurface, mesh: DeviationSurface, options: DeviationOptions): DeviationResult {
  const tolerance = options.tolerance;
  if (!(Number.isFinite(tolerance) && tolerance > 0)) throw new Error(`tolerance must be a positive number (got ${tolerance})`);
  const count = Math.min(200_000, Math.max(100, Math.floor(options.samples ?? 20_000)));
  const refGrid = buildTriangleGrid3D(reference.positions, reference.indices);
  const meshGrid = buildTriangleGrid3D(mesh.positions, mesh.indices);
  if (refGrid.triangleCount === 0 || meshGrid.triangleCount === 0) {
    throw new Error("Both the reference and the mesh need at least one triangle to compare.");
  }

  const fwd = sampleSurface(reference, count);
  const fwdD = distancesTo(meshGrid, fwd.points);
  const rev = sampleSurface(mesh, count);
  const revD = distancesTo(refGrid, rev.points);

  // Per-region failures from the RAW forward samples.
  const regionFailures: DeviationReport["regionFailures"] = [];
  if (reference.triangleRegion) {
    const agg = new Map<number, { max: number; over: number; n: number }>();
    for (let i = 0; i < fwd.points.length; i++) {
      const region = reference.triangleRegion[fwd.triangles[i]];
      const a = agg.get(region) ?? { max: 0, over: 0, n: 0 };
      a.max = Math.max(a.max, fwdD[i]);
      if (fwdD[i] > tolerance) a.over++;
      a.n++;
      agg.set(region, a);
    }
    for (const [region, a] of agg)
      if (a.max > tolerance)
        regionFailures.push({ region: reference.regionNames?.[region] ?? String(region), maxDeviation: a.max, fractionOver: a.over / a.n, samples: a.n });
    regionFailures.sort((x, y) => y.maxDeviation - x.maxDeviation);
  }

  const sortedF = [...fwdD].sort((a, b) => a - b);
  const q1 = sortedF[Math.floor(sortedF.length * 0.25)] ?? 0;
  const q3 = sortedF[Math.floor(sortedF.length * 0.75)] ?? 0;
  const fence = q3 + 3 * (q3 - q1);
  const kept = fwdD.filter((d) => d <= fence);
  const within = (arr: number[]) => arr.filter((d) => d <= tolerance).length;

  let cornerDistances: Float32Array | undefined;
  if (options.perCorner) {
    const n = Math.floor(mesh.indices.length / 3);
    cornerDistances = new Float32Array(n * 3);
    const cache = new Map<number, number>();
    for (let c = 0; c < n * 3; c++) {
      const v = mesh.indices[c];
      let d = cache.get(v);
      if (d === undefined) {
        d = nearestOnGrid(refGrid, [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]])?.distance ?? 0;
        cache.set(v, d);
      }
      cornerDistances[c] = d;
    }
  }

  return {
    report: {
      tolerance,
      forward: { ...statsOf(fwdD), withinTolerance: within(fwdD), coverage: fwdD.length ? within(fwdD) / fwdD.length : 0 },
      reverse: { ...statsOf(revD), withinTolerance: within(revD) },
      filtered: { ...statsOf(kept), excluded: fwdD.length - kept.length },
      regionFailures,
      extraneousFraction: revD.length ? (revD.length - within(revD)) / revD.length : 0,
    },
    cornerDistances,
  };
}

/** ASCII PLY of the mesh triangles with a per-vertex `distance` property —
 * readable by ParaView/MeshLab (an unknown property is ignored by plain
 * readers, including this repo's own `plyParser.ts`). Vertices are written
 * per corner so each carries its own value. */
export function deviationPly(mesh: DeviationSurface, cornerDistances: Float32Array): string {
  const n = Math.floor(mesh.indices.length / 3);
  const lines: string[] = [
    "ply",
    "format ascii 1.0",
    "comment CAD-Preview mesh deviation (distance to the reference surface, model units)",
    `element vertex ${n * 3}`,
    "property float x",
    "property float y",
    "property float z",
    "property float distance",
    `element face ${n}`,
    "property list uchar int vertex_indices",
    "end_header",
  ];
  for (let c = 0; c < n * 3; c++) {
    const v = mesh.indices[c] * 3;
    lines.push(`${mesh.positions[v]} ${mesh.positions[v + 1]} ${mesh.positions[v + 2]} ${cornerDistances[c]}`);
  }
  for (let t = 0; t < n; t++) lines.push(`3 ${t * 3} ${t * 3 + 1} ${t * 3 + 2}`);
  return lines.join("\n") + "\n";
}
