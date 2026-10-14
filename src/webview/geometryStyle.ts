/**
 * Pure styling data for the Geometry display mode — the GiD-style structural
 * view that shows what a B-rep is made of (points, edges, faces, solids).
 * DOM/Three.js free so vitest can pin it.
 */

/** Opacity multiplier for face fills in Geometry mode (faint, like a ghost). */
export const GEOMETRY_FACE_OPACITY = 0.12;

/** Point sprites are drawn this many times larger than in the other modes. */
export const GEOMETRY_POINT_SCALE = 1.8;

/**
 * Stable, deterministic colour (0xRRGGBB) for the solid at `index`: hues step
 * by the golden angle so neighbours stay distinguishable at any solid count.
 * Saturation/lightness sit mid-range so the colour reads on dark, light and
 * high-contrast backgrounds alike.
 */
export function solidColor(index: number): number {
  const i = Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
  const hue = (i * 137.508) % 360;
  return hslToHex(hue, 0.7, 0.55);
}

/** Parses the numeric index out of a `solid-N` / `group-N`-style id; 0 if none. */
export function solidIndexOf(groupId: unknown): number {
  const m = /(\d+)\s*$/.exec(String(groupId ?? ""));
  return m ? Number(m[1]) : 0;
}

function hslToHex(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const to = (v: number) => Math.round((v + m) * 255);
  return (to(r) << 16) | (to(g) << 8) | to(b);
}
