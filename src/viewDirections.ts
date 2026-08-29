/**
 * The named camera directions shared by snapshots and silhouette exports.
 *
 * Pure data plus pure lookups — no imports at all, so this can be pulled into
 * the extension host, the MCP server, or the webview bundle without dragging
 * anything else along.
 *
 * **Why this module exists rather than one big table in `svgSilhouette.ts`.**
 * `SVG_VIEWS` is consumed by TWO very different surfaces: `export_svg_silhouette`
 * (an agent-facing tool, which wants the full vocabulary) and `provider.ts`'s
 * Export Silhouette **QuickPick** (a user-facing menu, which wants a short
 * curated list). Growing that one table to 14 entries would silently turn an
 * 8-item menu into a 15-item one. So the full vocabulary lives here, and
 * `svgSilhouette.ts` keeps `SVG_VIEWS` as a curated subset *derived from* it —
 * the menu stays short and the two can never drift apart.
 *
 * Frame convention: **front = +Z, top = +Y, right = +X**. A `direction` points
 * from the target toward the camera, matching `Viewer.setViewDirection`.
 */

export type Vec3 = [number, number, number];

export interface NamedView {
  direction: Vec3;
  /** Required for a near-vertical direction, where the default up is parallel. */
  up?: Vec3;
}

/**
 * The full vocabulary: 6 cardinal views plus all 8 isometric octants, each
 * self-describing (`iso-ftr` = front-top-right).
 *
 * **The ±0.8 in the isometrics' Y is load-bearing, not a rounding.** Writing
 * these as `[±1, ±1, ±1]` — the natural thing to reach for — would change
 * `SVG_VIEWS.ISO` and therefore every silhouette SVG/DXF this repo emits, plus
 * `renderService.ts`'s two default isometrics. The value matches the
 * pre-existing `ISO`/`ISO-A` exactly so nothing shifts.
 */
export const NAMED_VIEWS: Readonly<Record<string, NamedView>> = Object.freeze({
  front: { direction: [0, 0, 1] },
  back: { direction: [0, 0, -1] },
  top: { direction: [0, 1, 0], up: [0, 0, -1] },
  bottom: { direction: [0, -1, 0], up: [0, 0, 1] },
  right: { direction: [1, 0, 0] },
  left: { direction: [-1, 0, 0] },
  "iso-ftr": { direction: [1, 0.8, 1] },
  "iso-ftl": { direction: [-1, 0.8, 1] },
  "iso-fbr": { direction: [1, -0.8, 1] },
  "iso-fbl": { direction: [-1, -0.8, 1] },
  "iso-btr": { direction: [1, 0.8, -1] },
  "iso-btl": { direction: [-1, 0.8, -1] },
  "iso-bbr": { direction: [1, -0.8, -1] },
  "iso-bbl": { direction: [-1, -0.8, -1] },
});

/**
 * Historical / convenience spellings.
 *
 * `iso` is what `export_svg_silhouette` has always accepted, and `iso-a`/`iso-b`
 * are `renderService.ts`'s two default isometric labels — all three must keep
 * resolving to the exact directions they always did.
 */
export const VIEW_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  iso: "iso-ftr",
  "iso-a": "iso-ftr",
  "iso-b": "iso-bbl",
});

/** Every canonical name, for error messages and menus. */
export const NAMED_VIEW_NAMES: readonly string[] = Object.keys(NAMED_VIEWS);

export interface ResolvedView {
  /** The canonical name, whatever spelling was asked for. */
  canonical: string;
  direction: Vec3;
  up?: Vec3;
}

/**
 * Resolves a view name, or `null` if it is not one.
 *
 * **Case-insensitive, and that is load-bearing**: the previous lookup was
 * `SVG_VIEWS[name.toUpperCase()]` against uppercase keys, while the canonical
 * keys here are lowercase. Without normalizing, an existing caller's
 * `view: "TOP"` would fall through to a fallback — invisible for `FRONT` and a
 * silently wrong image for everything else.
 */
export function resolveNamedView(name: string): ResolvedView | null {
  const key = name.trim().toLowerCase();
  const canonical = VIEW_ALIASES[key] ?? key;
  const view = NAMED_VIEWS[canonical];
  if (!view) return null;
  return { canonical, direction: [...view.direction] as Vec3, up: view.up ? ([...view.up] as Vec3) : undefined };
}

const DEG = Math.PI / 180;

/**
 * Orbits a direction by an azimuth (around `up`) and an elevation (toward it).
 *
 * For nudging the camera off a view you already have — the thing an agent wants
 * after spotting something in one image. Elevation is clamped just shy of the
 * poles, since at exactly ±90° the direction becomes parallel to `up` and the
 * camera basis collapses.
 */
export function orbitDirection(
  direction: Vec3,
  up: Vec3,
  azimuthDeg: number,
  elevationDeg: number
): { direction: Vec3; up: Vec3 } {
  const d = normalize(direction);
  const u = normalize(up);
  if (d === null || u === null) return { direction: [...direction] as Vec3, up: [...up] as Vec3 };

  // Right-handed basis around the view direction.
  const right = normalize(cross(u, d));
  if (right === null) {
    // `up` is parallel to the direction — no meaningful azimuth frame exists.
    return { direction: [...direction] as Vec3, up: [...up] as Vec3 };
  }
  const trueUp = cross(d, right);

  const az = azimuthDeg * DEG;
  const el = clamp(elevationDeg, -89, 89) * DEG;

  // Spherical offset expressed in the (right, trueUp, d) basis.
  const x = Math.cos(el) * Math.sin(az);
  const y = Math.sin(el);
  const z = Math.cos(el) * Math.cos(az);

  const out: Vec3 = [
    right[0] * x + trueUp[0] * y + d[0] * z,
    right[1] * x + trueUp[1] * y + d[1] * z,
    right[2] * x + trueUp[2] * y + d[2] * z,
  ];
  return { direction: normalize(out) ?? d, up: [...up] as Vec3 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(len) || len < 1e-12) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}
