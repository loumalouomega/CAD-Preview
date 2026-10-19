/**
 * Planar-facet merging for mesh → B-rep promotion (roadmap "Planar-facet
 * merging before mesh → B-rep promotion"): groups a welded mesh's near-coplanar
 * triangles into facets and traces each facet's boundary into one outer loop
 * plus hole loops, so promotion can build ONE planar face per facet instead of
 * one per triangle. Pure and WASM-free; `meshHeal.ts` turns the loops into OCCT
 * faces and sews them.
 *
 * Measured (`scripts/probe/examples/promote-merge-facets.ts`): a 19 200-triangle
 * faceted cube promotes in about 0.6–1.0 s instead of 49.9 s with the same
 * volume, a 270 000-triangle one in 5.5 s (the per-triangle path refuses
 * anything above 50 000), and a 32-sided prism or a plate with a through-hole
 * match their analytic volumes to ~1e-15 relative.
 *
 * **Safe by construction, not by the angle alone.** A facet is only merged when
 * it is genuinely flat: every vertex of it must lie within `planarityTolerance`
 * of the facet's best-fit plane, and its boundary must trace to exactly one
 * counter-clockwise outer loop plus clockwise holes, each a simple cycle. Anything
 * else — a curved patch that the angle tolerance happened to chain together, a
 * pinch point, a second island — is returned in `singles` and keeps its
 * per-triangle faces. So merging can only ever change how many faces are built,
 * never silently flatten a curved surface. (The probe's control: a tolerance at
 * or above the 11.25° dihedral of a 32-sided prism merges its sides into
 * non-planar chains, and without this check sewing fails to close.)
 */

import type { WeldedMesh } from "./meshComponents";

/** The default angle (degrees) between a triangle and its facet's seed normal. */
export const DEFAULT_MERGE_ANGLE_DEG = 1;
/** The widest angle a caller may ask for; the planarity check is the real guard. */
export const MAX_MERGE_ANGLE_DEG = 10;
/**
 * The most triangles `mergeFacets` accepts. Measured up to 270 000 (5.5 s end to
 * end); the merged face count is what the sewing ceiling then applies to.
 */
export const MAX_MERGE_TRIANGLES = 300_000;

export interface MergeFacetsOptions {
  /** Maximum angle, in degrees, between a triangle's normal and its facet's seed normal. */
  angleToleranceDeg: number;
}

/**
 * Validates a caller value into {@link MergeFacetsOptions}, or `undefined` when
 * merging is off: `true` means the default angle, an object may carry an
 * `angleToleranceDeg` in `(0, MAX_MERGE_ANGLE_DEG]`; `false`/`null`/absent is off.
 * An out-of-range or non-numeric angle falls back to the default rather than
 * silently disabling a requested merge.
 */
export function validateMergeFacets(raw: unknown): MergeFacetsOptions | undefined {
  if (raw === true) return { angleToleranceDeg: DEFAULT_MERGE_ANGLE_DEG };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const a = (raw as { angleToleranceDeg?: unknown }).angleToleranceDeg;
  const ok = typeof a === "number" && Number.isFinite(a) && a > 0 && a <= MAX_MERGE_ANGLE_DEG;
  return { angleToleranceDeg: ok ? a : DEFAULT_MERGE_ANGLE_DEG };
}

type Vec3 = [number, number, number];

export interface MergedFacet {
  /** The facet's triangles (mesh triangle indices). */
  triangles: number[];
  /** Area-weighted unit normal of the facet. */
  normal: Vec3;
  /** The outer loop: welded vertex indices, counter-clockwise about `normal`. */
  outer: number[];
  /** Hole loops: welded vertex indices, clockwise about `normal`. */
  holes: number[][];
}

export interface FacetMergePlan {
  /** Facets to build as one planar face each. */
  merged: MergedFacet[];
  /** Triangles to keep as individual faces: single-triangle facets and every facet that failed a safety check. */
  singles: number[];
  /** How many multi-triangle facets were rejected by a safety check and sent to `singles`. */
  rejectedFacets: number;
}

