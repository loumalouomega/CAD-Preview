/**
 * Ray → entity picking, host-side, over the tessellation `loadBRep` already
 * produces.
 *
 * **Deliberately not routed through the webview**, though the roadmap framed it
 * as "a new message on an existing harness". `renderService.ts` calls
 * `loadBRep` in-process, so the host already holds the exact triangle soup the
 * webview would raycast — going through Chromium would buy nothing and cost a
 * browser launch per call, a `supported: false` degradation on every installed
 * `.vsix`, and a picking entry point on the interactive `Viewer` that only
 * headless code would ever use. The in-repo precedent is `silhouetteEdges.ts`,
 * which likewise does host-side geometry over this same tessellation rather
 * than asking the webview.
 *
 * Pure: no vscode, no OCCT, no THREE, no DOM. Unit-testable against a cube.
 */

export type Vec3 = [number, number, number];

export type PickEntityType = "volume" | "surface" | "line" | "point";

export interface RayHit {
  entityType: PickEntityType;
  entityId: string;
  /** The owning solid, for a surface hit. */
  groupId?: string;
  /** World-space hit point. */
  point: Vec3;
  /** Distance along the ray from its origin. */
  distance: number;
  /** Face normal at the hit, world-space — surface hits only. */
  normal?: Vec3;
}

/** The subset of `loadBRep`'s result this needs; kept structural so tests can
 * build fixtures without touching OCCT. */
export interface PickGeometry {
  groups: { id: string; faces: { faceId: string; buffers: { positions: Float32Array; indices: Uint32Array } }[] }[];
  edges: { edgeId: string; positions: Float32Array }[];
  points: { pointId: string; position: Vec3 }[];
}

export interface RayPickOptions {
  /**
   * Which kind of entity to report. `"volume"` resolves a face hit up to its
   * owning solid, mirroring `picking.ts`'s `resolvePick`. `"any"` tests faces,
   * edges and points together and reports whichever is nearest.
   */
  mode?: PickEntityType | "any";
  /** Restrict picking to these entity ids (and, for `"volume"`, group ids). */
  focus?: string[];
  /** Exclude these entity ids. */
  hide?: string[];
  /**
   * How near a ray must pass an edge or point to hit it, in model units.
   * Lines and vertices have no area, so they need a tolerance the way the
   * interactive viewer's `pickThreshold` does.
   */
  tolerance?: number;
}

/** Below this the ray direction is degenerate and nothing can be picked. */
const MIN_DIRECTION_LENGTH = 1e-12;
/** Möller–Trumbore parallel-ray epsilon. */
const EPSILON = 1e-9;

/**
 * The nearest entity along the ray, or `null`.
 *
 * `direction` need not be normalized; `distance` is always reported in model
 * units regardless.
 */
export function rayPick(geometry: PickGeometry, origin: Vec3, direction: Vec3, options: RayPickOptions = {}): RayHit | null {
  const dir = normalize(direction);
  if (dir === null) return null;

  const mode = options.mode ?? "any";
  const allow = makeFilter(options);
  const tolerance = options.tolerance ?? 0;

  let best: RayHit | null = null;
  const keep = (hit: RayHit | null): void => {
    if (hit && (best === null || hit.distance < best.distance)) best = hit;
  };

  if (mode === "any" || mode === "surface" || mode === "volume") {
    keep(pickFaces(geometry, origin, dir, mode, allow));
  }
  if (mode === "any" || mode === "line") {
    keep(pickEdges(geometry, origin, dir, allow, tolerance));
  }
  if (mode === "any" || mode === "point") {
    keep(pickPoints(geometry, origin, dir, allow, tolerance));
  }
  return best;
}

/**
 * `focus` (when non-empty) whitelists; `hide` always blacklists. A surface is
 * testable if either its own id or its owning solid's id passes, so focusing a
 * solid keeps its faces.
 */
function makeFilter(options: RayPickOptions): (entityId: string, groupId?: string) => boolean {
  const focus = new Set(options.focus ?? []);
  const hide = new Set(options.hide ?? []);
  return (entityId, groupId) => {
    if (hide.has(entityId) || (groupId !== undefined && hide.has(groupId))) return false;
    if (focus.size === 0) return true;
    return focus.has(entityId) || (groupId !== undefined && focus.has(groupId));
  };
}

function pickFaces(
  geometry: PickGeometry,
  origin: Vec3,
  dir: Vec3,
  mode: PickEntityType | "any",
  allow: (entityId: string, groupId?: string) => boolean
): RayHit | null {
  let best: RayHit | null = null;
  for (const group of geometry.groups) {
    for (const face of group.faces) {
      if (!allow(face.faceId, group.id)) continue;
      const { positions, indices } = face.buffers;
      for (let i = 0; i + 2 < indices.length; i += 3) {
        const hit = intersectTriangle(origin, dir, positions, indices[i], indices[i + 1], indices[i + 2]);
        if (!hit) continue;
        if (best !== null && hit.distance >= best.distance) continue;
        best = {
          // `volume` resolves up to the owning solid, exactly as the
          // interactive `resolvePick` does for the same mode.
          entityType: mode === "volume" ? "volume" : "surface",
          entityId: mode === "volume" ? group.id : face.faceId,
          groupId: group.id,
          point: hit.point,
          distance: hit.distance,
          normal: hit.normal,
        };
      }
    }
  }
  return best;
}

