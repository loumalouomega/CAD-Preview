/**
 * Pure material-density helpers (roadmap "Per-Part material density"): the
 * bundled name → density table, density validation, and the mass arithmetic.
 * Densities are g/cm³ and approximate handbook values; the Part stores the
 * NUMBER, never the name, so a table edit never changes an existing document.
 */

export interface Material {
  name: string;
  /** g/cm³ */
  density: number;
}

export const MATERIALS: readonly Material[] = [
  { name: "steel", density: 7.85 },
  { name: "stainless steel", density: 8.0 },
  { name: "aluminium", density: 2.7 },
  { name: "copper", density: 8.96 },
  { name: "brass", density: 8.5 },
  { name: "titanium", density: 4.5 },
  { name: "abs", density: 1.04 },
  { name: "pla", density: 1.24 },
  { name: "petg", density: 1.27 },
  { name: "nylon", density: 1.15 },
  { name: "water", density: 1.0 },
];

/** Case-insensitive lookup; `aluminum` is accepted for `aluminium`. */
export function densityForMaterial(name: string): number | undefined {
  const key = name.trim().toLowerCase().replace("aluminum", "aluminium");
  return MATERIALS.find((m) => m.name === key)?.density;
}

/** A usable density is a finite number > 0; anything else is `undefined`. */
export function validateDensity(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Mass in grams from a volume in mm³ and a density in g/cm³ (1 cm³ = 1000 mm³). */
export function massGrams(volumeMm3: number, densityGcm3: number): number {
  return (volumeMm3 / 1000) * densityGcm3;
}

/**
 * Sums per-row masses. `total` is `null` unless EVERY row has a mass, and the
 * rows without one are named in `missing` — a part with no density is reported
 * as missing, never counted as zero.
 */
export function totalMass(rows: ReadonlyArray<{ name: string; mass: number | null }>): { total: number | null; missing: string[] } {
  const missing = rows.filter((r) => r.mass === null).map((r) => r.name);
  if (rows.length === 0 || missing.length > 0) return { total: null, missing };
  return { total: rows.reduce((s, r) => s + (r.mass as number), 0), missing };
}
