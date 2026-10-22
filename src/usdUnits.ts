/**
 * USD (`.usd/.usda/.usdc/.usdz`) unit handling — pure (no DOM, no THREE, no
 * vscode), Node-safe, unit-tested. three's `USDLoader` scales its root group by
 * the stage's `metersPerUnit` (skipped when absent or 1; there is no validation,
 * so a non-positive or non-finite value would poison the scene) and rotates
 * `upAxis = "Z"` stages to Y-up. The viewer works in millimetres and its root
 * owns the up-axis rotation, so `meshLoaders.ts` reads the loader's scale
 * (which IS `metersPerUnit`, whatever the encoding — text, crate or zipped),
 * resets the loader's own scale/rotation, and applies {@link usdMmPerUnit}.
 */
import type { DisplayUnit } from "./lengthUnits";

/** `metersPerUnit` when it is a positive finite number; the USD default (0.01, centimetres) is NOT assumed — the loader treats an absent value as 1 m. */
function usable(metersPerUnit: number): number {
  return Number.isFinite(metersPerUnit) && metersPerUnit > 0 ? metersPerUnit : 1;
}

/** Millimetres per USD unit (a bad value falls back to metres). */
export function usdMmPerUnit(metersPerUnit: number): number {
  return usable(metersPerUnit) * 1000;
}

const DECLARED: ReadonlyArray<readonly [DisplayUnit, number]> = [
  ["mm", 0.001],
  ["cm", 0.01],
  ["m", 1],
  ["in", 0.0254],
  ["ft", 0.3048],
];

/**
 * The Units-dropdown entry matching a stage that declared its unit, or
 * `undefined`: a value of exactly 1 is indistinguishable from "not declared"
 * once the loader has applied it, and selecting metres for a file that never
 * said so would be surprising. Presentation only.
 */
export function usdDeclaredUnit(metersPerUnit: number): DisplayUnit | undefined {
  const m = usable(metersPerUnit);
  if (m === 1) return undefined;
  return DECLARED.find(([, v]) => Math.abs(m - v) <= 1e-9 * Math.max(1, v))?.[0];
}
