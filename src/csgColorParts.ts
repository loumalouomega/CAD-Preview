/**
 * OpenSCAD `color()` → Parts (roadmap "OpenSCAD `color()` and top-level
 * objects become Parts"). Pure and OCCT-free so it runs identically in the
 * kernel worker (`csgModel.ts` calls {@link parseCsgColor} while walking the
 * tree), the extension host (`provider.ts`) and the headless MCP server
 * (`mcpTools.ts`'s `load_model`) — the `meshioRegionParts.ts` precedent.
 *
 * What a colour group is: the `solid-N` ids (the base shape's own numbering,
 * i.e. what `collectSolids` assigns) of every top-level solid whose nearest
 * enclosing `color()` has that colour. Solids with no enclosing `color()`
 * belong to no group — inventing a "default" Part for them would make Parts
 * appear that the model never asked for.
 *
 * `.csg` carries NO module names (OpenSCAD evaluates modules away before
 * writing it), so a Part cannot be named after one; the name is derived from
 * the colour, and says so rather than pretending otherwise.
 */

import type { CsgValue } from "./csgImport";
import type { Part } from "./protocol";

/** One colour and the base-shape solids carrying it. `color` is lowercase `#rrggbb`. */
export interface CsgColorGroup {
  color: string;
  solidIds: string[];
}

/**
 * CSS/X11 names OpenSCAD accepts that are cheap to carry: the sixteen basic
 * colours plus a few common extras. A real `.csg` export always writes the
 * numeric `[r, g, b, a]` vector (named colours are resolved by OpenSCAD before
 * export), so this table only matters for a hand-written file — an unknown
 * name degrades to "no colour, with a warning", never a guess.
 */
const NAMED_COLORS: ReadonlyArray<readonly [string, string]> = [
  ["black", "#000000"],
  ["silver", "#c0c0c0"],
  ["gray", "#808080"],
  ["white", "#ffffff"],
  ["maroon", "#800000"],
  ["red", "#ff0000"],
  ["purple", "#800080"],
  ["fuchsia", "#ff00ff"],
  ["green", "#008000"],
  ["lime", "#00ff00"],
  ["olive", "#808000"],
  ["yellow", "#ffff00"],
  ["navy", "#000080"],
  ["blue", "#0000ff"],
  ["teal", "#008080"],
  ["aqua", "#00ffff"],
  ["orange", "#ffa500"],
  ["pink", "#ffc0cb"],
  ["brown", "#a52a2a"],
  ["gold", "#ffd700"],
];
/** Spellings that map onto an entry above without becoming that entry's display name. */
const COLOR_ALIASES: Readonly<Record<string, string>> = { grey: "gray", cyan: "aqua", magenta: "fuchsia" };

const NAME_TO_HEX = new Map<string, string>(NAMED_COLORS);
const HEX_TO_NAME = new Map<string, string>(NAMED_COLORS.map(([n, h]) => [h, n]));

function byte(v: number): string {
  return Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
}

/**
 * The colour a `color(...)` node carries, as `#rrggbb` (alpha dropped — the
 * viewer has no per-Part transparency), or a reason it could not be read.
 * Accepts the forms OpenSCAD does: a `[r,g,b(,a)]` vector in 0..1 (positional
 * or `c=`), a `"#rgb"`/`"#rrggbb"`/`"#rrggbbaa"` string, or a known name.
 * `color()` with no argument yields `{}` (no colour, no warning to give).
 */
export function parseCsgColor(params: Record<string, CsgValue>): { hex?: string; warning?: string } {
  const v = params["#0"] ?? params["c"];
  if (v === undefined || v === null) return {};
  if (Array.isArray(v)) {
    if ((v.length === 3 || v.length === 4) && v.every((x) => typeof x === "number" && Number.isFinite(x))) {
      return { hex: `#${byte(v[0])}${byte(v[1])}${byte(v[2])}` };
    }
    return { warning: `color() vector ${JSON.stringify(v)} is not [r, g, b] or [r, g, b, a] — colour ignored` };
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
    if (m) {
      const h = m[1];
      if (h.length === 3) return { hex: `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` };
      return { hex: `#${h.slice(0, 6)}` };
    }
    const hex = NAME_TO_HEX.get(COLOR_ALIASES[s] ?? s);
    if (hex) return { hex };
    return { warning: `color("${v}") is not a hex value or a name this importer knows — colour ignored` };
  }
  return { warning: `color() argument ${JSON.stringify(v)} is not a colour — colour ignored` };
}

/** `"red"` for a colour with a known name, else the `#rrggbb` itself. */
export function csgColorName(hex: string): string {
  return HEX_TO_NAME.get(hex.toLowerCase()) ?? hex.toLowerCase();
}

/**
 * One Part per colour group (first-appearance order), named `"Part <colour>"`
 * and coloured with it, listing the group's solids as `volumes`. Pure — the
 * caller decides whether to persist (only into an empty parts sidecar).
 */
export function buildPartsFromCsgColors(groups: readonly CsgColorGroup[]): Part[] {
  const parts: Part[] = [];
  for (const g of groups) {
    if (g.solidIds.length === 0) continue;
    parts.push({
      name: `Part ${csgColorName(g.color)}`,
      color: g.color.toLowerCase(),
      volumes: [...g.solidIds],
      surfaces: [],
      lines: [],
      points: [],
    });
  }
  return parts;
}

/** The warning `load_model`/the panel attach when Parts were created, stating the naming limit plainly. */
export function csgColorPartsNote(count: number): string {
  return `Created ${count} Part(s) from color() — one per distinct colour. A .csg carries no module names, so Parts are named after the colour; solids outside any color() have no Part.`;
}
