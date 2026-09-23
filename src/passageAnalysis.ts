/**
 * Narrow-gap and passage resolution preflight — the PURE half (roadmap
 * "Narrow-gap and passage resolution preflight"). A mesh can have excellent
 * element quality and still fail to resolve a narrow channel with enough
 * cells across it; this measures the channel's WIDTH before meshing and
 * compares it with the size the mesher is actually asked to use there.
 *
 * Scope, stated plainly: two recognizable passage shapes, both from exact
 * analytic faces (the kernel half reads them via `faceSurfaceInfo`):
 *   - an ANNULAR gap between two coaxial cylindrical faces — width is the
 *     radial difference, and the faces must overlap AXIALLY (merely coaxial,
 *     disjoint cylinders are reported as rejected, never as a passage);
 *   - a SLOT between two parallel planar faces facing each other — width is
 *     the plane-to-plane distance, and the faces must overlap in BOTH in-plane
 *     directions.
 * A gap must be VOID: each face's OUTWARD normal (from the face-orientation-
 * aware tessellation winding) must point into the gap. Two faces bounding
 * solid material instead (a wall, a tube's own thickness) are wall
 * thickness, not a passage, and are skipped. General medial-axis thickness
 * analysis is a separate project; an area-equivalent diameter is never
 * reported as a width.
 */
export type Vec3 = [number, number, number];

/** One face, as the kernel half measures it. */
export interface PassageFace {
  faceId: string;
  /** Owning solid id (`solid-N`), or null for a free (sketch) face. */
  owner: string | null;
  surface:
    | { kind: "plane"; origin: Vec3; normal: Vec3 }
    | { kind: "cylinder"; radius: number; axisLocation: Vec3; axisDirection: Vec3 }
    | { kind: "other" };
  /** A point on the face and its OUTWARD normal there (orientation-aware). */
  sample: { point: Vec3; normal: Vec3 } | null;
  /** Tessellation vertices (for overlap projections). */
  points: Vec3[];
  /** Triangle vertex indices into `points` — enables a TRUE in-plane overlap
   * test for slots (bounding intervals alone accept a disk facing an annulus
   * it never overlaps). Optional: without it the interval test decides. */
  triangles?: ArrayLike<number>;
}

export interface PassageTolerances {
  /** Axes/normals count as parallel within this angle (degrees). Default 1. */
  angleDeg?: number;
  /** Absolute coaxial/coplanar tolerance (model units). Default 1e-4 × diagonal. */
  distance?: number;
}

export interface SizeContext {
  /** Global target size (mm); null when unbounded (Gmsh sizes from geometry). */
  sizeMax: number | null;
  /** Local sizes per face id and per owning solid id (Part meshSize / grading sizeAtWall). */
  faceSizes: Map<string, number>;
  solidSizes: Map<string, number>;
}

export interface PassageFinding {
  kind: "annular" | "slot";
  faceA: string;
  faceB: string;
  /** Measured gap width (model units). */
  width: number;
  /** Axial (annular) or smaller in-plane (slot) overlap length. */
  overlap: number;
  /** The size the mesher is asked to use at these faces (min of local and global), or null when unbounded. */
  requestedSize: number | null;
  sizeSource: "part" | "global" | "none";
  /** width / requestedSize — an ESTIMATE of cells across; a real mesh confirms it. */
  cellsAcross: number | null;
  /** width / targetCells — the local size that would give `targetCells` across. */
  suggestedSize: number;
  underResolved: boolean;
}

export interface PassageRejection {
  faceA: string;
  faceB: string;
  reason: string;
}

export interface PassageReport {
  findings: PassageFinding[];
  rejected: PassageRejection[];
  targetCells: number;
  facesAnalyzed: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = norm(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function interval(points: Vec3[], dir: Vec3): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const p of points) {
    const t = dot(p, dir);
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return [lo, hi];
}
const overlapOf = (a: [number, number], b: [number, number]) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]);

/** An in-plane orthonormal basis for normal n (deterministic helper vector). */
function planeBasis(n: Vec3): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(n, helper));
  return [u, cross(n, u)];
}

function requestedSizeFor(faces: PassageFace[], ctx: SizeContext): { size: number | null; source: PassageFinding["sizeSource"] } {
  let local = Infinity;
  for (const f of faces) {
    const s = ctx.faceSizes.get(f.faceId);
    if (s !== undefined) local = Math.min(local, s);
    if (f.owner) {
      const o = ctx.solidSizes.get(f.owner);
      if (o !== undefined) local = Math.min(local, o);
    }
  }
  const global = ctx.sizeMax;
  if (local < Infinity && (global === null || local <= global)) return { size: local, source: "part" };
  if (global !== null) return { size: global, source: "global" };
  return { size: null, source: "none" };
}

/** Does any triangle centroid of `a`, projected into (u, v), fall inside a
 * projected triangle of `b`? */
