/**
 * A small, pure viridis-like colour ramp for "colour by scalar field"
 * (`main.ts`'s `applyColorField`) — no dependency on a real colour-science
 * library, just linear interpolation between a handful of well-known viridis
 * control points (the standard 5-stop approximation used across many
 * dataviz tools when a full 256-entry LUT isn't warranted). DOM-free and
 * pure, so it's unit-testable without jsdom, same convention as every other
 * pure `src/webview/*.ts` module in this codebase.
 */

/** [r, g, b] in 0–255, evenly spaced at t = 0, 0.25, 0.5, 0.75, 1. */
const VIRIDIS_STOPS: Array<[number, number, number]> = [
  [68, 1, 84], // #440154
  [59, 82, 139], // #3b528b
  [33, 144, 141], // #21908d
  [93, 201, 99], // #5dc963
  [253, 231, 37], // #fde725
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Returns `[r, g, b]` in 0–1 for `t` clamped to `[0, 1]`. */
export function viridis(t: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (VIRIDIS_STOPS.length - 1);
  const i = Math.min(VIRIDIS_STOPS.length - 2, Math.floor(scaled));
  const frac = scaled - i;
  const [r0, g0, b0] = VIRIDIS_STOPS[i];
  const [r1, g1, b1] = VIRIDIS_STOPS[i + 1];
  return [lerp(r0, r1, frac) / 255, lerp(g0, g1, frac) / 255, lerp(b0, b1, frac) / 255];
}

/** Returns a `#rrggbb` CSS colour string for `t` clamped to `[0, 1]` — used
 * for the legend gradient bar's colour stops. */
export function viridisHex(t: number): string {
  const [r, g, b] = viridis(t);
  const hex = (c: number) => Math.round(c * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Maps `value` within `[min, max]` to a viridis `[r, g, b]` triple (0–1). A
 * degenerate range (`min === max`, a constant field) maps everything to the
 * ramp's midpoint rather than dividing by zero. */
export function valueToColor(value: number, min: number, max: number): [number, number, number] {
  if (max <= min) return viridis(0.5);
  return viridis((value - min) / (max - min));
}

/** A handful of evenly-spaced CSS gradient stops for the legend bar, e.g.
 * `"#440154 0%, #3b528b 25%, ..., #fde725 100%"` for a `linear-gradient(to
 * right, ...)` background. */
export function viridisCssGradientStops(steps = 8): string {
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    parts.push(`${viridisHex(t)} ${Math.round(t * 100)}%`);
  }
  return parts.join(", ");
}