/** Möller–Trumbore, double-sided: a CAD face may legitimately be hit from behind. */
function intersectTriangle(
  origin: Vec3,
  dir: Vec3,
  positions: Float32Array,
  ia: number,
  ib: number,
  ic: number
): { point: Vec3; distance: number; normal: Vec3 } | null {
  const a: Vec3 = [positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]];
  const b: Vec3 = [positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]];
  const c: Vec3 = [positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]];

  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const pvec = cross(dir, e2);
  const det = dot(e1, pvec);
  if (Math.abs(det) < EPSILON) return null; // ray parallel to the triangle

  const inv = 1 / det;
  const tvec = sub(origin, a);
  const u = dot(tvec, pvec) * inv;
  if (u < 0 || u > 1) return null;

  const qvec = cross(tvec, e1);
  const v = dot(dir, qvec) * inv;
  if (v < 0 || u + v > 1) return null;

  const distance = dot(e2, qvec) * inv;
  if (distance <= EPSILON) return null; // behind the origin

  const normal = normalize(cross(e1, e2)) ?? [0, 0, 0];
  return { point: add(origin, scale(dir, distance)), distance, normal };
}

function pickEdges(
  geometry: PickGeometry,
  origin: Vec3,
  dir: Vec3,
  allow: (entityId: string, groupId?: string) => boolean,
  tolerance: number
): RayHit | null {
  if (tolerance <= 0) return null; // a zero-width line can never be hit exactly
  let best: RayHit | null = null;
  for (const edge of geometry.edges) {
    if (!allow(edge.edgeId)) continue;
    const p = edge.positions;
    for (let i = 0; i + 5 < p.length; i += 3) {
      const s: Vec3 = [p[i], p[i + 1], p[i + 2]];
      const e: Vec3 = [p[i + 3], p[i + 4], p[i + 5]];
      const near = raySegmentDistance(origin, dir, s, e);
      if (!near || near.gap > tolerance) continue;
      if (best !== null && near.distance >= best.distance) continue;
      best = { entityType: "line", entityId: edge.edgeId, point: near.point, distance: near.distance };
    }
  }
  return best;
}

function pickPoints(
  geometry: PickGeometry,
  origin: Vec3,
  dir: Vec3,
  allow: (entityId: string, groupId?: string) => boolean,
  tolerance: number
): RayHit | null {
  if (tolerance <= 0) return null;
  let best: RayHit | null = null;
  for (const point of geometry.points) {
    if (!allow(point.pointId)) continue;
    const toPoint = sub(point.position, origin);
    const distance = dot(toPoint, dir);
    if (distance <= 0) continue; // behind the ray
    const closest = add(origin, scale(dir, distance));
    if (length(sub(point.position, closest)) > tolerance) continue;
    if (best !== null && distance >= best.distance) continue;
    best = { entityType: "point", entityId: point.pointId, point: [...point.position] as Vec3, distance };
  }
  return best;
}

/**
 * Closest approach between the ray and a segment.
 *
 * `gap` is how far apart they pass (compared against the tolerance); `distance`
 * is how far along the RAY that happens, so hits sort consistently against
 * triangle hits.
 */
function raySegmentDistance(
  origin: Vec3,
  dir: Vec3,
  segStart: Vec3,
  segEnd: Vec3
): { gap: number; distance: number; point: Vec3 } | null {
  const seg = sub(segEnd, segStart);
  const segLen = length(seg);
  if (segLen < MIN_DIRECTION_LENGTH) return null;
  const segDir = scale(seg, 1 / segLen);

  const w0 = sub(origin, segStart);
  const a = dot(dir, dir); // 1 (dir is normalized)
  const b = dot(dir, segDir);
  const c = dot(segDir, segDir); // 1
  const d = dot(dir, w0);
  const e = dot(segDir, w0);

  const denom = a * c - b * b;
  let tRay: number;
  let tSeg: number;
  if (Math.abs(denom) < EPSILON) {
    // Parallel: clamp to the segment start.
    tRay = -d;
    tSeg = 0;
  } else {
    tRay = (b * e - c * d) / denom;
    tSeg = (a * e - b * d) / denom;
  }
  if (tRay <= 0) return null; // behind the origin
  tSeg = Math.min(segLen, Math.max(0, tSeg));

  const onRay = add(origin, scale(dir, tRay));
  const onSeg = add(segStart, scale(segDir, tSeg));
  return { gap: length(sub(onRay, onSeg)), distance: tRay, point: onSeg };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

function normalize(v: Vec3): Vec3 | null {
  const len = length(v);
  if (!Number.isFinite(len) || len < MIN_DIRECTION_LENGTH) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}
