/**
 * "Look at face" (roadmap "Navigation upgrades"): the view direction that shows
 * a planar face head-on. The facts' normal is not guaranteed outward, so the
 * sign is chosen to match the side the camera is already on — the face is
 * always seen from the front, and a face seen edge-on (|dot| ≈ 0) keeps the
 * normal as given. Pure: no three.js, no DOM.
 */
export type V3 = readonly [number, number, number];

export function lookAtFaceDirection(normal: V3, currentViewDir: V3): V3 | null {
  const len = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(len > 1e-12) || !Number.isFinite(len)) return null;
  const n: [number, number, number] = [normal[0] / len, normal[1] / len, normal[2] / len];
  const dot = n[0] * currentViewDir[0] + n[1] * currentViewDir[1] + n[2] * currentViewDir[2];
  // `+ 0` folds -0 into 0 so callers can compare the result exactly.
  return dot < 0 ? [0 - n[0] + 0, 0 - n[1] + 0, 0 - n[2] + 0] : n;
}
