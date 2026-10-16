/**
 * Printability facts — pure (no THREE, no WASM, no vscode), Node-testable.
 *
 * FACTS ONLY (see `verdictConventions`): closure and body count, overhang
 * area, sampled wall thickness, a support-volume UPPER BOUND and build-plate
 * fit, measured over a welded triangle mesh. Nothing here says "printable";
 * a process-limits row only adds counts to compare against, and every rule
 * the analysis cannot measure is listed in `notChecked` rather than passed.
 *
 * Conventions:
 * - `up` is the build direction (away from the plate); a triangle is an
 *   OVERHANG when its outward normal makes an angle with straight-down small
 *   enough that its surface is inclined more than `overhangLimitDeg` from
 *   vertical: `n·down > sin(limit)`. A face exactly at the limit is not an
 *   overhang. A flat downward face resting on the plate is plate contact, not
 *   an overhang.
 * - Wall thickness is SAMPLED: deterministic area-weighted points on the
 *   surface, a ray inward along the negated normal, the distance to the next
 *   surface. It is an estimate at the sampling resolution, never a minimum
 *   certificate; a thin feature smaller than the sample spacing can be missed.
 * - Winding: a body's normals are flipped when its signed volume is negative.
 *   An open body has no meaningful sign, so its wall figures are labelled.
 */
import { boundsOfTriangles, connectedComponents, type Vec3Bounds } from "./meshComponents";
import { analyzeMeshTopology } from "./meshTopology";
import { buildTriangleGrid, castRay } from "./triangleRay";

export interface PrintMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface ProcessLimits {
  name: string;
  /** Minimum wall thickness (mm) the process is rated for. */
  minWallMm?: number;
  /** Largest overhang angle from vertical (degrees) printable without support. */
  maxOverhangDeg?: number;
  /** Where the numbers came from — never empty. */
  source: string;
}

export interface BuildPlate {
  x: number;
  y: number;
  z: number;
}

export interface PrintabilityOptions {
  /** Overhang limit from vertical, degrees. Default: the process limit, else 45. */
  overhangLimitDeg?: number;
  /** Cap on wall-thickness sample rays across all bodies. Default 2000. */
  maxSamples?: number;
  plate?: BuildPlate;
  process?: ProcessLimits;
}

export type Axis = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";

export const UP_VECTORS: Readonly<Record<Axis, readonly [number, number, number]>> = {
  "+X": [1, 0, 0],
  "-X": [-1, 0, 0],
  "+Y": [0, 1, 0],
  "-Y": [0, -1, 0],
  "+Z": [0, 0, 1],
  "-Z": [0, 0, -1],
};
export const AXES = Object.keys(UP_VECTORS) as Axis[];

export interface WallStats {
  /** Rays cast. */
  samples: number;
  /** Rays that left the body without hitting a surface (open or non-manifold). */
  noHit: number;
  min: number | null;
  p5: number | null;
  median: number | null;
  /** Samples thinner than the process `minWallMm`, when a process was given. */
  belowMinWall?: number;
}

export interface BodyFacts {
  index: number;
  triangles: number;
  closed: boolean;
  freeEdges: number;
  nonManifoldEdges: number;
  /** Signed-volume magnitude (mm³), meaningful when `closed`. */
  volume: number;
  bounds: Vec3Bounds | null;
  wall: WallStats;
}

export interface OrientationFacts {
  up: Axis;
  /** Area (mm²) of surface needing support at this orientation. */
  overhangArea: number;
  /** Area of flat downward faces resting on the plate (not an overhang). */
  plateContactArea: number;
  overhangTriangles: number;
  /** Σ projected-overhang-area × height above the plate: a loose UPPER BOUND on support volume (mm³) — ignores the model itself standing under an overhang. */
  supportVolumeUpperBound: number;
  buildHeight: number;
  /** Extents along the two axes perpendicular to `up`. */
  footprint: [number, number];
  /** Present when a plate was given; the plate may be turned about the vertical. */
  fitsPlate?: boolean;
}

export interface NotChecked {
  rule: string;
  checked: false;
  reason: string;
}

export interface PrintabilityReport {
  triangles: number;
  vertices: number;
  bodyCount: number;
  bodies: BodyFacts[];
  /** The whole model's bounding box. */
  bounds: Vec3Bounds | null;
  unitsSuspect: { suspect: boolean; diagonal: number; reason?: string };
  overhangLimitDeg: number;
  orientations: OrientationFacts[];
  sampling: { requested: number; used: number; capped: boolean; note: string };
  process?: ProcessLimits;
  plate?: BuildPlate;
  notChecked: NotChecked[];
  warnings: string[];
}

