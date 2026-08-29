/**
 * Containment test for automatic re-framing (roadmap "Render on demand",
 * second half): skip the edit-driven rebuild's auto-reframe when the new
 * model bounds already fit inside the last padded fit sphere, so a series of
 * small edits stops twitching the camera on every rebuild. Explicit Fit /
 * Reset / restore paths bypass this entirely — they frame unconditionally.
 *
 * Pure tuple math (no THREE), unit-tested headless.
 */

/** A framing sphere: center + ALREADY-PADDED radius (the radius the camera
 * was actually framed to show, margin included — not the raw bounds radius). */
export interface FitSphere {
  center: [number, number, number];
  radius: number;
}

/**
 * True when a model whose raw bounds sphere is (`nextCenter`, `nextRadius`)
 * would be fully visible inside `prev`'s padded sphere — i.e. re-framing it
 * would move the camera by an imperceptible amount, so the reframe is
 * skippable. A missing baseline never skips (first frame always frames).
 */
export function shouldSkipAutoReframe(
  prev: FitSphere | null,
  nextCenter: [number, number, number],
  nextRadius: number
): boolean {
  if (!prev) return false;
  const dx = prev.center[0] - nextCenter[0];
  const dy = prev.center[1] - nextCenter[1];
  const dz = prev.center[2] - nextCenter[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) + nextRadius <= prev.radius;
}
