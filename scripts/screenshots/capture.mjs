/**
 * Playwright screenshot harness for the CAD-Preview docs.
 *
 * Loads the REAL webview bundle (`media/viewer.js` + `media/viewer.css`) into a
 * headless Chromium page, stubs `acquireVsCodeApi`, and posts the JSON message
 * fixtures produced by `make-fixtures.mjs` (genuine OCCT geometry + a real Gmsh
 * mesh) so the UI shows real content. It then drives each panel and writes one
 * PNG per feature to `doc/public/screenshots/`.
 *
 * Run `node scripts/screenshots/make-fixtures.mjs` first (the `docs:screenshots`
 * npm script chains build → fixtures → this). See scripts/screenshots/README.md.
 */
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";
// The server, harness page, Chromium flags and the load-bearing `populate()`
// ordering live in `harness.mjs`, shared with `../webview-test/run.mjs` — see
// that module's header for why this one is factored out when `mcp-smoke`/`perf`
// deliberately are not.
import { ROOT, LAUNCH_ARGS, fixture, sleep, startServer, openHarness, post, populate } from "./harness.mjs";

const OUT = path.join(ROOT, "doc", "public", "screenshots");
const IMAGES = path.join(ROOT, "images");

async function shoot(page, target, file) {
  const outPath = path.join(OUT, file);
  if (target.clip) {
    await page.screenshot({ path: outPath, clip: target.clip });
  } else if (target.sel) {
    await page.locator(target.sel).screenshot({ path: outPath });
  } else {
    await page.screenshot({ path: outPath, fullPage: false });
  }
  const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log(`  ✓ ${file} (${kb} KB)`);
}

