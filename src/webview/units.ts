/**
 * Display-unit conversion — pure, DOM-free (mirrors `measurement.ts`'s
 * convention). Presentation-layer only: every number this module touches is
 * already in the model's one internal length unit (millimetres — see
 * `../lengthUnits.ts`'s doc comment). Nothing stored — edit-op params,
 * sidecars, mesh-size options — is ever rescaled; this only changes what a
 * number *looks like* to the user. Unit conversion on EXPORT (a real
 * geometric transform before the OCCT/mesh writers) is a separate feature —
 * see `occtOperations.ts`'s `scaleShapeForExport` and
 * `meshExporters.ts`'s `exportModel` — built on the same shared
 * `../lengthUnits.ts` factor table as this file, so the two can't drift.
 */

export type { DisplayUnit } from "../lengthUnits";
export { DISPLAY_UNITS, displayUnitFromStepName } from "../lengthUnits";

import { unitScaleFactor, type DisplayUnit } from "../lengthUnits";

export function convertLength(mmValue: number, unit: DisplayUnit): number {
  return mmValue * unitScaleFactor(unit);
}

export function convertArea(mm2Value: number, unit: DisplayUnit): number {
  return mm2Value * unitScaleFactor(unit) ** 2;
}

export function convertVolume(mm3Value: number, unit: DisplayUnit): number {
  return mm3Value * unitScaleFactor(unit) ** 3;
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
