/**
 * Draft and undercut facts along a pull direction (roadmap "Draft and
 * undercut analysis"). Pure and vscode/OCCT/DOM-free: it reads a welded
 * triangle mesh (plus optional per-triangle entity ids), so the same function
 * serves the MCP tool and the panel, and `three-mesh-bvh` stays webview-only
 * (rays go through `triangleRay.ts`, as in `printability.ts`).
 *
 * Conventions:
 * - Draft δ = asin(n·pull) for the body's outward unit normal n. 0° is a wall
 *   parallel to the pull; positive means the face tilts TOWARD the pull (it
 *   releases when the tool moves along +pull); negative means it tilts away.
 *   Faces within `capToleranceDeg` of perpendicular to the pull are cap /
 *   parting faces and are neither draft nor undercut facts.
 * - `twoSided: true` measures each face against its own release direction
 *   (+pull for n·pull ≥ 0, −pull otherwise: a mould parted at the silhouette),
 *   so only shadowing can fail; the default one-sided mode reports faces that
 *   tilt away from +pull as negative draft.
 * - Undercut = a sampled point just off a wall face whose ray along the face's
 *   release direction meets the part again. Sampled, so a small shadowed
 *   sliver can be missed; the sample count and any cap are reported.
 * - Facts only: the thresholds are the caller's; there is no pass/fail.
 */
import { connectedComponents, edgeKey } from "./meshComponents";
import { bodyFlips, triangleFacts, UP_VECTORS, type Axis } from "./printability";
import { buildTriangleGrid, castRay } from "./triangleRay";

export interface DraftMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface DraftOptions {
  /** Pull direction: an axis name (`+Z`…) or a vector (normalised). Default +Z. */
  pull?: Axis | readonly [number, number, number];
  /** A wall whose smallest draft is below this lacks draft (`zeroDraft`); one-sided, below its negative is `negativeDraft`. Default 1°. */
  minDraftDeg?: number;
  /** Faces within this of perpendicular to the pull are caps. Default 5°. */
  capToleranceDeg?: number;
  twoSided?: boolean;
  /** Cap on undercut rays across all wall faces (default 2000, 0 skips the undercut test). */
  maxSamples?: number;
  /** Entity id per triangle (`face-N`); absent = coplanar facets are found from the mesh (`facet-N`). */
  faceIds?: readonly string[];
  /** Cap on faces listed per category (default 50, worst first). */
  maxFaces?: number;
}

export interface DraftFace {
  id: string;
  triangles: number;
  area: number;
  minDraftDeg: number;
  maxDraftDeg: number;
  /** Fraction of this face's sampled points shadowed along its release direction (absent when not sampled). */
  shadowedFraction?: number;
}

export interface DraftReport {
  pull: [number, number, number];
  twoSided: boolean;
  minDraftDeg: number;
  capToleranceDeg: number;
  faceCount: number;
  capFaceCount: number;
  /** Walls whose smallest draft is below minDraftDeg (and not negative beyond it). */
  zeroDraft: DraftFace[];
  /** One-sided only: walls tilted away from the pull by more than minDraftDeg. */
  negativeDraft: DraftFace[];
  undercut: DraftFace[];
  counts: { zeroDraft: number; negativeDraft: number; undercut: number };
  /** Smallest / largest wall draft over all non-cap faces (null when there are none). */
  minWallDraftDeg: number | null;
  maxWallDraftDeg: number | null;
  /** Area of the silhouette along the pull of each closed body, summed (mesh units²). */
  projectedArea: number;
  sampling: { requested: number; used: number; capped: boolean; note: string };
  truncated: boolean;
  warnings: string[];
}

export const DEFAULT_MIN_DRAFT_DEG = 1;
export const DEFAULT_CAP_TOLERANCE_DEG = 5;
export const DEFAULT_DRAFT_SAMPLES = 2000;
const DEFAULT_MAX_FACES = 50;
const RAD = Math.PI / 180;