// ── Shot list ────────────────────────────────────────────────────────────
const SHOTS = [
  {
    file: "viewer-main.png",
    setup: async (page) => { await populate(page); },
    target: {}, // full UI with model + panels
  },
  { file: "toolbar.png", setup: populate, target: { sel: "#toolbar" } },
  {
    file: "file-menu.png",
    setup: async (page) => { await populate(page); await page.click("#file-menu"); await sleep(150); },
    // Height must cover every item in the dropdown — it grew by one row when
    // "Export Silhouette SVG…" was added, and a too-short clip silently cuts
    // the last entry off rather than failing the run. Two more rows landed
    // with Import/Export DXF (285 → 342), and one more with Export Technical
    // Drawing (342 → 371).
    target: { clip: { x: 0, y: 0, width: 320, height: 371 } },
  },
  // The toolbar's four dropdowns. `clip` rather than `sel: "#toolbar"` — a
  // locator screenshot clips to the element box, which would cut off the
  // panel hanging below it. The toolbar is right-anchored in a 1360px
  // viewport, so the region below/left of its right edge covers every panel.
  ...["view", "select", "measure", "markup"].map((name) => ({
    file: `${name}-menu.png`,
    setup: async (page) => { await populate(page); await page.click(`#${name}-menu`); await sleep(150); },
    // Select menu grew two rows in Phase 1 of selection filters — the
    // shared clip must cover the tallest dropdown (now select-menu, not
    // view-menu). Silent-cut trap as before (file-menu.png 250→285, view-menu
    // 300→340). 400 then cut BOTH edges of view-menu after "Hide smooth
    // edges" + the layout picker + "Link cameras across tabs" landed: the
    // picker row made the panel wider (left-clipped at x=830) and the new
    // rows made it taller (Screenshot… half-cut at height 400) — now
    // x 830→770 / height 400→470.
    target: { clip: { x: 770, y: 30, width: 590, height: 470 } },
  })),
  { file: "view-controls.png", setup: populate, target: { sel: "#view-controls" } },
  { file: "components-tree.png", setup: populate, target: { sel: "#tree-panel" } },
  {
    // The Standard Parts panel talks to the real step.parts network API in
    // production — there's no WASM fixture for it, so this fakes one
    // realistic `standardPartsSearchResult` round trip (matching the
    // requestId the real search click generates) rather than leaving the
    // panel in its empty pre-search state.
    file: "standard-parts-panel.png",
    setup: async (page) => {
      await populate(page);
      await page.fill("#standard-parts-query", "hex bolt");
      await page.click("#standard-parts-search-btn");
      const requestId = await page.waitForFunction(() => {
        const req = (window.__sent || []).findLast((m) => m.type === "standardPartsSearchRequest");
        return req ? req.requestId : false;
      }).then((h) => h.jsonValue());
      await post(page, {
        type: "standardPartsSearchResult",
        requestId,
        items: [
          {
            id: "iso-4762-m6x20",
            name: "ISO 4762 Hex Socket Head Cap Screw M6x20",
            description: "Metric hex socket head cap screw, M6 thread, 20mm length, class 12.9 steel.",
            category: "Fasteners",
            standard: { body: "ISO", number: "4762", designation: "ISO 4762" },
          },
          {
            id: "din-931-m6x25",
            name: "DIN 931 Hex Head Bolt M6x25",
            description: "Partially threaded hexagon head bolt, M6 thread, 25mm length.",
            category: "Fasteners",
            standard: { body: "DIN", number: "931", designation: "DIN 931" },
          },
        ],
        page: 1,
        totalPages: 1,
        total: 2,
      });
      await sleep(200);
    },
    target: { sel: "#standard-parts-panel" },
  },
  {
    file: "parts-panel.png",
    setup: async (page) => {
      await populate(page);
      // Expand the first part row to reveal its assigned entities.
      const exp = page.locator("#parts-body .part-row .part-expand, #parts-body .part-row").first();
      try { await exp.click({ timeout: 1500 }); } catch { /* layout may vary */ }
      await sleep(200);
    },
    target: { sel: "#parts-panel" },
  },
  {
    file: "edits-geometry.png",
    setup: async (page) => {
      await populate(page);
      await page.locator(".edits-tab", { hasText: "Geometry" }).click();
      await page.locator(".edits-subtab", { hasText: "3D" }).click();
      await page.locator(".op-btn", { hasText: "Box" }).first().click();
      await sleep(250);
    },
    target: { sel: "#edits-panel" },
  },
  {
    file: "edits-edit.png",
    setup: async (page) => {
      await populate(page);
      await page.locator(".edits-tab", { hasText: "Edit" }).click();
      await sleep(200);
    },
    target: { sel: "#edits-panel" },
  },
  { file: "variables.png", setup: populate, target: { sel: "#variables-section" } },
  { file: "edit-history.png", setup: populate, target: { sel: "#edits-body" } },
  {
    file: "fe-mesh-panel.png",
    setup: populate,
    target: { sel: "#meshing-panel" },
  },
  {
    file: "fe-mesh-advanced.png",
    setup: async (page) => {
      await populate(page);
      await page.locator(".meshing-section-header", { hasText: "Advanced settings" }).click();
      await sleep(250);
    },
    target: { sel: "#meshing-panel" },
  },
  { file: "part-sizes.png", setup: populate, target: { sel: "#meshing-part-sizes" } },
  {
    file: "export-formats.png",
    setup: async (page) => {
      await populate(page);
      await page.evaluate(() => {
        const s = document.getElementById("meshing-export-format");
        s.size = Math.min(s.options.length, 8);
        s.style.width = "280px";
      });
      await sleep(150);
    },
    target: { sel: "#meshing-export-format" },
  },
  {
    file: "mesh-overlay.png",
    setup: async (page) => {
      await populate(page);
      await post(page, fixture("meshingResult"));
      await sleep(900);
    },
    target: {},
  },
  // --- Tutorial per-step shots (roadmap Tier 3 item 4) --------------------
  // Each posts its own cumulative-prefix geometry + tree with populate()'s
  // exact geometry → viewState(null) → sleep → tree → sleep ordering (the
  // viewState post is load-bearing for first-load framing). Full-page
  // targets avoid the fixed-clip silent-cut trap file-menu.png documents.
  ...[
    "tutorial-bracket-fused",
    "tutorial-bracket-done",
    "tutorial-flange-tools",
    "tutorial-flange-done",
    "tutorial-enclosure-sketch",
    "tutorial-enclosure-extruded",
    "tutorial-enclosure-done",
  ].map((name) => ({
    file: `${name}.png`,
    setup: async (page) => {
      await post(page, fixture(`${name}-geometry`));
      await post(page, { type: "viewState", view: null });
      await sleep(700);
      await post(page, fixture(`${name}-tree`));
      await sleep(700);
    },
    target: {},
  })),
  {
    file: "tutorial-fea-mesh.png",
    setup: async (page) => {
      await post(page, fixture("tutorial-bracket-done-geometry"));
      await post(page, { type: "viewState", view: null });
      await sleep(700);
      await post(page, fixture("tutorial-bracket-done-tree"));
      await sleep(700);
      await post(page, fixture("tutorial-fea-meshingResult"));
      await sleep(900);
    },
    target: {},
  },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`Harness server: ${base}`);

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });

  let failures = 0;
  for (const shot of SHOTS) {
    const page = await context.newPage();
    try {
      await openHarness(page, base);
      await shot.setup(page);
      await shoot(page, shot.target, shot.file);
    } catch (err) {
      failures++;
      console.error(`  ✗ ${shot.file}: ${err.message}`);
    } finally {
      await page.close();
    }
  }

  // Refresh the README hero images from the same real render.
  try {
    fs.mkdirSync(IMAGES, { recursive: true });
    fs.copyFileSync(path.join(OUT, "viewer-main.png"), path.join(IMAGES, "cad_preview.png"));
    fs.copyFileSync(path.join(OUT, "mesh-overlay.png"), path.join(IMAGES, "mesh_generation.png"));
    console.log("  ✓ refreshed images/cad_preview.png + images/mesh_generation.png");
  } catch (err) {
    console.error(`  ✗ hero refresh: ${err.message}`);
  }

  await browser.close();
  server.close();
  console.log(failures ? `Done with ${failures} failed shot(s).` : "All screenshots generated.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
