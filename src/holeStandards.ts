/**
 * Standard threaded-hole sizes — ISO metric coarse/fine and Unified UNC/UNF.
 *
 * Pure data plus lookup helpers: no vscode, no OCCT, no new op kind. The whole
 * point is that `addHole`/`addCounterboreHole`/`addCountersinkHole`
 * (`src/editOps.ts`) already take plain numeric `radius`/`depth` with zero
 * standard-size awareness, so a caller has to already know that an M6×1.0
 * tapped hole wants a 5.0 mm tap drill. This table supplies that number; the
 * ops are unchanged.
 *
 * **Every diameter is in millimetres**, including the imperial designations —
 * mm is the geometry unit every edit op consumes (OCCT's cascade unit), so a
 * table that reported inches would be a trap at the call site. `nominalInch` is
 * carried separately for the imperial rows so the original designation stays
 * legible.
 *
 * Two diameters per designation, and they are NOT interchangeable:
 *
 * - `tapDrillDiameter` — for a hole that will be **tapped** with this thread.
 *   Metric rows follow the standard `D − P` rule (major diameter minus pitch),
 *   which targets roughly 75% thread engagement.
 * - `clearanceDiameter` — for a hole a bolt of this size **passes through**
 *   (ISO 273 "medium" fit for the metric rows).
 *
 * Reporting facts, not a recommendation: which one a caller wants depends on
 * whether the hole is threaded or a through-hole, and this module does not
 * guess. Same convention as `inspect`/`measure` — see `describeCapabilities()`'s
 * `verdictConventions`.
 */

/** The thread standards this table covers. */
export type HoleStandard = "iso-metric-coarse" | "iso-metric-fine" | "unc" | "unf";

export const HOLE_STANDARDS: readonly HoleStandard[] = [
  "iso-metric-coarse",
  "iso-metric-fine",
  "unc",
  "unf",
];

export interface HoleSize {
  /** e.g. "M6", "M10x1.25", "1/4-20". Unique within its standard. */
  designation: string;
  standard: HoleStandard;
  /** Thread major diameter, mm. */
  majorDiameter: number;
  /** Thread pitch, mm (for imperial rows, derived from threads-per-inch). */
  pitch: number;
  /** Drill diameter for a hole that will be TAPPED with this thread, mm. */
  tapDrillDiameter: number;
  /** Drill diameter for a hole this thread's bolt PASSES THROUGH, mm. */
  clearanceDiameter: number;
  /** Nominal size in inches, imperial rows only. */
  nominalInch?: number;
}

/** A table row before its owning standard is attached (done once in `TABLE`). */
type HoleRow = Omit<HoleSize, "standard">;

const MM_PER_INCH = 25.4;

/** inches → mm, rounded to 3dp so the table reads as data rather than float noise. */
const inch = (v: number): number => Math.round(v * MM_PER_INCH * 1000) / 1000;

/**
 * ISO metric coarse. `tapDrillDiameter` is exactly `majorDiameter − pitch`;
 * `clearanceDiameter` is the ISO 273 medium-fit column.
 */
const ISO_COARSE: HoleRow[] = [
  { designation: "M2", majorDiameter: 2, pitch: 0.4, tapDrillDiameter: 1.6, clearanceDiameter: 2.4 },
  { designation: "M2.5", majorDiameter: 2.5, pitch: 0.45, tapDrillDiameter: 2.05, clearanceDiameter: 2.9 },
  { designation: "M3", majorDiameter: 3, pitch: 0.5, tapDrillDiameter: 2.5, clearanceDiameter: 3.4 },
  { designation: "M4", majorDiameter: 4, pitch: 0.7, tapDrillDiameter: 3.3, clearanceDiameter: 4.5 },
  { designation: "M5", majorDiameter: 5, pitch: 0.8, tapDrillDiameter: 4.2, clearanceDiameter: 5.5 },
  { designation: "M6", majorDiameter: 6, pitch: 1, tapDrillDiameter: 5, clearanceDiameter: 6.6 },
  { designation: "M8", majorDiameter: 8, pitch: 1.25, tapDrillDiameter: 6.75, clearanceDiameter: 9 },
  { designation: "M10", majorDiameter: 10, pitch: 1.5, tapDrillDiameter: 8.5, clearanceDiameter: 11 },
  { designation: "M12", majorDiameter: 12, pitch: 1.75, tapDrillDiameter: 10.25, clearanceDiameter: 13.5 },
  { designation: "M16", majorDiameter: 16, pitch: 2, tapDrillDiameter: 14, clearanceDiameter: 17.5 },
  { designation: "M20", majorDiameter: 20, pitch: 2.5, tapDrillDiameter: 17.5, clearanceDiameter: 22 },
  { designation: "M24", majorDiameter: 24, pitch: 3, tapDrillDiameter: 21, clearanceDiameter: 26 },
];

