/**
 * Classify a solid's face inventory into a candidate primitive (roadmap item 8
 * Phase 2).
 *
 * Pure — takes the `SurfaceParams` Phase 1 already reads off each face and
 * produces a candidate, or `null`. No OCCT, no tessellation, so it is
 * unit-testable headless.
 *
 * **This never returns a verdict.** A candidate is a hypothesis whose quality
 * the caller judges from the fit residual the report publishes beside it —
 * exactly the framing `checkMeshHealth` uses for `requiredTolerance` and
 * `compare_models` uses for `centreDistance`/`volumeDeltaPct`. A candidate
 * with a large residual is a solid that *resembles* a cylinder, not one that
 * is one; a mis-recognition that silently became a verdict would feed
 * `get_mass_properties`/`measure_exact` confidently-wrong numbers, which is
 * the failure mode this phase exists to avoid.
 *
 * Prefers `null` over a guess: anything that does not match a signature
 * exactly reports no candidate, and the caller still gets the raw inventory,
 * which is useful on its own.
 */

import type { SurfaceParams, SurfaceType } from "./entityFacts";
import type { Primitive, Vec3 } from "./primitiveSdf";
import { normalize } from "./primitiveSdf";

/** One face's contribution to a solid's inventory. */
export interface FaceEntry {
  faceId: string;
  surfaceType: SurfaceType;
  params: SurfaceParams | null;
}

/** How nearly parallel two unit vectors must be to count as the same axis. */
const AXIS_TOL = 1e-6;
/** Relative tolerance for "these two radii are the same". */
const RADIUS_REL_TOL = 1e-6;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Parallel OR antiparallel — a face's normal may point either way. */
const sameAxis = (a: Vec3, b: Vec3): boolean => Math.abs(Math.abs(dot(a, b)) - 1) < AXIS_TOL;
const perpendicular = (a: Vec3, b: Vec3): boolean => Math.abs(dot(a, b)) < AXIS_TOL;

/** Counts by surface type, with every key present so the shape is stable. */
export function inventoryOf(faces: readonly FaceEntry[]): Record<SurfaceType, number> {
  const out: Record<SurfaceType, number> = { plane: 0, cylinder: 0, cone: 0, sphere: 0, torus: 0, other: 0 };
  for (const f of faces) out[f.surfaceType] += 1;
  return out;
}

type Planar = { origin: Vec3; normal: Vec3 };

function planes(faces: readonly FaceEntry[]): Planar[] {
  const out: Planar[] = [];
  for (const f of faces) {
    if (f.params?.kind === "plane") {
      const n = normalize(f.params.normal);
      if (n) out.push({ origin: f.params.origin, normal: n });
    }
  }
  return out;
}

function only<T extends SurfaceParams["kind"]>(
  faces: readonly FaceEntry[],
  kind: T
): Extract<SurfaceParams, { kind: T }> | null {
  const hits = faces.filter((f) => f.params?.kind === kind);
  return hits.length === 1 ? (hits[0].params as Extract<SurfaceParams, { kind: T }>) : null;
}

/**
 * The candidate primitive for a solid, or `null` when nothing matches
 * exactly.
 *
 * Signatures, all requiring an exact face count so a filleted or chamfered
 * variant does not silently pass as the plain primitive (its extra faces make
 * the count wrong, which is the honest answer — the shape is no longer that
 * primitive, however close it looks).
 */
