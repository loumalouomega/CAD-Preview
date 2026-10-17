/**
 * Field-driven size map for MMG adaptation (roadmap "Metric-driven adaptive
 * remeshing from a field"). Pure and WASM-free: meshio++'s `estimateError`
 * supplies a per-cell ZZ indicator, this turns it into a per-vertex target
 * edge length, and `lumpedIntegral` is the conservation check.
 *
 * Probed on a 2 492-tet box mesh (a Gaussian peak): strength 0.5 → 6 gives a
 * near/far element density ratio of 6–29×, and `conservativeInterpolate` keeps
 * ∑f·volume to ~1e-15 relative.
 */

/** Default strength α in `h = base / (1 + α·e/ē)`. */
export const ADAPT_DEFAULT_STRENGTH = 6;

export interface AdaptSizeInput {
  /** Flat xyz, three per point. */
  positions: ArrayLike<number>;
  /** Zero-based tetra connectivity, four per cell. */
  tetrahedra: ArrayLike<number | bigint>;
  /** One non-negative indicator per tetra (meshio++ `error:zz`). */
  indicator: ArrayLike<number>;
  /** Target size where the indicator is average or below. */
  base: number;
  /** Floor on the target size. */
  min: number;
  strength?: number;
}

export interface AdaptSizes {
  /** Per-vertex target edge length. */
  sizes: Float64Array;
  meanIndicator: number;
  /** Smallest and largest target size actually assigned. */
  range: [number, number];
}

/** `h(cell) = max(min, base / (1 + strength·e/ē))`; a vertex takes the smallest size of its cells. */
export function sizeMapFromIndicator(input: AdaptSizeInput): AdaptSizes {
  const np = Math.floor(input.positions.length / 3);
  const nc = Math.floor(input.tetrahedra.length / 4);
  if (input.indicator.length !== nc) throw new Error(`error indicator has ${input.indicator.length} values for ${nc} tetrahedra`);
  if (!(input.base > 0) || !(input.min > 0) || input.min > input.base) throw new Error("adapt sizes need 0 < min <= base");
  const strength = input.strength ?? ADAPT_DEFAULT_STRENGTH;
  if (!(strength > 0) || !Number.isFinite(strength)) throw new Error("adapt strength must be positive and finite");
  let sum = 0, count = 0;
  for (let i = 0; i < nc; i++) {
    const e = input.indicator[i];
    if (Number.isFinite(e) && e >= 0) { sum += e; count++; }
  }
  const mean = count ? sum / count : 0;
  const sizes = new Float64Array(np).fill(input.base);
  let lo = Infinity, hi = -Infinity;
  for (let c = 0; c < nc; c++) {
    const e = input.indicator[c];
    const ratio = mean > 0 && Number.isFinite(e) && e > 0 ? e / mean : 0;
    const h = Math.max(input.min, input.base / (1 + strength * ratio));
    for (let j = 0; j < 4; j++) {
      const v = Number(input.tetrahedra[4 * c + j]);
      if (!(v >= 0 && v < np)) throw new Error("tetrahedron vertex index out of range");
      if (h < sizes[v]) sizes[v] = h;
    }
  }
  for (const s of sizes) { if (s < lo) lo = s; if (s > hi) hi = s; }
  return { sizes, meanIndicator: mean, range: [lo, hi] };
}

/** ∑ cellVolume · mean(vertex value): the quantity `conservativeInterpolate` preserves. */
export function lumpedIntegral(positions: ArrayLike<number>, tetrahedra: ArrayLike<number | bigint>, values: ArrayLike<number>): number {
  let total = 0;
  for (let c = 0; c + 3 < tetrahedra.length; c += 4) {
    const v = [0, 1, 2, 3].map((j) => Number(tetrahedra[c + j]));
    const p = v.map((k) => [positions[3 * k], positions[3 * k + 1], positions[3 * k + 2]]);
    const a = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const b = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const d = [p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]];
    const vol = Math.abs(a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0]) + a[2] * (b[0] * d[1] - b[1] * d[0])) / 6;
    total += vol * ((values[v[0]] + values[v[1]] + values[v[2]] + values[v[3]]) / 4);
  }
  return total;
}
