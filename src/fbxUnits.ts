/**
 * FBX (`.fbx`) unit handling — pure (no DOM, no THREE, no vscode), Node-safe,
 * unit-tested. three's `FBXLoader` never applies `GlobalSettings.UnitScaleFactor`:
 * it only copies it to `scene.userData.unitScaleFactor`. The factor is the
 * number of CENTIMETRES per file unit (the FBX default, 1, is centimetres), and
 * an absent factor means the same default. The viewer works in millimetres, so
 * `meshLoaders.ts` applies {@link fbxMmPerUnit} once to the loaded group.
 */
import type { DisplayUnit } from "./lengthUnits";

/** The factor when it is a positive finite number; anything else falls back to the FBX default (centimetres). */
function usable(unitScaleFactor: unknown): number {
  return typeof unitScaleFactor === "number" && Number.isFinite(unitScaleFactor) && unitScaleFactor > 0 ? unitScaleFactor : 1;
}

/** Millimetres per FBX unit (a missing or bad value falls back to centimetres). */
export function fbxMmPerUnit(unitScaleFactor: unknown): number {
  return usable(unitScaleFactor) * 10;
}

const DECLARED: ReadonlyArray<readonly [DisplayUnit, number]> = [
  ["mm", 0.1],
  ["m", 100],
  ["in", 2.54],
  ["ft", 30.48],
];

/**
 * The Units-dropdown entry matching a file that declared a non-default unit,
 * or `undefined`. A factor of exactly 1 (centimetres) is indistinguishable from
 * "not declared" once the loader has run, so it leaves the dropdown alone.
 * Presentation only.
 */
export function fbxDeclaredUnit(unitScaleFactor: unknown): DisplayUnit | undefined {
  const f = usable(unitScaleFactor);
  if (f === 1) return undefined;
  return DECLARED.find(([, v]) => Math.abs(f - v) <= 1e-9 * Math.max(1, v))?.[0];
}