export const DEFAULT_OVERHANG_LIMIT_DEG = 45;
export const DEFAULT_MAX_SAMPLES = 2000;

/** Rules this analysis cannot measure — reported, never passed. */
export const NOT_CHECKED: ReadonlyArray<NotChecked> = [
  { rule: "minimum hole / feature size", checked: false, reason: "needs feature recognition, not just wall rays" },
  { rule: "bridge span (unsupported horizontal spans)", checked: false, reason: "span length between supports is not measured" },
  { rule: "trapped powder / resin (enclosed voids, drain holes)", checked: false, reason: "enclosed cavities are not detected" },
  { rule: "warping, shrinkage and thermal effects", checked: false, reason: "needs a process simulation" },
  { rule: "surface finish and layer-line visibility per orientation", checked: false, reason: "not a geometric fact of the mesh" },
];

interface Tri {
  /** Unit outward normal (after the body's winding fix). */
  n: [number, number, number];
  area: number;
  /** Centroid. */
  c: [number, number, number];
}

function triangleFacts(mesh: PrintMesh, t: number, flip: boolean): Tri | null {
  const { positions: p, indices: i } = mesh;
  const a = i[t * 3] * 3, b = i[t * 3 + 1] * 3, c = i[t * 3 + 2] * 3;
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-18) return null; // degenerate
  const s = (flip ? -1 : 1) / len;
  nx *= s; ny *= s; nz *= s;
  return {
    n: [nx, ny, nz],
    area: len / 2,
    c: [(p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3],
  };
}

/** Signed volume of the triangles (positive = outward winding). */
function signedVolume(mesh: PrintMesh, triangles: number[]): number {
  const { positions: p, indices: i } = mesh;
  let sum = 0;
  for (const t of triangles) {
    const a = i[t * 3] * 3, b = i[t * 3 + 1] * 3, c = i[t * 3 + 2] * 3;
    sum +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) +
      p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return sum / 6;
}


/**
 * Which bodies' stored winding is inverted. A negative signed volume means
 * either an inside-out mesh (flip it) or a CAVITY shell of a solid with a
 * void, whose stored normals already point out of the material (keep it). A
 * negative body whose bounds lie inside another body's bounds is taken as a
 * cavity; anything else negative is inverted.
 */
function bodyFlips(mesh: PrintMesh, bodies: number[][]): boolean[] {
  const vols = bodies.map((b) => signedVolume(mesh, b));
  const bnds = bodies.map((b) => boundsOfTriangles(mesh.positions, mesh.indices, b));
  const inside = (a: Vec3Bounds, b: Vec3Bounds) =>
    [0, 1, 2].every((k) => a.min[k] >= b.min[k] - 1e-9 && a.max[k] <= b.max[k] + 1e-9);
  return bodies.map((_, i) => {
    if (vols[i] >= 0) return false;
    const mine = bnds[i];
    if (!mine) return true;
    const cavity = bodies.some((_, j) => j !== i && vols[j] > 0 && bnds[j] && inside(mine, bnds[j]!));
    return !cavity;
  });
}

