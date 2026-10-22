/**
 * Hole callouts for drawing sheets (roadmap "Hole callouts and centre lines
 * on drawing sheets") — the pure half. The OCCT-touching part only reads each
 * cylindrical face's analytic radius/axis (`faceSurfaceInfo`); everything
 * positional is derived here from the SAME welded tessellation the views are
 * drawn from, so a mark can never disagree with the outline beside it.
 *
 * Facts, not verdicts: `through` means the hole's axial extent spans the
 * model's extent along that axis (within a tolerance), a blind hole reports
 * its depth, and the nearest standard designation is `holeTable.ts`'s
 * measured-vs-table fact, never a tolerance class.
 */

import type { Vec3 } from "./editOps";
import { nearestHoleDesignation, HOLE_RADIUS_REL_TOL, HOLE_AXIS_PARALLEL_DEG } from "./holeTable";

/** One cylindrical face's analytic facts (`faceSurfaceInfo`'s cylinder branch). */
export interface CylinderFace {
  /** Global `face-N` id — matches `triangleFaceId`. */
  faceId: string;
  radius: number;
  axisLocation: Vec3;
  axisDirection: Vec3;
}

export interface DrawnHole {
  /** Centre of the hole on its axis, mid-extent. */
  centre: Vec3;
  /** Unit axis, sign-canonicalised. */
  axis: Vec3;
  radius: number;
  /** Axial extent as parameters along `axis` measured from `centre`'s origin plane. */
  tMin: number;
  tMax: number;
  depth: number;
  through: boolean;
  faceIds: string[];
}

export interface HoleCalloutGroup {
  radius: number;
  diameter: number;
  axis: Vec3;
  through: boolean;
  /** Depth of a blind group (the first hole's); `null` when through. */
  depth: number | null;
  holes: DrawnHole[];
  /** `4× Ø6.8 THRU` / `2× Ø5 ↧12` plus the nearest designation when close. */
  text: string;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/** Sign-canonical axis: first significant component positive. */
function canonicalAxis(a: Vec3): Vec3 {
  const n = norm(a);
  for (const c of n) {
    if (Math.abs(c) > 1e-9) return c < 0 ? [-n[0], -n[1], -n[2]] : n;
  }
  return n;
}

/** Shortest text for a length: `6.8`, `5`, `12.25`. */
export function trimLength(v: number): string {
  return String(Number(v.toFixed(3)));
}

/**
 * Extracts the concave (hole) cylinders from a welded, outward-wound mesh.
 * `triangleFaceId[t]` names triangle `t`'s `face-N`.
 *
 * Cylinder faces sharing a radius and an axis LINE are one hole (a drilled
 * hole is often two half-cylinders). A face whose triangle normals point away
 * from its axis is a boss/shaft and is skipped.
 */
export function extractHoles(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  triangleFaceId: ReadonlyArray<string>,
  cylinders: ReadonlyArray<CylinderFace>
): DrawnHole[] {
  if (cylinders.length === 0) return [];
  const byFace = new Map(cylinders.map((c) => [c.faceId, c]));
  interface Acc {
    cyl: CylinderFace;
    axis: Vec3;
    tMin: number;
    tMax: number;
    inward: number;
    outward: number;
  }
  const acc = new Map<string, Acc>();
  const triCount = Math.floor(indices.length / 3);
  const pt = (i: number): Vec3 => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  for (let t = 0; t < triCount; t++) {
    const cyl = byFace.get(triangleFaceId[t]);
    if (!cyl) continue;
    let a = acc.get(cyl.faceId);
    if (!a) {
      a = { cyl, axis: norm(cyl.axisDirection), tMin: Infinity, tMax: -Infinity, inward: 0, outward: 0 };
      acc.set(cyl.faceId, a);
    }
    const p0 = pt(indices[t * 3]);
    const p1 = pt(indices[t * 3 + 1]);
    const p2 = pt(indices[t * 3 + 2]);
    for (const p of [p0, p1, p2]) {
      const tt = dot(sub(p, cyl.axisLocation), a.axis);
      if (tt < a.tMin) a.tMin = tt;
      if (tt > a.tMax) a.tMax = tt;
    }
    // Face normal from winding vs the radial direction at the centroid.
    const e1 = sub(p1, p0);
    const e2 = sub(p2, p0);
    const n: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const c: Vec3 = [(p0[0] + p1[0] + p2[0]) / 3, (p0[1] + p1[1] + p2[1]) / 3, (p0[2] + p1[2] + p2[2]) / 3];
    const rel = sub(c, cyl.axisLocation);
    const along = dot(rel, a.axis);
    const radial: Vec3 = [rel[0] - a.axis[0] * along, rel[1] - a.axis[1] * along, rel[2] - a.axis[2] * along];
    if (dot(n, radial) < 0) a.inward++;
    else a.outward++;
  }

  // Concave faces only.
  const concave = [...acc.values()].filter((a) => a.inward > a.outward && Number.isFinite(a.tMin));
  if (concave.length === 0) return [];

  // Model extent along each candidate axis, for the THRU decision.
  const modelExtent = (axis: Vec3): { lo: number; hi: number } => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const v = positions[i] * axis[0] + positions[i + 1] * axis[1] + positions[i + 2] * axis[2];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return { lo, hi };
  };