/** ISO metric fine — same majors, finer pitch, so a larger tap drill. */
const ISO_FINE: HoleRow[] = [
  { designation: "M6x0.75", majorDiameter: 6, pitch: 0.75, tapDrillDiameter: 5.25, clearanceDiameter: 6.6 },
  { designation: "M8x1", majorDiameter: 8, pitch: 1, tapDrillDiameter: 7, clearanceDiameter: 9 },
  { designation: "M10x1.25", majorDiameter: 10, pitch: 1.25, tapDrillDiameter: 8.75, clearanceDiameter: 11 },
  { designation: "M12x1.25", majorDiameter: 12, pitch: 1.25, tapDrillDiameter: 10.75, clearanceDiameter: 13.5 },
  { designation: "M16x1.5", majorDiameter: 16, pitch: 1.5, tapDrillDiameter: 14.5, clearanceDiameter: 17.5 },
  { designation: "M20x1.5", majorDiameter: 20, pitch: 1.5, tapDrillDiameter: 18.5, clearanceDiameter: 22 },
  { designation: "M24x2", majorDiameter: 24, pitch: 2, tapDrillDiameter: 22, clearanceDiameter: 26 },
];

/**
 * Unified coarse. Tap-drill and clearance columns come from the standard
 * numbered/lettered/fractional drill sizes, converted to mm — e.g. 1/4-20 taps
 * with a #7 (0.201") and clears with a 17/64" (0.2656").
 */
const UNC: HoleRow[] = [
  { designation: "#4-40", nominalInch: 0.112, majorDiameter: inch(0.112), pitch: inch(1 / 40), tapDrillDiameter: inch(0.089), clearanceDiameter: inch(0.116) },
  { designation: "#6-32", nominalInch: 0.138, majorDiameter: inch(0.138), pitch: inch(1 / 32), tapDrillDiameter: inch(0.1065), clearanceDiameter: inch(0.144) },
  { designation: "#8-32", nominalInch: 0.164, majorDiameter: inch(0.164), pitch: inch(1 / 32), tapDrillDiameter: inch(0.136), clearanceDiameter: inch(0.1695) },
  { designation: "#10-24", nominalInch: 0.19, majorDiameter: inch(0.19), pitch: inch(1 / 24), tapDrillDiameter: inch(0.1495), clearanceDiameter: inch(0.196) },
  { designation: "1/4-20", nominalInch: 0.25, majorDiameter: inch(0.25), pitch: inch(1 / 20), tapDrillDiameter: inch(0.201), clearanceDiameter: inch(0.2656) },
  { designation: "5/16-18", nominalInch: 0.3125, majorDiameter: inch(0.3125), pitch: inch(1 / 18), tapDrillDiameter: inch(0.257), clearanceDiameter: inch(0.3281) },
  { designation: "3/8-16", nominalInch: 0.375, majorDiameter: inch(0.375), pitch: inch(1 / 16), tapDrillDiameter: inch(0.3125), clearanceDiameter: inch(0.3906) },
  { designation: "1/2-13", nominalInch: 0.5, majorDiameter: inch(0.5), pitch: inch(1 / 13), tapDrillDiameter: inch(0.4219), clearanceDiameter: inch(0.5156) },
];