function halton(index: number, base: number): number {
  let f = 1, r = 0, i = index + 1;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Wall thickness stats for one body by inward ray casting from deterministic surface samples. */
function wallForBody(
  mesh: PrintMesh,
  grid: ReturnType<typeof buildTriangleGrid>,
  triangles: number[],
  tris: Array<Tri | null>,
  samples: number,
  diag: number,
  minWallMm: number | undefined
): WallStats {
  const live = triangles.filter((t) => tris[t] !== null);
  if (live.length === 0 || samples <= 0) return { samples: 0, noHit: 0, min: null, p5: null, median: null };
  // The grid holds EVERY body: a ray starts inside the material, so the next surface it meets is the wall's far side even when that surface belongs to another shell (a cavity wall faces the outer shell).
  const cum: number[] = [];
  let total = 0;
  for (const t of live) {
    total += tris[t]!.area;
    cum.push(total);
  }
  const eps = Math.max(1e-6, 1e-5 * diag);
  const thick: number[] = [];
  let noHit = 0;
  for (let s = 0; s < samples; s++) {
    // Area-weighted triangle pick by a low-discrepancy stride, then Halton barycentrics.
    const target = ((s + 0.5) / samples) * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const t = live[lo];
    let r1 = halton(s, 2), r2 = halton(s, 3);
    if (r1 + r2 > 1) {
      r1 = 1 - r1;
      r2 = 1 - r2;
    }
    const a = mesh.indices[t * 3] * 3, b = mesh.indices[t * 3 + 1] * 3, c = mesh.indices[t * 3 + 2] * 3;
    const w0 = 1 - r1 - r2;
    const px = w0 * mesh.positions[a] + r1 * mesh.positions[b] + r2 * mesh.positions[c];
    const py = w0 * mesh.positions[a + 1] + r1 * mesh.positions[b + 1] + r2 * mesh.positions[c + 1];
    const pz = w0 * mesh.positions[a + 2] + r1 * mesh.positions[b + 2] + r2 * mesh.positions[c + 2];
    const n = tris[t]!.n;
    const d = castRay(grid, [px - n[0] * eps, py - n[1] * eps, pz - n[2] * eps], [-n[0], -n[1], -n[2]]);
    if (d === null) noHit++;
    else thick.push(d + eps);
  }
  thick.sort((x, y) => x - y);
  const stats: WallStats = {
    samples,
    noHit,
    min: thick.length ? thick[0] : null,
    p5: percentile(thick, 0.05),
    median: percentile(thick, 0.5),
  };
  if (minWallMm !== undefined) stats.belowMinWall = thick.filter((x) => x < minWallMm - 1e-9).length;
  return stats;
}

/** Per-triangle overhang flags for one build direction (1 = needs support), after each body's winding fix. */
export function overhangFlags(mesh: PrintMesh, up: Axis, overhangLimitDeg = DEFAULT_OVERHANG_LIMIT_DEG): Uint8Array {
  const nTri = Math.floor(mesh.indices.length / 3);
  const flags = new Uint8Array(nTri);
  const bodies = connectedComponents(mesh.indices);
  const flips = bodyFlips(mesh, bodies);
  const u = UP_VECTORS[up];
  const sinLimit = Math.sin((overhangLimitDeg * Math.PI) / 180);
  let minH = Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3)
    minH = Math.min(minH, mesh.positions[i] * u[0] + mesh.positions[i + 1] * u[1] + mesh.positions[i + 2] * u[2]);
  const eps = 1e-6 * Math.max(1, Math.abs(minH));
  bodies.forEach((body, bi) => {
    const flip = flips[bi];
    for (const t of body) {
      const f = triangleFacts(mesh, t, flip);
      if (!f) continue;
      const down = -(f.n[0] * u[0] + f.n[1] * u[1] + f.n[2] * u[2]);
      if (down > sinLimit + 1e-9 && !(down > 1 - 1e-6 && heightOf(mesh, t, u) - minH < eps)) flags[t] = 1;
    }
  });
  return flags;
}

/** Highest vertex height of a triangle along `u` (a flat plate-contact face has all three at the minimum). */
function heightOf(mesh: PrintMesh, t: number, u: readonly number[]): number {
  let h = -Infinity;
  for (let k = 0; k < 3; k++) {
    const v = mesh.indices[t * 3 + k] * 3;
    h = Math.max(h, mesh.positions[v] * u[0] + mesh.positions[v + 1] * u[1] + mesh.positions[v + 2] * u[2]);
  }
  return h;
}

