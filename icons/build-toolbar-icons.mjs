#!/usr/bin/env node
// Regenerates ../src/toolbarIcons.ts from svg-ui/*.svg (each produced by
// `make ui` from the matching tikz-ui/*.tex — see icons/README.md). Pure
// Node, no LaTeX dependency: as long as svg-ui/*.svg is up to date (it's
// committed), this can be re-run standalone.
//
// Post-processing (currentColor/fill-opacity mapping) is shared with
// build-op-icons.mjs via svgIconPostProcess.mjs — see that file for what it
// does and why.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { postProcess } from "./svgIconPostProcess.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SVG_DIR = path.join(HERE, "svg-ui");
const OUT_FILE = path.join(HERE, "..", "src", "toolbarIcons.ts");

const files = readdirSync(SVG_DIR).filter((f) => f.endsWith(".svg")).sort();
if (files.length === 0) {
  console.error(`No .svg files found in ${SVG_DIR} — run 'make ui' first.`);
  process.exit(1);
}

const ids = files.map((f) => f.replace(/\.svg$/, ""));
const entries = files.map((f) => {
  const id = f.replace(/\.svg$/, "");
  const raw = readFileSync(path.join(SVG_DIR, f), "utf8");
  return [id, postProcess(raw)];
});

const banner = `/**
 * GENERATED FILE — do not hand-edit. Regenerate with:
 *   cd icons && make ts
 * Source: icons/tikz-ui/*.tex → icons/svg-ui/*.svg → icons/build-toolbar-icons.mjs
 * See icons/README.md for the full pipeline and how to edit an icon's design.
 *
 * Monochrome, theme-adaptive toolbar/panel icons: each value is inline SVG
 * markup using \`currentColor\` (and \`currentColor\` + \`fill-opacity\` for
 * shaded regions) instead of hardcoded colors, so wrapping the icon in an
 * element with a \`color\` (VS Code already sets one on toolbar buttons) tints
 * it automatically for both light and dark themes — no separate light/dark
 * assets needed.
 */
`;

const typeDecl = `export type ToolbarIconId =\n  | ${ids.map((id) => `"${id}"`).join("\n  | ")};\n\n`;

const recordBody = entries
  .map(([id, svg]) => `  ${id}: ${JSON.stringify(svg)},`)
  .join("\n");

const content =
  banner +
  typeDecl +
  `export const TOOLBAR_ICONS: Record<ToolbarIconId, string> = {\n${recordBody}\n};\n`;

writeFileSync(OUT_FILE, content);
console.log(`Wrote ${path.relative(process.cwd(), OUT_FILE)} (${ids.length} icons)`);
