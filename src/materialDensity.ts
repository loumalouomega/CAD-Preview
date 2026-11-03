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
  /** Suggested part colour (`#rrggbb`) the Parts panel offers on picking; presentation only, never stored with the name. */
  color: string;
}

export const MATERIALS: readonly Material[] = [
  { name: "steel", density: 7.85, color: "#8d939b" },
  { name: "stainless steel", density: 8.0, color: "#b9bec6" },
  { name: "aluminium", density: 2.7, color: "#c4c9cf" },
  { name: "copper", density: 8.96, color: "#b87333" },
  { name: "brass", density: 8.5, color: "#c9a227" },
  { name: "titanium", density: 4.5, color: "#8a8d91" },
  { name: "abs", density: 1.04, color: "#e8e2d0" },
  { name: "pla", density: 1.24, color: "#7fb98a" },
  { name: "petg", density: 1.27, color: "#8fc1d8" },
  { name: "nylon", density: 1.15, color: "#efe9dc" },
  { name: "water", density: 1.0, color: "#6aa9e0" },
];

/** Case-insensitive lookup; `aluminum` is accepted for `aluminium`. */
export function densityForMaterial(name: string): number | undefined {
  const key = name.trim().toLowerCase().replace("aluminum", "aluminium");
  return MATERIALS.find((m) => m.name === key)?.density;
}

/** Panel label for a table name: first letter upper-cased ("stainless steel" -> "Stainless steel"); "abs"/"pla"/"petg" read as acronyms. */
export function materialLabel(name: string): string {
  return /^(abs|pla|petg)$/.test(name) ? name.toUpperCase() : name.charAt(0).toUpperCase() + name.slice(1);
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
