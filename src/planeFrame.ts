import type { ConstructionPlane } from "./protocol";

export type Vec3 = [number, number, number];

/**
 * Deterministic 2D frame for authoring profiles on a named construction
 * plane (roadmap Tier 1 "Author profiles on a named construction plane").
 *
 * A plane (point + normal) does not fully specify a 2D frame, so this
 * module fixes the one canonical answer both the host replay and the
 * webview form use: `planeBasis` is a pure function of the normal alone
 * (the helper-vector rule `occtOperations.ts`'s N-gon prism path already
 * used — extracted here so the two can never drift), and per-op
 * `rotationDeg` rotates within it. Persisting an axis per plane was
 * considered and rejected: it needs a sidecar migration plus panel UI,
 * while per-op rotation already covers orientation control.
 *
 * Pure and vscode/OCCT/THREE-free (the `opBuckets.ts` split), unit-tested.
 * Changing a plane moves everything referencing it (placements re-resolve
 * every read); deleting one freezes last-good caches (the resolver's job,
 * in `planeRefs.ts` — this module only ever computes forward).
 */

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(len) || len < 1e-12) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Deterministic orthonormal in-plane basis `[U, V]` for a plane normal.
 * Returns `null` for a degenerate normal. The helper-vector rule (×X unless
 * the normal is near ±X, then ×Y) matches `occtOperations.ts`'s own
 * `planeBasis`, which now delegates here.
 */
export function planeBasis(normal: Vec3): [Vec3, Vec3] | null {
  const n = norm(normal);
  if (!n) return null;
  const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm(cross(helper, n));
  if (!u) return null;
  const v = norm(cross(n, u));
  if (!v) return null;
  return [u, v];
}

export interface PlanePlacement {
  center: Vec3;
  normal: Vec3;
  /** In-plane "up" axis (the frame's V rotated by `rotationDeg`). */
  up: Vec3;
}

/**
 * Resolves a profile placement from a plane plus in-plane offsets and an
 * in-plane rotation (degrees, about the plane normal): `center` is the
 * plane point shifted by `offsetU`/`offsetV` along the deterministic basis,
 * `normal` is the plane normal, `up` is V rotated by `rotationDeg`
 * (0 = the basis itself). Returns `null` for a degenerate plane normal —
 * the caller freezes last-good caches instead of placing garbage.
 */
export function profilePlacementFromPlane(
  plane: Pick<ConstructionPlane, "point" | "normal">,
  offsetU: number,
  offsetV: number,
  rotationDeg: number
): PlanePlacement | null {
  if (
    !Number.isFinite(offsetU) || !Number.isFinite(offsetV) || !Number.isFinite(rotationDeg) ||
    !plane.point.every(Number.isFinite)
  ) {
    return null;
  }
  const basis = planeBasis(plane.normal);
  if (!basis) return null;
  const [u, v] = basis;
  const n = norm(plane.normal);
  if (!n) return null;
  const center: Vec3 = [
    plane.point[0] + u[0] * offsetU + v[0] * offsetV,
    plane.point[1] + u[1] * offsetU + v[1] * offsetV,
    plane.point[2] + u[2] * offsetU + v[2] * offsetV,
  ];
  const a = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const up: Vec3 = [
    v[0] * c + u[0] * s,
    v[1] * c + u[1] * s,
    v[2] * c + u[2] * s,
  ];
  const upN = norm(up);
  if (!upN) return null;
  return { center, normal: n, up: upN };
}