/** Unified fine. */
const UNF: HoleRow[] = [
  { designation: "#4-48", nominalInch: 0.112, majorDiameter: inch(0.112), pitch: inch(1 / 48), tapDrillDiameter: inch(0.0935), clearanceDiameter: inch(0.116) },
  { designation: "#6-40", nominalInch: 0.138, majorDiameter: inch(0.138), pitch: inch(1 / 40), tapDrillDiameter: inch(0.113), clearanceDiameter: inch(0.144) },
  { designation: "#8-36", nominalInch: 0.164, majorDiameter: inch(0.164), pitch: inch(1 / 36), tapDrillDiameter: inch(0.136), clearanceDiameter: inch(0.1695) },
  { designation: "#10-32", nominalInch: 0.19, majorDiameter: inch(0.19), pitch: inch(1 / 32), tapDrillDiameter: inch(0.159), clearanceDiameter: inch(0.196) },
  { designation: "1/4-28", nominalInch: 0.25, majorDiameter: inch(0.25), pitch: inch(1 / 28), tapDrillDiameter: inch(0.213), clearanceDiameter: inch(0.2656) },
  { designation: "5/16-24", nominalInch: 0.3125, majorDiameter: inch(0.3125), pitch: inch(1 / 24), tapDrillDiameter: inch(0.272), clearanceDiameter: inch(0.3281) },
  { designation: "3/8-24", nominalInch: 0.375, majorDiameter: inch(0.375), pitch: inch(1 / 24), tapDrillDiameter: inch(0.332), clearanceDiameter: inch(0.3906) },
  { designation: "1/2-20", nominalInch: 0.5, majorDiameter: inch(0.5), pitch: inch(1 / 20), tapDrillDiameter: inch(0.4531), clearanceDiameter: inch(0.5156) },
];

const TABLE: Record<HoleStandard, HoleSize[]> = {
  "iso-metric-coarse": ISO_COARSE.map((r) => ({ ...r, standard: "iso-metric-coarse" as const })),
  "iso-metric-fine": ISO_FINE.map((r) => ({ ...r, standard: "iso-metric-fine" as const })),
  unc: UNC.map((r) => ({ ...r, standard: "unc" as const })),
  unf: UNF.map((r) => ({ ...r, standard: "unf" as const })),
};

/** Every size in a standard, in ascending nominal order. */
export function holeSizesFor(standard: HoleStandard): HoleSize[] {
  return TABLE[standard].map((r) => ({ ...r }));
}

/** Every size across every standard. */
export function allHoleSizes(): HoleSize[] {
  return HOLE_STANDARDS.flatMap(holeSizesFor);
}

/**
 * One size by designation, or `null`.
 *
 * Case- and separator-insensitive: `"m6"`, `"M6"` and `"M 6"` all resolve, as do
 * `"M10X1.25"` / `"m10x1.25"`. Real designations get written many ways, and a
 * lookup that only matched the canonical spelling would be a needless trap.
 * `standard` narrows the search when the same designation exists in two
 * standards (it does not today, but "M6" vs a future "M6x1" would).
 */
export function findHoleSize(designation: string, standard?: HoleStandard): HoleSize | null {
  const key = normalizeDesignation(designation);
  if (key === "") return null;
  const pool = standard ? TABLE[standard] : HOLE_STANDARDS.flatMap((s) => TABLE[s]);
  const hit = pool.find((r) => normalizeDesignation(r.designation) === key);
  return hit ? { ...hit } : null;
}

function normalizeDesignation(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_]/g, "");
}

/**
 * Common hole depths for a designation, as ready-to-use `depth` values.
 *
 * The multipliers are the usual shop rules for a **tapped blind hole** in a
 * given material class — they are a convenience, not a specification, which is
 * why each carries its own label rather than being returned as one "correct"
 * number. A through hole is not offered here: its depth depends on the stock,
 * not the thread, so the caller supplies it.
 */
export function depthPresetsFor(size: HoleSize): { label: string; depth: number }[] {
  const d = size.majorDiameter;
  return [
    { label: "1×D (steel, minimum)", depth: round3(d) },
    { label: "1.5×D (steel, typical)", depth: round3(d * 1.5) },
    { label: "2×D (aluminium/brass)", depth: round3(d * 2) },
    { label: "2.5×D (soft material)", depth: round3(d * 2.5) },
  ];
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
