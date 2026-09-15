/**
 * Hole table / feature schedule (roadmap Tier 1 "Hole table", closed) — the
 * pure half; the OCCT-touching enumeration lives in `massProperties.ts`'s
 * `computeHoleTable` (sibling of `computeBom`), split out for the same reason
 * every other pure/impure pair in this codebase is split
 * (`bomExport.ts`/`massProperties.ts` et al): `mcpTools.ts` must stay
 * importable under vitest with no `.wasm` anywhere in its graph, and it needs
 * the row shape + TSV serializer as VALUES.
 *
 * A row groups cylindrical faces by SIZE (radius + axis direction), never by
 * position — the feature-schedule convention: two M6 holes on opposite ends
 * of a part are one row with count 2, and their `faceIds` say where. The
 * nearest standard designation is a FACT (measured diameter vs the table,
 * with the signed delta always reported), never a verdict — the same
 * facts-not-verdicts convention `holeStandards.ts` and `inspect`/`measure`
 * follow. No convex/concave filtering: a shaft OD and a hole ID are both
 * cylinders, and telling them apart would need unverified orientation logic.
 */

import type { Vec3 } from "./editOps";
import { allHoleSizes, type HoleStandard } from "./holeStandards";

/** One cylindrical face's measured facts, as `computeHoleTable` reads them
 * off `faceSurfaceInfo`'s cylinder branch (world coordinates, file units). */
export interface CylindricalFaceFacts {
  /** Global `face-N` id (position in `collectFaces` order). */
  id: string;
  /** Owning real solids (possibly empty for a free/sketch face). */
  solidIds: string[];
  radius: number;
  axisDirection: Vec3;
}

export interface NearestHoleDesignation {
  designation: string;
  standard: HoleStandard;
  /** Which table column the measured diameter matched closest. */
  column: "tapDrill" | "clearance";
  /** `measuredDiameter - columnValue` (signed, mm) — the caller judges. */
  delta: number;
}

export interface HoleTableRow {
  radius: number;
  /** `2 * radius`, the number actually matched against the table. */
  diameter: number;
  /** Canonicalized axis (first-significant-component positive, so opposite
   * readings of the same direction compare equal). */
  axis: Vec3;
  count: number;
  faceIds: string[];
  solidIds: string[];
  nearest: NearestHoleDesignation;
}

/**
 * Relative radius tolerance for grouping. Analytic accessor values for faces
 * cut by the same feature are typically bitwise identical; rotated copies
 * (e.g. a `patternCircular` hole ring) can drift by float error — 1e-6
 * relative absorbs that without ever merging two distinct standard sizes
 * (adjacent table rows differ by ~10% or more).
 */
export const HOLE_RADIUS_REL_TOL = 1e-6;

/**
 * Axis-parallelism tolerance for grouping, in degrees. Cylinder axis sign is
 * arbitrary per face (opposite ends of one hole can read opposite directions),
 * so grouping is sign-insensitive (`|dot|`); 0.1° absorbs rotated-copy float
 * error while two deliberately different hole orientations never sit this
 * close on real parts.
 */
export const HOLE_AXIS_PARALLEL_DEG = 0.1;

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Sign-canonicalized unit axis, or `null` for a degenerate direction. */
function canonicalAxis(dir: Vec3): Vec3 | null {
  const n = norm(dir);
  if (!(n > 0) || !Number.isFinite(n)) return null;
  const u: Vec3 = [dir[0] / n, dir[1] / n, dir[2] / n];
  // First-significant-component positive, so opposite readings of the same
  // geometric direction canonicalize identically (NaN-safe: comparisons
  // against NaN are false, falling through to the +1 branch deterministically).
  const s = Math.abs(u[0]) > 1e-12 ? Math.sign(u[0]) : Math.abs(u[1]) > 1e-12 ? Math.sign(u[1]) : 1;
  return [u[0] * s, u[1] * s, u[2] * s];
}

/**
 * Groups cylindrical faces into schedule rows. Faces with a non-finite or
 * non-positive radius, or a degenerate axis, are DROPPED (returned in
 * `dropped`) — a row must never be built from numbers that aren't real.
 */