  const cosTol = Math.cos((HOLE_AXIS_PARALLEL_DEG * Math.PI) / 180);
  // Merge faces on the same axis line + radius into one hole.
  interface Group {
    radius: number;
    axis: Vec3; // canonical
    origin: Vec3; // a point on the axis line
    faces: Acc[];
  }
  const groups: Group[] = [];
  for (const a of concave) {
    const axis = canonicalAxis(a.cyl.axisDirection);
    const found = groups.find((g) => {
      if (Math.abs(dot(g.axis, axis)) < cosTol) return false;
      if (Math.abs(g.radius - a.cyl.radius) > HOLE_RADIUS_REL_TOL * Math.max(g.radius, a.cyl.radius)) return false;
      const d = sub(a.cyl.axisLocation, g.origin);
      const along = dot(d, g.axis);
      const perp = Math.hypot(d[0] - g.axis[0] * along, d[1] - g.axis[1] * along, d[2] - g.axis[2] * along);
      return perp <= 1e-4 * Math.max(1, g.radius);
    });
    if (found) found.faces.push(a);
    else groups.push({ radius: a.cyl.radius, axis, origin: a.cyl.axisLocation, faces: [a] });
  }

  const holes: DrawnHole[] = [];
  for (const g of groups) {
    // Axial parameters re-measured on the canonical axis from the group origin.
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const f of g.faces) {
      const sign = dot(norm(f.cyl.axisDirection), g.axis) >= 0 ? 1 : -1;
      const off = dot(sub(f.cyl.axisLocation, g.origin), g.axis);
      const lo = sign > 0 ? off + f.tMin : off - f.tMax;
      const hi = sign > 0 ? off + f.tMax : off - f.tMin;
      tMin = Math.min(tMin, lo);
      tMax = Math.max(tMax, hi);
    }
    const ext = modelExtent(g.axis);
    const o = dot(g.origin, g.axis);
    const tol = 1e-3 * Math.max(1, ext.hi - ext.lo);
    const through = o + tMin <= ext.lo + tol && o + tMax >= ext.hi - tol;
    const tMid = (tMin + tMax) / 2;
    holes.push({
      centre: [g.origin[0] + g.axis[0] * tMid, g.origin[1] + g.axis[1] * tMid, g.origin[2] + g.axis[2] * tMid],
      axis: g.axis,
      radius: g.radius,
      tMin,
      tMax,
      depth: tMax - tMin,
      through,
      faceIds: g.faces.map((f) => f.cyl.faceId).sort(),
    });
  }
  return holes;
}

/** Groups holes of the same size, axis and through/blind class into callouts. */
export function groupHoleCallouts(holes: ReadonlyArray<DrawnHole>): HoleCalloutGroup[] {
  const cosTol = Math.cos((HOLE_AXIS_PARALLEL_DEG * Math.PI) / 180);
  const out: HoleCalloutGroup[] = [];
  for (const h of holes) {
    const g = out.find(
      (x) =>
        Math.abs(dot(x.axis, h.axis)) >= cosTol &&
        Math.abs(x.radius - h.radius) <= HOLE_RADIUS_REL_TOL * Math.max(x.radius, h.radius) &&
        x.through === h.through &&
        (h.through || Math.abs((x.depth ?? 0) - h.depth) <= 1e-3 * Math.max(1, h.depth))
    );
    if (g) g.holes.push(h);
    else
      out.push({
        radius: h.radius,
        diameter: 2 * h.radius,
        axis: h.axis,
        through: h.through,
        depth: h.through ? null : h.depth,
        holes: [h],
        text: "",
      });
  }
  for (const g of out) {
    const near = nearestHoleDesignation(g.diameter);
    const tail = g.through ? "THRU" : `↧${trimLength(g.depth ?? 0)}`;
    const desig =
      near && Math.abs(near.delta) <= 0.05 * Math.max(g.diameter, 1)
        ? ` (${near.designation} ${near.column === "tapDrill" ? "TAP DRILL" : "CLEARANCE"})`
        : "";
    g.text = `${g.holes.length}× Ø${trimLength(g.diameter)} ${tail}${desig}`;
  }
  return out.sort((a, b) => a.diameter - b.diameter || b.holes.length - a.holes.length);
}
