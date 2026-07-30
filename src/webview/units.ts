/**
 * Display-unit conversion — pure, DOM-free (mirrors `measurement.ts`'s
 * convention). Presentation-layer only: every number this module touches is
 * already in the model's one internal length unit (millimetres — OCCT's STEP
 * reader auto-converts every shape to its cascade unit at read time, verified
 * against the live WASM; see `src/stepUnits.ts`'s doc comment). Nothing
 * stored — edit-op params, sidecars, mesh-size options — is ever rescaled;
 * this only changes what a number *looks like* to the user. "Optionally
 * convert units on export" (mentioned in the roadmap) is intentionally out of
 * scope here — it would need a real geometric transform before every OCCT/
 * mesh writer, not a display change.
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

export function convertLength(mmValue: number, unit: DisplayUnit): number {
  return mmValue * UNIT_FACTORS[unit];
}

export function convertArea(mm2Value: number, unit: DisplayUnit): number {
  return mm2Value * UNIT_FACTORS[unit] ** 2;
}

export function convertVolume(mm3Value: number, unit: DisplayUnit): number {
  return mm3Value * UNIT_FACTORS[unit] ** 3;
}

/** Maps a detected STEP unit name (`src/stepUnits.ts`) to a `DisplayUnit`, or
 * `undefined` if it's not one of the five this UI offers (e.g. an exotic or
 * unrecognized unit) — the caller falls back to `"mm"` in that case. */
export function displayUnitFromStepName(name: string | undefined): DisplayUnit | undefined {
  switch (name) {
    case "MILLIMETRE": return "mm";
    case "CENTIMETRE": return "cm";
    case "METRE": return "m";
    case "INCH": return "in";
    case "FOOT": return "ft";
    default: return undefined;
  }
}

/** Volume/area/length/centerOfMass fields, in millimetres — the shape both
 * `MassProperties` (host) and mesh-computed results share. */
export interface LengthBasedProperties {
  volume: number | null;
  area: number | null;
  length: number | null;
  centerOfMass: [number, number, number] | null;
}

/** Rescales the length/area/volume-dimensioned fields of `props` to `unit` —
 * moments of inertia are deliberately left untouched (a length^5-ish
 * geometric quantity; explicit scope decision, not an oversight — see the
 * module doc comment above). */
export function convertLengthBasedProperties<T extends LengthBasedProperties>(props: T, unit: DisplayUnit): T {
  return {
    ...props,
    volume: props.volume == null ? null : convertVolume(props.volume, unit),
    area: props.area == null ? null : convertArea(props.area, unit),
    length: props.length == null ? null : convertLength(props.length, unit),
    centerOfMass: props.centerOfMass == null ? null : (props.centerOfMass.map((v) => convertLength(v, unit)) as [number, number, number]),
  };
}
