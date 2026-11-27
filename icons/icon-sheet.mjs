#!/usr/bin/env node
/**
 * Icon contact sheet & pixel validation (roadmap 1.11).
 *
 * Renders every icon from `src/webview/opIcons.ts`, `src/toolbarIcons.ts`, and
 * `src/uiGlyphs.ts` at 14, 16, and 24 px across all four VS Code themes (dark,
 * light, high-contrast dark, high-contrast light) in headless Chromium, writes
 * `icons/icon-sheet.png`, and exits non-zero when:
 *   - any id named by `opCatalog.ts`, `ribbon.ts`, or `viewerDom.ts` has no icon
 *   - any icon rasterises blank or below the lit-pixel threshold at 14 px on any theme
 *   - any two icons in the same set render identically
 *
 * An icon touching the outer 1 px ring at 24 px is reported as a warning.
 * Runs without LaTeX.
 *
 * Usage:
 *   node icons/icon-sheet.mjs [--out <path>] [--no-write | --check] [--blank <set:id>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import * as esbuild from "esbuild";
import { LAUNCH_ARGS, MIN_NODE_MAJOR_FOR_PLAYWRIGHT, nodeSupportsPlaywright } from "../scripts/screenshots/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_OUT = path.join(HERE, "icon-sheet.png");

const SIZES = [14, 16, 24];
const THEMES = [
  { id: "dark", label: "Dark", bodyClass: "", bg: "#1e1e1e", fg: "#cccccc", accent: "#0e639c" },
  { id: "light", label: "Light", bodyClass: "vscode-light", bg: "#f3f3f3", fg: "#3b3b3b", accent: "#007acc" },
  { id: "hc-dark", label: "HC Dark", bodyClass: "vscode-high-contrast", bg: "#000000", fg: "#ffffff", accent: "currentColor" },
  { id: "hc-light", label: "HC Light", bodyClass: "vscode-high-contrast vscode-high-contrast-light", bg: "#ffffff", fg: "#000000", accent: "currentColor" },
];

// Minimum lit pixels at 14×14 (out of 196) for an icon to be considered visible.
const MIN_LIT_PIXELS_14 = 4;
// Channel delta from theme background to count a pixel as lit (0..255).
const LIT_THRESHOLD = 16;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Minimal 8-bit RGB/RGBA PNG decoder using Node's built-in zlib. */
function decodePng(buf) {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIG[i]) throw new Error("Not a PNG buffer");
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idats = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idats.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * bpp;
  const pixels = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);

  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  let inPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[inPos++];
    for (let i = 0; i < stride; i++) {
      const x = raw[inPos++];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = x;
      if (filter === 1) v = (x + a) & 255;
      else if (filter === 2) v = (x + b) & 255;
      else if (filter === 3) v = (x + ((a + b) >> 1)) & 255;
      else if (filter === 4) v = (x + paeth(a, b, c)) & 255;
      cur[i] = v;
    }
    const rowOut = y * width * 4;
    for (let x = 0; x < width; x++) {
      pixels[rowOut + x * 4] = cur[x * bpp];
      pixels[rowOut + x * 4 + 1] = cur[x * bpp + 1];
      pixels[rowOut + x * 4 + 2] = cur[x * bpp + 2];
      pixels[rowOut + x * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev.set(cur);
  }
  return { width, height, pixels };
}

