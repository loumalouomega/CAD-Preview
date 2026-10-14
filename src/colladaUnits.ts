/**
 * Collada (`.dae`) unit reader — pure (no DOM, no THREE, no vscode),
 * Node-safe, unit-tested. `meshLoaders.ts` uses it because three's
 * `ColladaLoader` multiplies the scene by the raw `<unit meter="…">` value
 * (metres per file unit, `NaN` for a malformed value) and the viewer works in
 * millimetres: the loader's own scale is reset and replaced by
 * {@link colladaMmPerUnit}, so a bad attribute can never poison the scene.
 */
import type { DisplayUnit } from "./lengthUnits";

/** The asset's `<unit meter>` when present and a positive finite number. */
function declaredMeter(text: string): number | undefined {
  // Only the `asset` block's `<unit>` counts (a `<unit>` tag elsewhere, e.g. in
  // a physics library, is not the file's length unit).
  const asset = /<asset\b[\s\S]*?<\/asset>/i.exec(text);
  const m = asset ? /<unit\b[^>]*?\bmeter\s*=\s*"([^"]*)"/i.exec(asset[0]) : null;
  const v = m ? Number.parseFloat(m[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Metres per Collada unit; the spec default (1 m) when absent or unusable. */
export function colladaMetresPerUnit(text: string): number {
  return declaredMeter(text) ?? 1;
}

/** Millimetres per Collada unit. */
export function colladaMmPerUnit(text: string): number {
  return colladaMetresPerUnit(text) * 1000;
}

const DECLARED: ReadonlyArray<readonly [DisplayUnit, number]> = [
  ["mm", 0.001],
  ["cm", 0.01],
  ["m", 1],
  ["in", 0.0254],
  ["ft", 0.3048],
];

/**
 * The Units-dropdown entry matching the declared unit, or `undefined` (an
 * unlisted unit such as a micron, or no `<unit>` at all — the spec default is
 * metres, which would be a surprising thing to *select* for a file that never
 * said so). Presentation only; the geometry is scaled by {@link colladaMmPerUnit}.
 */
export function colladaDeclaredUnit(text: string): DisplayUnit | undefined {
  const metres = declaredMeter(text);
  if (metres === undefined) return undefined;
  return DECLARED.find(([, m]) => Math.abs(metres - m) <= 1e-9 * Math.max(1, m))?.[0];
}