function triangleNormals(mesh: WeldedMesh, triangles: number[]): Map<number, Vec3> {
  const out = new Map<number, Vec3>();
  const p = mesh.positions;
  for (const t of triangles) {
    const a = mesh.indices[t * 3] * 3, b = mesh.indices[t * 3 + 1] * 3, c = mesh.indices[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    // Unnormalised cross product: its length is twice the area, which is the weight a facet normal wants.
    out.set(t, [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
  }
  return out;
}

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
};

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Connected triangle groups where every member is within `cosTol` of the group's seed normal. */
function segmentFacets(mesh: WeldedMesh, triangles: number[], normals: Map<number, Vec3>, angleDeg: number): number[][] {
  const cosTol = Math.cos((angleDeg * Math.PI) / 180);
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const edgeTris = new Map<string, number[]>();
  for (const t of triangles) {
    for (let k = 0; k < 3; k++) {
      const e = key(mesh.indices[t * 3 + k], mesh.indices[t * 3 + ((k + 1) % 3)]);
      const l = edgeTris.get(e);
      if (l) l.push(t);
      else edgeTris.set(e, [t]);
    }
  }
  const unitNormal = new Map<number, Vec3>();
  for (const t of triangles) unitNormal.set(t, unit(normals.get(t)!));
  const seen = new Set<number>();
  const facets: number[][] = [];
  for (const seed of triangles) {
    if (seen.has(seed)) continue;
    seen.add(seed);
    const seedNormal = unitNormal.get(seed)!;
    const group = [seed];
    const stack = [seed];
    while (stack.length) {
      const t = stack.pop()!;
      for (let k = 0; k < 3; k++) {
        for (const u of edgeTris.get(key(mesh.indices[t * 3 + k], mesh.indices[t * 3 + ((k + 1) % 3)])) ?? []) {
          if (seen.has(u) || dot(unitNormal.get(u)!, seedNormal) < cosTol) continue;
          seen.add(u);
          group.push(u);
          stack.push(u);
        }
      }
    }
    facets.push(group);
  }
  return facets;
}

/** Closed boundary loops (welded vertex indices) of a facet, traced along its triangles' own directed edges. */
function boundaryLoops(mesh: WeldedMesh, triangles: number[]): number[][] | null {
  const directed = new Set<string>();
  for (const t of triangles) {
    for (let k = 0; k < 3; k++) directed.add(`${mesh.indices[t * 3 + k]}>${mesh.indices[t * 3 + ((k + 1) % 3)]}`);
  }
  // A boundary edge is a directed edge whose reverse is not also in the facet.
  const next = new Map<number, number[]>();
  for (const e of directed) {
    const [a, b] = e.split(">").map(Number);
    if (directed.has(`${b}>${a}`)) continue;
    const l = next.get(a);
    if (l) l.push(b);
    else next.set(a, [b]);
  }
  const used = new Set<string>();
  const loops: number[][] = [];
  for (const [start, firsts] of next) {
    for (const first of firsts) {
      if (used.has(`${start}>${first}`)) continue;
      const loop = [start];
      let from = start;
      let to = first;
      for (;;) {
        used.add(`${from}>${to}`);
        if (to === start) break;
        loop.push(to);
        const candidate = (next.get(to) ?? []).find((c) => !used.has(`${to}>${c}`));
        if (candidate === undefined) return null; // an open chain: not a closed facet boundary
        from = to;
        to = candidate;
      }
      if (loop.length < 3) return null;
      loops.push(loop);
    }
  }
  return loops;
}

/** Signed area of a loop about `normal` (positive = counter-clockwise seen from the normal). */
function loopArea(mesh: WeldedMesh, loop: number[], normal: Vec3): number {
  const p = mesh.positions;
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] * 3, b = loop[(i + 1) % loop.length] * 3;
    sx += p[a + 1] * p[b + 2] - p[a + 2] * p[b + 1];
    sy += p[a + 2] * p[b] - p[a] * p[b + 2];
    sz += p[a] * p[b + 1] - p[a + 1] * p[b];
  }
  return 0.5 * (sx * normal[0] + sy * normal[1] + sz * normal[2]);
}

const isSimple = (loop: number[]): boolean => new Set(loop).size === loop.length;

/**
 * Plans the facet merge of one connected component.
 *
 * @param triangles the component's triangle indices
 * @param planarityTolerance the largest distance any facet vertex may sit from its best-fit plane
 */
export function planFacetMerge(mesh: WeldedMesh, triangles: number[], angleToleranceDeg: number, planarityTolerance: number): FacetMergePlan {
  const normals = triangleNormals(mesh, triangles);
  const merged: MergedFacet[] = [];
  const singles: number[] = [];
  let rejectedFacets = 0;
  for (const facet of segmentFacets(mesh, triangles, normals, angleToleranceDeg)) {
    if (facet.length === 1) {
      singles.push(facet[0]);
      continue;
    }
    const plan = planOneFacet(mesh, facet, normals, planarityTolerance);
    if (plan) merged.push(plan);
    else {
      rejectedFacets++;
      singles.push(...facet);
    }
  }
  return { merged, singles, rejectedFacets };
}

function planOneFacet(mesh: WeldedMesh, facet: number[], normals: Map<number, Vec3>, planarityTolerance: number): MergedFacet | null {
  let nx = 0, ny = 0, nz = 0;
  for (const t of facet) {
    const n = normals.get(t)!;
    nx += n[0]; ny += n[1]; nz += n[2];
  }
  const normal = unit([nx, ny, nz]);
  if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) return null;

  // Flatness: every vertex within `planarityTolerance` of the plane through the facet's centroid.
  const verts = new Set<number>();
  for (const t of facet) for (let k = 0; k < 3; k++) verts.add(mesh.indices[t * 3 + k]);
  const p = mesh.positions;
  let cx = 0, cy = 0, cz = 0;
  for (const v of verts) { cx += p[v * 3]; cy += p[v * 3 + 1]; cz += p[v * 3 + 2]; }
  cx /= verts.size; cy /= verts.size; cz /= verts.size;
  for (const v of verts) {
    const d = (p[v * 3] - cx) * normal[0] + (p[v * 3 + 1] - cy) * normal[1] + (p[v * 3 + 2] - cz) * normal[2];
    if (Math.abs(d) > planarityTolerance) return null;
  }

  const raw = boundaryLoops(mesh, facet);
  if (!raw || raw.length === 0 || !raw.every(isSimple)) return null;
  const loops = raw.map((loop) => ({ loop, area: loopArea(mesh, loop, normal) }));
  const outers = loops.filter((l) => l.area > 0).sort((a, b) => b.area - a.area);
  // Exactly one outer loop: a second counter-clockwise loop is a separate island (or a pinch) — not one face.
  if (outers.length !== 1) return null;
  const holes = loops.filter((l) => l.area < 0);
  if (loops.length !== 1 + holes.length) return null;
  return { triangles: facet, normal, outer: outers[0].loop, holes: holes.map((h) => h.loop) };
}