/** Bundles the TS icon modules in-memory with esbuild so this script needs no build step. */
async function loadIconData() {
  const result = await esbuild.build({
    stdin: {
      contents: `
        export { TOOLBAR_ICONS } from "./src/toolbarIcons";
        export { OP_ICONS } from "./src/webview/opIcons";
        export { UI_GLYPHS } from "./src/uiGlyphs";
        export { allCatalogEntries } from "./src/webview/opCatalog";
        export { allRibbonItems } from "./src/webview/ribbon";
      `,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    external: ["vscode"],
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return mod;
}

/** Extracts icon("...") and glyph("...") ids referenced in src/viewerDom.ts. */
function scanViewerDomIds() {
  const src = fs.readFileSync(path.join(ROOT, "src", "viewerDom.ts"), "utf8");
  const toolbarIds = new Set();
  const glyphIds = new Set();
  for (const m of src.matchAll(/\bicon\(\s*"([^"]+)"\s*\)/g)) toolbarIds.add(m[1]);
  for (const m of src.matchAll(/\bglyph\(\s*"([^"]+)"\s*\)/g)) glyphIds.add(m[1]);
  return { toolbarIds, glyphIds };
}

function buildHtml(sets) {
  const sectionsHtml = sets.map((set) => {
    const rowsHtml = set.entries.map(([id, svg]) => {
      const cellsHtml = THEMES.map((theme) => {
        const sizeCells = SIZES.map((size) => `
          <div class="cell-wrap" style="background:${theme.bg};color:${theme.fg};--ui-icon-accent:${theme.accent};">
            <div class="svg-box" data-set="${set.key}" data-id="${id}" data-theme="${theme.id}" data-size="${size}" style="width:${size}px;height:${size}px;">${svg}</div>
          </div>
        `).join("");
        return `<div class="theme-group ${theme.bodyClass}">${sizeCells}</div>`;
      }).join("");
      return `<div class="icon-row"><div class="icon-label">${id}</div>${cellsHtml}</div>`;
    }).join("");

    return `
      <section class="icon-section">
        <h2>${set.title} (${set.entries.length})</h2>
        <div class="col-headers">
          <div class="icon-label">id</div>
          ${THEMES.map((t) => `<div class="theme-header">${t.label} (14 · 16 · 24)</div>`).join("")}
        </div>
        ${rowsHtml}
      </section>
    `;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px;
    background: #141416;
    color: #e4e4e7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 12px;
  }
  h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
  .subtitle { margin: 0 0 18px; color: #a1a1aa; font-size: 12px; }
  .icon-section { margin-bottom: 24px; }
  h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600; color: #f4f4f5; border-bottom: 1px solid #27272a; padding-bottom: 4px; }
  .col-headers, .icon-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    border-bottom: 1px solid #1f1f23;
  }
  .col-headers { font-weight: 600; color: #a1a1aa; font-size: 11px; border-bottom-color: #3f3f46; }
  .icon-label { width: 190px; flex-shrink: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .theme-header { width: 108px; flex-shrink: 0; text-align: center; }
  .theme-group { display: flex; align-items: center; gap: 4px; width: 108px; flex-shrink: 0; justify-content: center; }
  .cell-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    border-radius: 3px;
  }
  .svg-box { display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .svg-box svg { width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
  <h1>CAD-Preview Icon Contact Sheet</h1>
  <p class="subtitle">All icons at 14, 16, and 24 px across Dark, Light, High Contrast Dark, and High Contrast Light themes.</p>
  ${sectionsHtml}
</body>
</html>`;
}

export async function runIconSheet(options = {}) {
  const write = options.write ?? true;
  const outPath = options.outPath ?? DEFAULT_OUT;
  const blankTarget = options.blank ?? null; // e.g. "op:fillet"

  if (!nodeSupportsPlaywright()) {
    throw new Error(`Node >= ${MIN_NODE_MAJOR_FOR_PLAYWRIGHT} is required for Playwright`);
  }

  const { TOOLBAR_ICONS, OP_ICONS, UI_GLYPHS, allCatalogEntries, allRibbonItems } = await loadIconData();
  const opIcons = { ...OP_ICONS };
  const toolbarIcons = { ...TOOLBAR_ICONS };
  const uiGlyphs = { ...UI_GLYPHS };

  if (blankTarget) {
    const [setKey, iconId] = blankTarget.split(":");
    const blankSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>';
    if (setKey === "op" && iconId in opIcons) opIcons[iconId] = blankSvg;
    else if (setKey === "toolbar" && iconId in toolbarIcons) toolbarIcons[iconId] = blankSvg;
    else if (setKey === "glyph" && iconId in uiGlyphs) uiGlyphs[iconId] = blankSvg;
    else throw new Error(`Unknown --blank target: ${blankTarget}`);
  }

  const errors = [];
  const warnings = [];

  // 1. Completeness checks against opCatalog.ts, ribbon.ts, and viewerDom.ts.
  for (const entry of allCatalogEntries()) {
    if (!opIcons[entry.id] || !opIcons[entry.id].includes("<svg")) {
      errors.push(`Missing op icon for opCatalog entry "${entry.id}"`);
    }
  }
  for (const { item } of allRibbonItems()) {
    if (item.icon.kind === "op" && !opIcons[item.icon.id]) {
      errors.push(`Missing op icon "${item.icon.id}" referenced by ribbon item "${item.id}"`);
    } else if (item.icon.kind === "toolbar" && !toolbarIcons[item.icon.id]) {
      errors.push(`Missing toolbar icon "${item.icon.id}" referenced by ribbon item "${item.id}"`);
    } else if (item.icon.kind === "glyph" && !uiGlyphs[item.icon.id]) {
      errors.push(`Missing UI glyph "${item.icon.id}" referenced by ribbon item "${item.id}"`);
    }
  }
  const domIds = scanViewerDomIds();
  for (const id of domIds.toolbarIds) {
    if (!toolbarIcons[id]) errors.push(`Missing toolbar icon "${id}" referenced in src/viewerDom.ts`);
  }
  for (const id of domIds.glyphIds) {
    if (!uiGlyphs[id]) errors.push(`Missing UI glyph "${id}" referenced in src/viewerDom.ts`);
  }

  const sets = [
    { key: "op", title: "OP_ICONS (Edits panel & Model ribbon)", entries: Object.entries(opIcons).sort(([a], [b]) => a.localeCompare(b)) },
    { key: "toolbar", title: "TOOLBAR_ICONS (Toolbar & menus)", entries: Object.entries(toolbarIcons).sort(([a], [b]) => a.localeCompare(b)) },
    { key: "glyph", title: "UI_GLYPHS (Sidebar, status & dock chrome)", entries: Object.entries(uiGlyphs).sort(([a], [b]) => a.localeCompare(b)) },
  ];

  // 2. Render in headless Chromium.
  const { chromium } = await import("playwright");
  const execPath = process.env.PLAYWRIGHT_CHROMIUM_PATH || (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
  const browser = await chromium.launch({
    headless: true,
    args: LAUNCH_ARGS,
    ...(execPath ? { executablePath: execPath } : {}),
  });

  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.setContent(buildHtml(sets), { waitUntil: "load" });
    await page.evaluate(() => document.fonts?.ready);

    const boxes = await page.evaluate(() => {
      return [...document.querySelectorAll(".svg-box")].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          set: el.dataset.set,
          id: el.dataset.id,
          theme: el.dataset.theme,
          size: Number(el.dataset.size),
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      });
    });

    const pngBuf = await page.screenshot({ fullPage: true });
    if (write) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, pngBuf);
    }

    const { width, pixels } = decodePng(pngBuf);
    const themeBg = Object.fromEntries(THEMES.map((t) => [t.id, hexToRgb(t.bg)]));
    const signaturesBySet = new Map(); // set -> Map<signature, id[]>

    for (const box of boxes) {
      const [bgR, bgG, bgB] = themeBg[box.theme];
      let lit = 0;
      let touchesRing = false;
      const sigBytes = box.size === 24 && box.theme === "dark" ? new Uint8Array(box.w * box.h) : null;

      for (let dy = 0; dy < box.h; dy++) {
        for (let dx = 0; dx < box.w; dx++) {
          const idx = ((box.y + dy) * width + (box.x + dx)) * 4;
          const dr = Math.abs(pixels[idx] - bgR);
          const dg = Math.abs(pixels[idx + 1] - bgG);
          const db = Math.abs(pixels[idx + 2] - bgB);
          const delta = Math.max(dr, dg, db);
          if (delta >= LIT_THRESHOLD) {
            lit++;
            if (dx === 0 || dy === 0 || dx === box.w - 1 || dy === box.h - 1) {
              touchesRing = true;
            }
          }
          if (sigBytes) {
            // Quantize to 16-level delta so identical renders match cleanly.
            sigBytes[dy * box.w + dx] = delta >> 4;
          }
        }
      }

      if (box.size === 14) {
        if (lit === 0) {
          errors.push(`Blank icon at 14px on ${box.theme}: ${box.set}:${box.id}`);
        } else if (lit < MIN_LIT_PIXELS_14) {
          errors.push(`Below lit-pixel threshold (${lit} < ${MIN_LIT_PIXELS_14}) at 14px on ${box.theme}: ${box.set}:${box.id}`);
        }
      }

      if (box.size === 24 && box.theme === "dark") {
        if (touchesRing) {
          warnings.push(`Touches outer pixel ring at 24px: ${box.set}:${box.id}`);
        }
        if (sigBytes) {
          const sig = Buffer.from(sigBytes).toString("base64");
          if (!signaturesBySet.has(box.set)) signaturesBySet.set(box.set, new Map());
          const setMap = signaturesBySet.get(box.set);
          if (!setMap.has(sig)) setMap.set(sig, []);
          setMap.get(sig).push(box.id);
        }
      }
    }

    for (const [setKey, sigMap] of signaturesBySet) {
      for (const ids of sigMap.values()) {
        if (ids.length > 1) {
          errors.push(`Identical rendered icons in ${setKey}: ${ids.join(", ")}`);
        }
      }
    }

    const totalIcons = sets.reduce((acc, s) => acc + s.entries.length, 0);
    return { totalIcons, errors, warnings, outPath: write ? outPath : null };
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let outPath = DEFAULT_OUT;
  let write = true;
  let blank = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--no-write" || args[i] === "--check") write = false;
    else if (args[i] === "--out" && args[i + 1]) outPath = path.resolve(args[++i]);
    else if (args[i] === "--blank" && args[i + 1]) blank = args[++i];
  }

  runIconSheet({ outPath, write, blank }).then(
    ({ totalIcons, errors, warnings, outPath: written }) => {
      console.log(`icon-sheet: checked ${totalIcons} icons across ${THEMES.length} themes × ${SIZES.length} sizes${written ? ` -> ${path.relative(ROOT, written)}` : ""}`);
      if (warnings.length > 0) {
        console.warn(`icon-sheet: ${warnings.length} warning(s) (outer pixel ring at 24px):`);
        for (const w of warnings) console.warn(`  ! ${w}`);
      }
      if (errors.length > 0) {
        console.error(`icon-sheet: ${errors.length} error(s):`);
        for (const e of errors) console.error(`  ✗ ${e}`);
        process.exit(1);
      }
    },
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
