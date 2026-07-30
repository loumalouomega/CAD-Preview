#!/usr/bin/env node
// Regenerates ../src/webview/opIcons.ts from svg-ops/*.svg (each produced by
// `make ops` from the matching tikz/*.tex — the same 46 sources the Edits
// panel's flat-color PNG previews used to come from, before this file wired
// them into the running extension instead — see icons/README.md). Pure Node,
// no LaTeX dependency: as long as svg-ops/*.svg is up to date (it's
// committed), this can be re-run standalone.
//
// Post-processing (currentColor/fill-opacity mapping) is shared with
// build-toolbar-icons.mjs via svgIconPostProcess.mjs — see that file for what
// it does and why.
//
// Unlike toolbarIcons.ts (a self-contained union type, since every toolbar
// icon id is only ever referenced from this generated file), opIcons.ts's ids
// must equal `PanelOpId` from opCatalog.ts exactly — that's the type
// `editsPanel.ts` actually indexes with, and `opCatalog.test.ts` cross-checks
// icon completeness against it. So this generator imports that type instead
// of declaring its own, and lets a missing/extra key surface as a `tsc`
// error (Record<PanelOpId, string> both directions) rather than a silent gap.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { postProcess } from "./svgIconPostProcess.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SVG_DIR = path.join(HERE, "svg-ops");
const OUT_FILE = path.join(HERE, "..", "src", "webview", "opIcons.ts");

const files = readdirSync(SVG_DIR).filter((f) => f.endsWith(".svg")).sort();
if (files.length === 0) {
  console.error(`No .svg files found in ${SVG_DIR} — run 'make ops' first.`);
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
 *   cd icons && make ops-ts
 * Source: icons/tikz/*.tex → icons/svg-ops/*.svg → icons/build-op-icons.mjs
 * See icons/README.md for the full pipeline and how to edit an icon's design.
 *
 * One icon per Edits-panel op button (\`PanelOpId\`, from opCatalog.ts).
 * Monochrome, theme-adaptive: each value is inline SVG markup using
 * \`currentColor\` (and \`currentColor\` + \`fill-opacity\` for shaded regions)
 * instead of hardcoded colors, so wrapping the icon in an element with a
 * \`color\` (VS Code already sets one on \`.op-btn\`) tints it automatically for
 * both light and dark themes — no separate light/dark assets needed. Set via
 * \`innerHTML\`, not \`textContent\` — see editsPanel.ts's \`buildTabContent()\`.
 */
import type { PanelOpId } from "./opCatalog";

`;

const recordBody = entries
  .map(([id, svg]) => `  ${id}: ${JSON.stringify(svg)},`)
  .join("\n");

const content =
  banner +
  `export const OP_ICONS: Record<PanelOpId, string> = {\n${recordBody}\n};\n`;

writeFileSync(OUT_FILE, content);
console.log(`Wrote ${path.relative(process.cwd(), OUT_FILE)} (${ids.length} icons)`);
