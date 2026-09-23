/**
 * Pure mesh-size heuristics for the FE Mesh panel's coarser→finer slider:
 * bbox-derived default target size, log-scale slider↔size mapping, preset
 * positions, and an order-of-magnitude element-count estimate. Deliberately
 * vscode-free AND THREE-free (plain numbers in, plain numbers out) so it
 * unit-tests headless like `cameraControls.ts`, and — critically — pure JS
 * with no gmsh/WASM involvement, so the lazy-WASM-init invariant is never at
 * risk from merely rendering the panel.
 */

/** The default target element size is `diagonal / DEFAULT_SIZE_DIVISOR`. */
export const DEFAULT_SIZE_DIVISOR = 20;

/** Slider fully left (t=0): size = diagonal / COARSE_DIVISOR (coarsest). */
export const COARSE_DIVISOR = 5;

/** Slider fully right (t=1): size = diagonal / FINE_DIVISOR (finest). */
export const FINE_DIVISOR = 200;

/** Divisors behind the Coarse/Medium/Fine preset buttons. */
export const PRESET_DIVISORS = { coarse: 10, medium: 20, fine: 50 } as const;

/** Estimated element counts above this trigger the panel's large-mesh warning. */
export const LARGE_ELEMENT_COUNT = 1_000_000;

/** The bbox-derived default target element size for a model of this diagonal. */
export function defaultTargetSize(diagonal: number): number {
  return diagonal / DEFAULT_SIZE_DIVISOR;
}

/**
 * Like {@link defaultTargetSize}, but scaled by the `cadPreview.defaultMeshSizePreset`
 * setting's divisor instead of the fixed `DEFAULT_SIZE_DIVISOR` — used to seed a
 * model that has no saved `.mesh.json` sidecar yet (see `syncMeshSizeSeed` in
 * `src/webview/main.ts`). `"medium"` is equivalent to {@link defaultTargetSize}
 * since `PRESET_DIVISORS.medium === DEFAULT_SIZE_DIVISOR`.
 */
export function targetSizeForPreset(diagonal: number, preset: keyof typeof PRESET_DIVISORS): number {
  return diagonal / PRESET_DIVISORS[preset];
}

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/**
 * Maps a slider position `t` ∈ [0,1] (0 = coarser, 1 = finer) to a target
 * element size, log-interpolated between `diagonal/COARSE_DIVISOR` and
 * `diagonal/FINE_DIVISOR`.
 */
export function sliderToSize(t: number, diagonal: number): number {
  return (diagonal / COARSE_DIVISOR) * Math.pow(COARSE_DIVISOR / FINE_DIVISOR, clamp01(t));
}

/**
 * Inverse of {@link sliderToSize}, clamped to [0,1] — a size outside the
 * slider's range pegs the thumb at the matching end while the numeric
 * readout keeps showing the true value.
 */
export function sizeToSlider(size: number, diagonal: number): number {
  if (!(size > 0) || !(diagonal > 0)) return 0;
  const t = Math.log(size / (diagonal / COARSE_DIVISOR)) / Math.log(COARSE_DIVISOR / FINE_DIVISOR);
  return clamp01(t);
}

// The element-count estimate moved to the shared, calibrated `src/meshBudget.ts`
// (roadmap "Mesh size and memory budget preview") — host and webview use one model.

/** Compact human count for the readout: "~850", "~12k", "~1.2M". */
export function formatCount(n: number): string {
  if (n >= 1e6) return `~${trim1(n / 1e6)}M`;
  if (n >= 1e3) return `~${trim1(n / 1e3)}k`;
  return `~${Math.round(n)}`;
}

/** A size formatted to 3 significant digits without trailing exponent noise. */
export function formatSize(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const s = n.toPrecision(3);
  // Strip a redundant trailing ".00"/"0" from toPrecision output (e.g. "5.00" → "5").
  return String(Number(s));
}

/** One decimal for values under 10, whole numbers above (12.3 → "12"). */
function trim1(v: number): string {
  return v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
}