export function groupCylindricalFaces(faces: CylindricalFaceFacts[]): { rows: HoleTableRow[]; dropped: string[] } {
  const dropped: string[] = [];
  const groups: { radius: number; axis: Vec3; faceIds: string[]; solidIds: string[] }[] = [];
  const cosTol = Math.cos((HOLE_AXIS_PARALLEL_DEG * Math.PI) / 180);

  for (const f of faces) {
    if (!Number.isFinite(f.radius) || !(f.radius > 0)) {
      dropped.push(f.id);
      continue;
    }
    const axis = canonicalAxis(f.axisDirection);
    if (!axis) {
      dropped.push(f.id);
      continue;
    }
    const g = groups.find(
      (g) => Math.abs(g.radius - f.radius) <= HOLE_RADIUS_REL_TOL * Math.max(1, g.radius, f.radius) && Math.abs(dot(g.axis, axis)) >= cosTol
    );
    if (g) {
      g.faceIds.push(f.id);
      for (const s of f.solidIds) if (!g.solidIds.includes(s)) g.solidIds.push(s);
    } else {
      groups.push({ radius: f.radius, axis, faceIds: [f.id], solidIds: [...f.solidIds] });
    }
  }

  // Deterministic order: largest count first, then smallest diameter — a
  // schedule reads top-down from the most common hole. (Ties beyond that keep
  // first-seen order, which is itself deterministic.)
  groups.sort((a, b) => b.faceIds.length - a.faceIds.length || a.radius - b.radius);

  const rows: HoleTableRow[] = groups.map((g) => ({
    radius: g.radius,
    diameter: 2 * g.radius,
    axis: g.axis,
    count: g.faceIds.length,
    faceIds: g.faceIds,
    solidIds: g.solidIds,
    nearest: nearestHoleDesignation(2 * g.radius),
  }));
  return { rows, dropped };
}

/**
 * Nearest standard designation to a measured hole diameter, across every
 * standard and both diameter columns. Deterministic: smallest absolute delta
 * wins; ties break by designation string, then `tapDrill` over `clearance`
 * (a drilled hole is the more common thing to name). The signed `delta` is
 * always reported — proximity is a fact the caller judges, and a far match
 * (e.g. a non-standard diameter) reads as far, never as "M-nearest".
 */
export function nearestHoleDesignation(diameter: number): NearestHoleDesignation {
  type Candidate = { designation: string; standard: HoleStandard; column: "tapDrill" | "clearance"; delta: number };
  let best: Candidate | null = null;
  for (const size of allHoleSizes()) {
    const candidates: Candidate[] = [
      { designation: size.designation, standard: size.standard, column: "tapDrill", delta: diameter - size.tapDrillDiameter },
      { designation: size.designation, standard: size.standard, column: "clearance", delta: diameter - size.clearanceDiameter },
    ];
    for (const c of candidates) {
      if (
        !best ||
        Math.abs(c.delta) < Math.abs(best.delta) - 1e-12 ||
        (Math.abs(Math.abs(c.delta) - Math.abs(best.delta)) <= 1e-12 &&
          (c.designation < best.designation ||
            (c.designation === best.designation && c.column === "tapDrill" && best.column === "clearance")))
      ) {
        best = c;
      }
    }
  }
  // `allHoleSizes()` is a non-empty static table, so `best` is always set —
  // the fallback below is type-system furniture, never a real path.
  return best ?? { designation: "M6", standard: "iso-metric-coarse", column: "tapDrill", delta: diameter - 5 };
}

/**
 * Tab-separated hole-table serialization — the ready-to-paste spreadsheet
 * handoff, mirroring `bomTsv`'s conventions (numbers rounded to 4dp only HERE,
 * never in the rows; `delta` keeps its sign). The axis renders as a compact
 * `x,y,z` triple at 4dp.
 */
export function holeTableTsv(rows: HoleTableRow[]): string {
  const fmt = (n: number): string => String(Number(n.toFixed(4)));
  const header = ["Diameter_mm", "Axis", "Count", "Faces", "Solids", "Nearest", "Column", "Delta_mm"];
  const lines = rows.map((r) =>
    [
      fmt(r.diameter),
      r.axis.map(fmt).join(","),
      String(r.count),
      r.faceIds.join(","),
      r.solidIds.join(","),
      r.nearest.designation,
      r.nearest.column,
      fmt(r.nearest.delta),
    ].join("\t")
  );
  return [header.join("\t"), ...lines].join("\n");
}
