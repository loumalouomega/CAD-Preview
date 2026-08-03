/**
 * Length-unit identifiers and their millimetre scale factors — pure,
 * vscode/DOM/THREE-free, shared by both the webview's *display* conversion
 * (`src/webview/units.ts`, which rescales what a number looks like) and the
 * host's *export* conversion (`occtOperations.ts`'s `scaleShapeForExport` /
 * `src/webview/meshExporters.ts`'s `exportModel`, which apply a real
 * geometric scale before writing). Every number this codebase computes is
 * already in one internal length unit (millimetres — OCCT's STEP/IGES
 * readers auto-convert every shape to their cascade unit at read time,
 * verified against the live WASM; see `src/stepUnits.ts`'s doc comment), so
 * `mm: 1` is the identity/no-op case both sides default to.
 */

export type DisplayUnit = "mm" | "cm" | "m" | "in" | "ft";

export const DISPLAY_UNITS: readonly DisplayUnit[] = ["mm", "cm", "m", "in", "ft"];

/** Multiply a millimetre value by this to get the unit's value. */
const UNIT_FACTORS: Record<DisplayUnit, number> = {
  mm: 1,
  cm: 0.1,
  m: 0.001,
  in: 1 / 25.4,
  ft: 1 / 304.8,
};

export function unitScaleFactor(unit: DisplayUnit): number {
  return UNIT_FACTORS[unit];
}

/** Human-readable labels for a unit picker (quick-pick / `<select>`). */
export const UNIT_LABELS: Record<DisplayUnit, string> = {
  mm: "Millimetres (mm)",
  cm: "Centimetres (cm)",
  m: "Metres (m)",
  in: "Inches (in)",
  ft: "Feet (ft)",
};

/** Maps a detected STEP (`src/stepUnits.ts`) or IGES (`src/igesUnits.ts`) unit
 * name — both return the same canonical vocabulary (`"MILLIMETRE"`,
 * `"INCH"`, etc.) so they can share this one mapper — to a `DisplayUnit`, or
 * `undefined` if it's not one of the five this UI offers (e.g. an exotic or
 * unrecognized unit) — the caller falls back to `"mm"` in that case. */
export function displayUnitFromUnitName(name: string | undefined): DisplayUnit | undefined {
  switch (name) {
    case "MILLIMETRE": return "mm";
    case "CENTIMETRE": return "cm";
    case "METRE": return "m";
    case "INCH": return "in";
    case "FOOT": return "ft";
    default: return undefined;
  }
}

/**
 * The unit-name string `IGESControl_Writer`'s alternate, unit-aware
 * constructor (`IGESControl_Writer_2(unitName, modeCreation)`) expects —
 * verified against the live OCCT WASM (unlike the CLAUDE.md-documented
 * original probe, which hit a false negative caused by this codebase's own
 * MEMFS path-length limit, not a real writer limitation): passing each of
 * these five strings and reading the result back through this codebase's own
 * `detectIgesLengthUnit` recovers the exact matching flag (`"MM"`→2,
 * `"CM"`→10, `"M"`→6, `"FT"`→4, `"IN"`→1, i.e. `IGES_UNIT_FLAG_NAMES` in
 * `igesUnits.ts`), and re-reading the written file through `readShape`
 * recovers the original model's bounding box exactly — this writer overload
 * scales the shape's geometry internally to match the requested unit, so the
 * shape passed to it must stay at the native cascade (mm) scale, unlike
 * `exportBRep`'s STEP path (which pre-scales via `scaleShapeForExport`
 * before writing, since the STEP writer has no equivalent unit awareness).
 */
export function igesUnitName(unit: DisplayUnit): string {
  switch (unit) {
    case "mm": return "MM";
    case "cm": return "CM";
    case "m": return "M";
    case "in": return "IN";
    case "ft": return "FT";
  }
}