export function analyzePrintability(mesh: PrintMesh, options: PrintabilityOptions = {}): PrintabilityReport {
  const warnings: string[] = [];
  const nTri = Math.floor(mesh.indices.length / 3);
  const limit = options.overhangLimitDeg ?? options.process?.maxOverhangDeg ?? DEFAULT_OVERHANG_LIMIT_DEG;
  if (!(Number.isFinite(limit) && limit > 0 && limit < 90)) throw new Error(`overhangLimitDeg must be between 0 and 90 (got ${limit})`);
  const requested = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  if (!(Number.isInteger(requested) && requested >= 0)) throw new Error(`maxSamples must be a non-negative integer (got ${requested})`);

  const all = Array.from({ length: nTri }, (_, t) => t);
  const bounds = boundsOfTriangles(mesh.positions, mesh.indices, all) ?? null;
  const diag = bounds ? Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) : 0;
  const unitsSuspect: PrintabilityReport["unitsSuspect"] = { suspect: false, diagonal: diag };
  if (bounds && diag < 1) {
    unitsSuspect.suspect = true;
    unitsSuspect.reason = `bounding-box diagonal ${diag.toPrecision(3)} mm is under 1 mm — the model may be in metres or inches`;
  } else if (bounds && diag > 10000) {
    unitsSuspect.suspect = true;
    unitsSuspect.reason = `bounding-box diagonal ${diag.toPrecision(3)} mm exceeds 10 m — the model may be in micrometres`;
  }

  const bodyTris = connectedComponents(mesh.indices);
  const tris: Array<Tri | null> = new Array(nTri).fill(null);
  const bodyArea: number[] = [];
  const flipOf = bodyFlips(mesh, bodyTris);
  for (const [bi, body] of bodyTris.entries()) {
    const flip = flipOf[bi];
    let area = 0;
    for (const t of body) {
      const f = triangleFacts(mesh, t, flip);
      tris[t] = f;
      if (f) area += f.area;
    }
    bodyArea.push(area);
  }

  const grid = buildTriangleGrid(mesh.positions, mesh.indices);

  // Sample budget: proportional to area, at least 16 per body, never more than requested overall.
  const totalArea = bodyArea.reduce((s, a) => s + a, 0);
  let used = 0;
  const budgets = bodyArea.map((a) => {
    if (requested === 0 || totalArea === 0) return 0;
    return Math.max(16, Math.round((a / totalArea) * requested));
  });
  const budgetSum = budgets.reduce((s, b) => s + b, 0);
  const capped = requested > 0 && budgetSum > requested;
  if (capped) {
    warnings.push(`${bodyTris.length} bodies need more than ${requested} wall-thickness samples at the 16-per-body floor — the cap was exceeded to keep every body measured.`);
  }

  const bodies: BodyFacts[] = bodyTris.map((triangles, index) => {
    const topo = analyzeMeshTopology(mesh.positions, mesh.indices, triangles);
    const closed = topo.freeEdgeCount === 0 && topo.nonManifoldEdgeCount === 0;
    const wall = wallForBody(mesh, grid, triangles, tris, budgets[index], diag, options.process?.minWallMm);
    used += wall.samples;
    return {
      index,
      triangles: triangles.length,
      closed,
      freeEdges: topo.freeEdgeCount,
      nonManifoldEdges: topo.nonManifoldEdgeCount,
      volume: Math.abs(signedVolume(mesh, triangles)),
      bounds: boundsOfTriangles(mesh.positions, mesh.indices, triangles) ?? null,
      wall,
    };
  });
  if (bodies.some((b) => !b.closed))
    warnings.push("At least one body is not a closed manifold: its volume and wall-thickness figures assume the winding as written and may be wrong.");

  const sinLimit = Math.sin((limit * Math.PI) / 180);
  const orientations: OrientationFacts[] = AXES.map((up) => {
    const u = UP_VECTORS[up];
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const h = mesh.positions[i] * u[0] + mesh.positions[i + 1] * u[1] + mesh.positions[i + 2] * u[2];
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    if (!Number.isFinite(minH)) {
      minH = 0;
      maxH = 0;
    }
    const eps = 1e-6 * Math.max(1, Math.abs(minH));
    let overhangArea = 0, plateContactArea = 0, overhangTriangles = 0, support = 0;
    for (let t = 0; t < nTri; t++) {
      const f = tris[t];
      if (!f) continue;
      const down = -(f.n[0] * u[0] + f.n[1] * u[1] + f.n[2] * u[2]);
      if (down <= sinLimit + 1e-9) continue;
      if (down > 1 - 1e-6 && heightOf(mesh, t, u) - minH < eps) {
        plateContactArea += f.area;
        continue;
      }
      overhangArea += f.area;
      overhangTriangles++;
      const h = f.c[0] * u[0] + f.c[1] * u[1] + f.c[2] * u[2] - minH;
      support += f.area * down * Math.max(0, h);
    }
    // Footprint: the two bounding-box extents perpendicular to `up`.
    const ext = bounds ? [0, 1, 2].map((a) => bounds.max[a] - bounds.min[a]) : [0, 0, 0];
    const ai = u[0] !== 0 ? 0 : u[1] !== 0 ? 1 : 2;
    const [fa, fb] = [0, 1, 2].filter((a) => a !== ai).map((a) => ext[a]) as [number, number];
    const out: OrientationFacts = {
      up,
      overhangArea,
      plateContactArea,
      overhangTriangles,
      supportVolumeUpperBound: support,
      buildHeight: maxH - minH,
      footprint: [fa, fb],
    };
    if (options.plate) {
      const { x, y, z } = options.plate;
      const fits = (a: number, b: number) => a <= x + 1e-9 && b <= y + 1e-9;
      out.fitsPlate = (fits(fa, fb) || fits(fb, fa)) && maxH - minH <= z + 1e-9;
    }
    return out;
  });

  return {
    triangles: nTri,
    vertices: Math.floor(mesh.positions.length / 3),
    bodyCount: bodies.length,
    bodies,
    bounds,
    unitsSuspect,
    overhangLimitDeg: limit,
    orientations,
    sampling: {
      requested,
      used,
      capped,
      note: "Wall thickness is sampled (deterministic area-weighted points, inward rays): an estimate at the sampling resolution, not a minimum certificate. Support volume is an upper bound.",
    },
    ...(options.process ? { process: options.process } : {}),
    ...(options.plate ? { plate: options.plate } : {}),
    notChecked: NOT_CHECKED.map((n) => ({ ...n })),
    warnings,
  };
}