export function recognizePrimitive(faces: readonly FaceEntry[]): Primitive | null {
  const inv = inventoryOf(faces);
  const n = faces.length;

  // Sphere: a single spherical face and nothing else.
  if (n === 1 && inv.sphere === 1) {
    const s = only(faces, "sphere");
    return s ? { kind: "sphere", center: s.center, radius: s.radius } : null;
  }

  // Torus: a single toroidal face and nothing else.
  if (n === 1 && inv.torus === 1) {
    const t = only(faces, "torus");
    const axis = t && normalize(t.axisDirection);
    return t && axis
      ? { kind: "torus", center: t.axisLocation, axis, majorRadius: t.majorRadius, minorRadius: t.minorRadius }
      : null;
  }

  // Cylinder: one lateral face plus two caps perpendicular to its axis.
  if (n === 3 && inv.cylinder === 1 && inv.plane === 2) {
    const c = only(faces, "cylinder");
    const axis = c && normalize(c.axisDirection);
    if (!c || !axis) return null;
    const caps = planes(faces);
    if (caps.length !== 2 || !caps.every((p) => sameAxis(p.normal, axis))) return null;
    // Axial coordinates of the two cap planes; the base is the lower one.
    const t0 = dot(sub(caps[0].origin, c.axisLocation), axis);
    const t1 = dot(sub(caps[1].origin, c.axisLocation), axis);
    const height = Math.abs(t1 - t0);
    if (height < 1e-12) return null;
    const base = add(c.axisLocation, scale(axis, Math.min(t0, t1)));
    return { kind: "cylinder", base, axis, radius: c.radius, height };
  }

  // Cone: one lateral face plus one or two caps perpendicular to its axis.
  // A sharp-tipped cone has a single cap; a truncated one has two.
  if ((n === 2 || n === 3) && inv.cone === 1 && inv.plane === n - 1) {
    const c = only(faces, "cone");
    const axis = c && normalize(c.axisDirection);
    if (!c || !axis) return null;
    const caps = planes(faces);
    if (caps.length !== n - 1 || !caps.every((p) => sameAxis(p.normal, axis))) return null;
    const half = (c.semiAngleDeg * Math.PI) / 180;
    // Axial coordinate of the apex, and of each cap, relative to axisLocation.
    const tApex = dot(sub(c.apex, c.axisLocation), axis);
    const ts = caps.map((p) => dot(sub(p.origin, c.axisLocation), axis));
    const tLo = Math.min(...ts, ...(caps.length === 1 ? [tApex] : []));
    const tHi = Math.max(...ts, ...(caps.length === 1 ? [tApex] : []));
    const height = tHi - tLo;
    if (height < 1e-12) return null;
    // Radius at an axial coordinate t: refRadius is measured at t=0, growing
    // along +axis when semiAngle is positive.
    const radiusAt = (t: number) => c.refRadius + t * Math.tan(half);
    const r1 = radiusAt(tLo);
    const r2 = radiusAt(tHi);
    if (!(r1 >= -1e-9 && r2 >= -1e-9)) return null;
    const base = add(c.axisLocation, scale(axis, tLo));
    return { kind: "cone", base, axis, radius1: Math.max(r1, 0), radius2: Math.max(r2, 0), height };
  }

  // Box: six planar faces forming three mutually perpendicular antiparallel
  // pairs. Deliberately does NOT assume world-axis alignment.
  if (n === 6 && inv.plane === 6) return recognizeBox(planes(faces));

  return null;
}

function recognizeBox(ps: Planar[]): Primitive | null {
  if (ps.length !== 6) return null;

  // Group the six normals into three axes.
  const axes: Vec3[] = [];
  for (const p of ps) {
    if (!axes.some((a) => sameAxis(a, p.normal))) axes.push(p.normal);
  }
  if (axes.length !== 3) return null;
  // Mutually perpendicular, or it is not a box.
  if (!perpendicular(axes[0], axes[1]) || !perpendicular(axes[1], axes[2]) || !perpendicular(axes[0], axes[2])) {
    return null;
  }

  const size: number[] = [];
  const mid: number[] = [];
  for (const a of axes) {
    const members = ps.filter((p) => sameAxis(p.normal, a));
    if (members.length !== 2) return null; // exactly one pair per axis
    const t0 = dot(members[0].origin, a);
    const t1 = dot(members[1].origin, a);
    const extent = Math.abs(t1 - t0);
    if (extent < 1e-12) return null;
    size.push(extent);
    mid.push((t0 + t1) / 2);
  }

  // Right-handed frame, so the box's own axes are a proper rotation.
  const zAxis = normalize(cross(axes[0], axes[1]));
  if (!zAxis) return null;
  const flip = dot(zAxis, axes[2]) < 0;
  const z: Vec3 = flip ? [-axes[2][0], -axes[2][1], -axes[2][2]] : axes[2];

  // Centre: the point whose projection onto each axis is that axis's midpoint.
  const center = add(add(scale(axes[0], mid[0]), scale(axes[1], mid[1])), scale(z, flip ? -mid[2] : mid[2]));

  return {
    kind: "box",
    center,
    size: [size[0], size[1], size[2]],
    xAxis: axes[0],
    yAxis: axes[1],
    zAxis: z,
  };
}

/** True when `a` and `b` are the same radius within a relative tolerance. */
export function sameRadius(a: number, b: number): boolean {
  const scaleRef = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scaleRef < RADIUS_REL_TOL;
}
