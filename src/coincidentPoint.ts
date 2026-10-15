import type { Vec3 } from "./editOps";

/**
 * Webview-side pre-check for the coincident-point prompt (roadmap
 * "Coincident-point prompt: collapse or keep independent"): the id of the
 * existing point nearest `position` within `1e-3 × diagonal` (floor `1e-6`,
 * the same rule the host uses in the fold), or null. Advisory only — the host
 * re-verifies at replay, so a disagreement here is harmless.
 */
export function findCoincidentPoint(
  position: Vec3,
  points: ReadonlyArray<{ id: string; position: Vec3 }>,
  diagonal: number
): string | null {
  const tol = Math.max(1e-3 * (Number.isFinite(diagonal) ? diagonal : 0), 1e-6);
  let best: string | null = null;
  let bestDist = Infinity;
  for (const p of points) {
    const d = Math.hypot(p.position[0] - position[0], p.position[1] - position[1], p.position[2] - position[2]);
    if (d <= tol && d < bestDist) { bestDist = d; best = p.id; }
  }
  return best;
}