function facesOverlapInPlane(a: PassageFace, b: PassageFace, u: Vec3, v: Vec3): boolean {
  const proj = (p: Vec3): [number, number] => [dot(p, u), dot(p, v)];
  const bt = b.triangles!;
  const bTris: Array<[[number, number], [number, number], [number, number]]> = [];
  for (let t = 0; t + 2 < bt.length; t += 3) bTris.push([proj(b.points[bt[t]]), proj(b.points[bt[t + 1]]), proj(b.points[bt[t + 2]])]);
  const at = a.triangles!;
  for (let t = 0; t + 2 < at.length; t += 3) {
    const p0 = a.points[at[t]], p1 = a.points[at[t + 1]], p2 = a.points[at[t + 2]];
    const c = proj([(p0[0] + p1[0] + p2[0]) / 3, (p0[1] + p1[1] + p2[1]) / 3, (p0[2] + p1[2] + p2[2]) / 3]);
    for (const [x, y, z] of bTris) if (inTriangle(c, x, y, z)) return true;
  }
  return false;
}

function inTriangle(p: [number, number], a: [number, number], b: [number, number], c: [number, number]): boolean {
  const s = (p1: [number, number], p2: [number, number], p3: [number, number]) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

export function findPassages(
  faces: PassageFace[],
  ctx: SizeContext,
  options: { targetCells?: number; tolerances?: PassageTolerances; diagonal: number; maxFindings?: number }
): PassageReport {
  const targetCells = options.targetCells ?? 3;
  const cosTol = Math.cos(((options.tolerances?.angleDeg ?? 1) * Math.PI) / 180);
  const distTol = options.tolerances?.distance ?? Math.max(1e-9, options.diagonal * 1e-4);
  const minWidth = Math.max(distTol, options.diagonal * 1e-6);
  const findings: PassageFinding[] = [];
  const rejected: PassageRejection[] = [];

  const make = (kind: PassageFinding["kind"], a: PassageFace, b: PassageFace, width: number, overlap: number): PassageFinding => {
    const { size, source } = requestedSizeFor([a, b], ctx);
    const cellsAcross = size ? width / size : null;
    return {
      kind,
      faceA: a.faceId,
      faceB: b.faceId,
      width,
      overlap,
      requestedSize: size,
      sizeSource: source,
      cellsAcross,
      suggestedSize: width / targetCells,
      underResolved: cellsAcross !== null && cellsAcross < targetCells,
    };
  };

  const cyls = faces.filter((f) => f.surface.kind === "cylinder" && f.sample);
  for (let i = 0; i < cyls.length; i++)
    for (let j = i + 1; j < cyls.length; j++) {
      const A = cyls[i], B = cyls[j];
      const ca = A.surface as Extract<PassageFace["surface"], { kind: "cylinder" }>;
      const cb = B.surface as Extract<PassageFace["surface"], { kind: "cylinder" }>;
      const ua = unit(ca.axisDirection), ub = unit(cb.axisDirection);
      if (Math.abs(dot(ua, ub)) < cosTol) continue;
      // Coaxial: B's axis point lies on A's axis line.
      const d = sub(cb.axisLocation, ca.axisLocation);
      if (norm(sub(d, scale(ua, dot(d, ua)))) > distTol) continue;
      const width = Math.abs(ca.radius - cb.radius);
      if (width < minWidth) continue; // the same cylinder split into patches
      const overlap = overlapOf(interval(A.points, ua), interval(B.points, ua));
      const [inner, outer] = ca.radius < cb.radius ? [A, B] : [B, A];
      const radialOut = (f: PassageFace, c: typeof ca) => {
        const p = f.sample!.point;
        const rel = sub(p, c.axisLocation);
        const radial = unit(sub(rel, scale(ua, dot(rel, ua))));
        return dot(f.sample!.normal, radial);
      };
      const innerSurf = inner.surface as typeof ca, outerSurf = outer.surface as typeof ca;
      const isVoid = radialOut(inner, innerSurf) > 0 && radialOut(outer, outerSurf) < 0;
      if (!isVoid) continue; // material between them: wall thickness, not a passage
      if (overlap <= distTol) {
        rejected.push({ faceA: A.faceId, faceB: B.faceId, reason: "coaxial cylinders with no axial overlap — not a passage" });
        continue;
      }
      findings.push(make("annular", A, B, width, overlap));
    }

  const planes = faces.filter((f) => f.surface.kind === "plane" && f.sample);
  for (let i = 0; i < planes.length; i++)
    for (let j = i + 1; j < planes.length; j++) {
      const A = planes[i], B = planes[j];
      const na = unit(A.sample!.normal), nb = unit(B.sample!.normal);
      if (dot(na, nb) > -cosTol) continue; // must face each other (antiparallel outward normals)
      const pa = (A.surface as { origin: Vec3 }).origin;
      const pb = (B.surface as { origin: Vec3 }).origin;
      const width = dot(sub(pb, pa), na); // > 0 when B lies on A's outward side, i.e. across a void
      if (width < minWidth) continue;
      const [u, v] = planeBasis(na);
      const ou = overlapOf(interval(A.points, u), interval(B.points, u));
      const ov = overlapOf(interval(A.points, v), interval(B.points, v));
      if (ou <= distTol || ov <= distTol) continue; // parallel but not opposite each other
      // Intervals overlapping is necessary, not sufficient: a disk and an
      // annulus around it share intervals yet never face each other.
      if (A.triangles && B.triangles && !facesOverlapInPlane(A, B, u, v) && !facesOverlapInPlane(B, A, u, v)) continue;
      findings.push(make("slot", A, B, width, Math.min(ou, ov)));
    }

  findings.sort((a, b) => a.width - b.width);
  const maxFindings = options.maxFindings ?? 50;
  return { findings: findings.slice(0, maxFindings), rejected, targetCells, facesAnalyzed: faces.length };
}
