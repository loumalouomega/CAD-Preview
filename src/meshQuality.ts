/**
 * Pure per-element mesh-quality summary math — vscode/WASM-free (mirrors
 * `src/massProperties.ts`'s host-module convention). `gmshService.ts` feeds
 * this a flat array of per-element quality values (from Gmsh's own
 * `getElementQualities` — see that call site's doc comment for the verified
 * API shape) and folds it into a min/mean/histogram summary for the FE Mesh
 * panel.
 */

export interface QualitySummary {
  min: number;
  mean: number;
  /** `buckets` counts; bucket `i` covers the quality range `[i/buckets, (i+1)/buckets)`,
   * except the last bucket, which also absorbs anything >= 1 (a perfect element). */
  histogram: number[];
}

/**
 * Folds `values` (one per element, in Gmsh's `minSICN`-style [~-1, 1] range —
 * 1 is a perfect element, <= 0 is degenerate/inverted) into a summary.
 * `values.length === 0` returns an all-zero summary rather than `NaN`s.
 */
export function summarizeQuality(values: number[], buckets = 10): QualitySummary {
  if (values.length === 0) {
    return { min: 0, mean: 0, histogram: new Array(buckets).fill(0) };
  }
  let min = Infinity;
  let sum = 0;
  const histogram = new Array(buckets).fill(0);
  for (const v of values) {
    if (v < min) min = v;
    sum += v;
    const bucket = Math.min(buckets - 1, Math.max(0, Math.floor(v * buckets)));
    histogram[bucket]++;
  }
  return { min, mean: sum / values.length, histogram };
}