export function resolvePull(pull: DraftOptions["pull"]): [number, number, number] {
  let v: readonly number[];
  if (pull === undefined) v = UP_VECTORS["+Z"];
  else if (typeof pull === "string") {
    if (!(pull in UP_VECTORS)) throw new Error(`pull must be one of ${Object.keys(UP_VECTORS).join(", ")} or a [x,y,z] vector (got ${JSON.stringify(pull)})`);
    v = UP_VECTORS[pull];
  } else v = pull;
  if (v.length !== 3 || !v.every((n) => Number.isFinite(n))) throw new Error("pull must be three finite numbers");
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-12) throw new Error("pull must be a non-zero vector");
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** Coplanar facets: edge-adjacent triangles whose unit normals agree within ~1°. */
function coplanarFacets(mesh: DraftMesh, normals: Array<[number, number, number] | null>): string[] {
  const nTri = Math.floor(mesh.indices.length / 3);
  const edgeTris = new Map<string, number[]>();
  for (let t = 0; t < nTri; t++)
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(mesh.indices[t * 3 + k], mesh.indices[t * 3 + ((k + 1) % 3)]);
      const list = edgeTris.get(key);
      if (list) list.push(t);
      else edgeTris.set(key, [t]);
    }
  const ids = new Array<string>(nTri).fill("");
  let next = 0;
  const cosTol = Math.cos(RAD);
  for (let s = 0; s < nTri; s++) {
    if (ids[s] || !normals[s]) continue;
    const id = `facet-${next++}`;
    const stack = [s];
    ids[s] = id;
    while (stack.length) {
      const t = stack.pop()!;
      const nt = normals[t]!;
      for (let k = 0; k < 3; k++) {
        for (const o of edgeTris.get(edgeKey(mesh.indices[t * 3 + k], mesh.indices[t * 3 + ((k + 1) % 3)])) ?? []) {
          const no = normals[o];
          if (ids[o] || !no) continue;
          if (nt[0] * no[0] + nt[1] * no[1] + nt[2] * no[2] >= cosTol) {
            ids[o] = id;
            stack.push(o);
          }
        }
      }
    }
  }
  return ids;
}

