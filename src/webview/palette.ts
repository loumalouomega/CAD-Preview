/**
 * The 3D scene's colour palette, resolved from CSS custom properties so the
 * scene tracks VS Code's active theme instead of being hardcoded for a dark one.
 *
 * Pure except for the one `getComputedStyle` read in {@link refreshPalette} —
 * every value has a literal fallback equal to the colour this codebase used
 * before theming existed, so importing this module needs no DOM (matching
 * `geometryBuilder.ts`'s `dotTexture()` / `measurementOverlay.ts`'s
 * `labelCanvas()` lazy-on-first-use discipline: this module is reachable from
 * headless unit tests with no jsdom).
 *
 * **The `:root` values in `media/viewer.css` MUST equal {@link PALETTE_FALLBACKS}.**
 * Only `.vscode-light` / `.vscode-high-contrast*` override them. That is what
 * keeps the default dark theme rendering byte-identically to before this
 * feature, and what keeps the screenshot harness correct — its page sets no
 * body theme class, so it falls through to `:root`.
 *
 * Values are explicit literals per theme rather than being derived from
 * `--vscode-*` variables: the harness only defines 12 of the 43 `--vscode-*`
 * variables `viewer.css` consumes, so keying a scene colour off an unset one
 * would silently diverge between the harness and a real session.
 */

/**
 * Every themed scene colour. Names describe the ROLE, not the hue, so a light
 * theme can invert a value without the name becoming a lie.
 */
export interface Palette {
  /** Unassigned face fill. */
  face: number;
  /** Unassigned edge line. */
  edge: number;
  /** Unassigned point sprite. */
  point: number;
  /**
   * Selection highlight AND measurement overlay accent — deliberately one
   * entry. These were two constants with the same value in two files
   * (`viewer.ts`'s `SELECTION_COLOR`, `measurementOverlay.ts`'s
   * `MEASURE_COLOR`), the second commented as "matches the selection
   * highlight" — a drift hazard this collapses.
   */
  accent: number;
  /** Out-of-tolerance measurement accent. */
  accentFail: number;
  /** FE mesh overlay fill for triangles not claimed by a part. */
  mesh: number;
  /** FE mesh overlay wireframe. */
  meshWire: number;
  /** Worst-quality-element highlight — an alarming hue in every theme. */
  worstElement: number;
  /** Hidden-Lines display mode's ghost lines. */
  hiddenLineGhost: number;
  /** Scene background. */
  background: number;
  /** Grid helper's centre-line colour. */
  gridCenter: number;
  /** Grid helper's ordinary division colour. */
  gridDivision: number;
  /** Hemisphere light's sky colour. */
  lightSky: number;
  /** Hemisphere light's ground-bounce colour. */
  lightGround: number;
  /** Directional key light. */
  lightKey: number;
}

/**
 * The pre-theming constants, verbatim. Also the fallback for any variable a
 * host fails to define, so a missing `--cad-*` degrades to today's appearance
 * rather than to black.
 */
export const PALETTE_FALLBACKS: Readonly<Palette> = Object.freeze({
  face: 0xc0c4cc,
  edge: 0x303338,
  point: 0xffcc00,
  accent: 0x3b82f6,
  accentFail: 0xe5484d,
  mesh: 0x4ea1ff,
  meshWire: 0x1a3d66,
  worstElement: 0xff3b30,
  hiddenLineGhost: 0x8fa8c9,
  background: 0x1e1e1e,
  gridCenter: 0x888888,
  gridDivision: 0x444444,
  lightSky: 0xffffff,
  lightGround: 0x404040,
  lightKey: 0xffffff,
});

/** `--cad-<name>` is the CSS custom property backing each palette key. */
const CSS_VAR_NAMES: Readonly<Record<keyof Palette, string>> = Object.freeze({
  face: "--cad-face",
  edge: "--cad-edge",
  point: "--cad-point",
  accent: "--cad-accent",
  accentFail: "--cad-accent-fail",
  mesh: "--cad-mesh",
  meshWire: "--cad-mesh-wire",
  worstElement: "--cad-worst-element",
  hiddenLineGhost: "--cad-hidden-line-ghost",
  background: "--cad-background",
  gridCenter: "--cad-grid-center",
  gridDivision: "--cad-grid-division",
  lightSky: "--cad-light-sky",
  lightGround: "--cad-light-ground",
  lightKey: "--cad-light-key",
});

/**
 * Parses a CSS colour string into a 24-bit RGB number, or returns `null` when
 * it isn't one this can read.
 *
 * Handles the two forms a computed custom property realistically takes:
 * `#rgb`/`#rrggbb` (what the stylesheet literally declares — a custom property's
 * computed value is its token stream, NOT a resolved `rgb()`, unlike a real
 * colour property) and `rgb()`/`rgba()` (in case a host normalizes it).
 * Anything else — a named colour, `color(...)`, an empty string from an
 * undefined variable — returns `null` so the caller falls back.
 */
export function parseCssColor(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3) {
      // #abc -> #aabbcc
      const r = digits[0];
      const g = digits[1];
      const b = digits[2];
      return parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
    }
    return parseInt(digits, 16);
  }

  // The `-?` is load-bearing: a channel can compute negative (e.g. from a
  // `calc()`), and without it the whole match fails and the colour silently
  // falls back instead of clamping.
  const rgb = /^rgba?\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)/i.exec(text);
  if (rgb) {
    const channel = (s: string): number => Math.max(0, Math.min(255, Math.round(Number(s))));
    const r = channel(rgb[1]);
    const g = channel(rgb[2]);
    const b = channel(rgb[3]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
    return (r << 16) | (g << 8) | b;
  }

  return null;
}

let _palette: Palette = { ...PALETTE_FALLBACKS };

/**
 * Re-reads every `--cad-*` custom property off `document.body` and returns the
 * new palette. Call this on a theme change BEFORE re-applying colours.
 *
 * Reads from `document.body` rather than `document.documentElement` because
 * VS Code puts the theme class (`vscode-light` etc.) on the body, so a
 * `.vscode-light { --cad-face: ... }` rule only wins when resolved against an
 * element the class applies to.
 *
 * Never throws: with no DOM (headless tests) or an unreadable value, the
 * affected key keeps its {@link PALETTE_FALLBACKS} value.
 */
export function refreshPalette(): Palette {
  const next: Palette = { ...PALETTE_FALLBACKS };
  try {
    const style = getComputedStyle(document.body);
    for (const key of Object.keys(CSS_VAR_NAMES) as (keyof Palette)[]) {
      const parsed = parseCssColor(style.getPropertyValue(CSS_VAR_NAMES[key]));
      if (parsed !== null) next[key] = parsed;
    }
  } catch {
    // No DOM — keep the fallbacks. Same graceful-degradation rule as every
    // other optional read in this codebase.
  }
  _palette = next;
  return _palette;
}

/**
 * The current palette. Cheap (no `getComputedStyle`) — safe to call per
 * material, per frame, or inside a `traverse`. Returns the fallbacks until
 * {@link refreshPalette} has run at least once.
 */
export function palette(): Readonly<Palette> {
  return _palette;
}

/** Convenience for the common single-key read. */
export function paletteColor(key: keyof Palette): number {
  return _palette[key];
}

/** Test-only reset so a case can start from a known state. */
export function resetPaletteForTest(): void {
  _palette = { ...PALETTE_FALLBACKS };
}