export function analyzeDraft(mesh: DraftMesh, options: DraftOptions = {}): DraftReport {
  const warnings: string[] = [];
  const pull = resolvePull(options.pull);
  const minDraft = options.minDraftDeg ?? DEFAULT_MIN_DRAFT_DEG;
  const capTol = options.capToleranceDeg ?? DEFAULT_CAP_TOLERANCE_DEG;
  if (!(Number.isFinite(minDraft) && minDraft >= 0 && minDraft < 90)) throw new Error(`minDraftDeg must be between 0 and 90 (got ${minDraft})`);
  if (!(Number.isFinite(capTol) && capTol >= 0 && capTol < 45)) throw new Error(`capToleranceDeg must be between 0 and 45 (got ${capTol})`);
  const requested = options.maxSamples ?? DEFAULT_DRAFT_SAMPLES;
  if (!(Number.isInteger(requested) && requested >= 0)) throw new Error(`maxSamples must be a non-negative integer (got ${requested})`);
  const maxFaces = options.maxFaces ?? DEFAULT_MAX_FACES;
  const twoSided = options.twoSided === true;
  const nTri = Math.floor(mesh.indices.length / 3);
  if (options.faceIds && options.faceIds.length !== nTri) throw new Error(`faceIds has ${options.faceIds.length} entries for ${nTri} triangles`);

  const bodies = connectedComponents(mesh.indices);
  const flips = bodyFlips(mesh, bodies);
  const tris = new Array<ReturnType<typeof triangleFacts>>(nTri).fill(null);
  bodies.forEach((body, bi) => {
    for (const t of body) tris[t] = triangleFacts(mesh, t, flips[bi]);
  });
  const ids = options.faceIds ?? coplanarFacets(mesh, tris.map((f) => (f ? f.n : null)));

  // Per-triangle draft and cap classification.
  const sinCap = Math.cos(capTol * RAD); // |n·pull| above this is a cap
  const draft = new Float64Array(nTri).fill(NaN);
  const isCap = new Uint8Array(nTri);
  let projectedArea = 0;
  for (let t = 0; t < nTri; t++) {
    const f = tris[t];
    if (!f) continue;
    const s = Math.max(-1, Math.min(1, f.n[0] * pull[0] + f.n[1] * pull[1] + f.n[2] * pull[2]));
    projectedArea += (Math.abs(s) * f.area) / 2;
    draft[t] = Math.asin(twoSided ? Math.abs(s) : s) / RAD;
    if (Math.abs(s) >= sinCap) isCap[t] = 1;
  }

  // Undercut sampling: area-weighted low-discrepancy picks over wall triangles.
  const wall: number[] = [];
  let total = 0;
  const cum: number[] = [];
  for (let t = 0; t < nTri; t++) {
    const f = tris[t];
    if (!f || isCap[t]) continue;
    if (!twoSided && draft[t] < 0) continue; // already a negative-draft fact; its release side is the other half
    wall.push(t);
    total += f.area;
    cum.push(total);
  }
  const shadowed = new Map<string, { hit: number; n: number }>();
  const used = requested > 0 && wall.length > 0 ? requested : 0;
  if (used > 0) {
    const grid = buildTriangleGrid(mesh.positions, mesh.indices);
    let diag = 0;
    {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < mesh.positions.length; i += 3)
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], mesh.positions[i + a]);
          max[a] = Math.max(max[a], mesh.positions[i + a]);
        }
      diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    }
    const eps = Math.max(1e-6, 1e-5 * diag);
    for (let s = 0; s < used; s++) {
      const target = ((s + 0.5) / used) * total;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      const t = wall[lo];
      const f = tris[t]!;
      let r1 = halton(s, 2), r2 = halton(s, 3);
      if (r1 + r2 > 1) {
        r1 = 1 - r1;
        r2 = 1 - r2;
      }
      const a = mesh.indices[t * 3] * 3, b = mesh.indices[t * 3 + 1] * 3, c = mesh.indices[t * 3 + 2] * 3;
      const w0 = 1 - r1 - r2;
      const p = [0, 1, 2].map((k) => w0 * mesh.positions[a + k] + r1 * mesh.positions[b + k] + r2 * mesh.positions[c + k]);
      const sign = twoSided && f.n[0] * pull[0] + f.n[1] * pull[1] + f.n[2] * pull[2] < 0 ? -1 : 1;
      const dir = [pull[0] * sign, pull[1] * sign, pull[2] * sign];
      // Start just off the surface (outward), so a vertical wall's own plane is not the first hit.
      const origin = [p[0] + f.n[0] * eps, p[1] + f.n[1] * eps, p[2] + f.n[2] * eps];
      const d = castRay(grid, origin, dir);
      const rec = shadowed.get(ids[t]) ?? { hit: 0, n: 0 };
      rec.n++;
      if (d !== null) rec.hit++;
      shadowed.set(ids[t], rec);
    }
  }

  // Aggregate per face.
  interface Acc { triangles: number; area: number; min: number; max: number; wall: boolean }
  const acc = new Map<string, Acc>();
  for (let t = 0; t < nTri; t++) {
    const f = tris[t];
    if (!f) continue;
    const id = ids[t];
    const a = acc.get(id) ?? { triangles: 0, area: 0, min: Infinity, max: -Infinity, wall: false };
    a.triangles++;
    a.area += f.area;
    a.min = Math.min(a.min, draft[t]);
    a.max = Math.max(a.max, draft[t]);
    if (!isCap[t]) a.wall = true;
    acc.set(id, a);
  }
  const zeroDraft: DraftFace[] = [], negativeDraft: DraftFace[] = [], undercut: DraftFace[] = [];
  let capFaceCount = 0;
  let minWall = Infinity, maxWall = -Infinity;
  for (const [id, a] of acc) {
    if (!a.wall) {
      capFaceCount++;
      continue;
    }
    minWall = Math.min(minWall, a.min);
    maxWall = Math.max(maxWall, a.max);
    const face: DraftFace = { id, triangles: a.triangles, area: a.area, minDraftDeg: a.min, maxDraftDeg: a.max };
    const sh = shadowed.get(id);
    if (sh && sh.n > 0) face.shadowedFraction = sh.hit / sh.n;
    if (!twoSided && a.min < -minDraft) negativeDraft.push(face);
    else if (a.min < minDraft) zeroDraft.push(face);
    if (face.shadowedFraction !== undefined && face.shadowedFraction > 0) undercut.push(face);
  }
  const byDraft = (x: DraftFace, y: DraftFace) => x.minDraftDeg - y.minDraftDeg || x.id.localeCompare(y.id);
  const counts = { zeroDraft: zeroDraft.length, negativeDraft: negativeDraft.length, undercut: undercut.length };
  zeroDraft.sort(byDraft);
  negativeDraft.sort(byDraft);
  undercut.sort((x, y) => (y.shadowedFraction ?? 0) - (x.shadowedFraction ?? 0) || x.id.localeCompare(y.id));
  const truncated = counts.zeroDraft > maxFaces || counts.negativeDraft > maxFaces || counts.undercut > maxFaces;
  if (truncated) warnings.push(`Face lists are capped at ${maxFaces} each (worst first); the true totals are in \`counts\`.`);
  if (requested === 0) warnings.push("maxSamples is 0 — the undercut test was skipped.");
  const capped = used > 0 && wall.length > 0 && used < wall.length;
  return {
    pull,
    twoSided,
    minDraftDeg: minDraft,
    capToleranceDeg: capTol,
    faceCount: acc.size,
    capFaceCount,
    zeroDraft: zeroDraft.slice(0, maxFaces),
    negativeDraft: negativeDraft.slice(0, maxFaces),
    undercut: undercut.slice(0, maxFaces),
    counts,
    minWallDraftDeg: minWall === Infinity ? null : minWall,
    maxWallDraftDeg: maxWall === -Infinity ? null : maxWall,
    projectedArea,
    sampling: {
      requested,
      used,
      capped,
      note: `${used} rays from area-weighted points just off the wall faces, along each face's release direction; a shadowed sliver smaller than the sample spacing can be missed.`,
    },
    truncated,
    warnings,
  };
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
