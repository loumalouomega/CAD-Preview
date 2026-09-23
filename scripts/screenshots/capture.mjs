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
import { ROOT, LAUNCH_ARGS, fixture, sleep, startServer, openHarness, post, postMeshingResult, populate } from "./harness.mjs";

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

/**
 * The two hero shots show the document chip and the status bar's kernel
 * readiness, which the shared `populate()` deliberately does not post (the
 * webview tests assert the chip is NOT rendered before its first message). The
 * values are what a real session of this fixture would show: `bull.stp` opened
 * with its three sidecar edits unsaved, OCCT having loaded it and — once a mesh
 * exists — Gmsh having generated one.
 */
async function heroChrome(page, { gmsh }) {
  await post(page, { type: "documentInfo", name: "bull.stp", path: "/work/bull.stp", format: "step", dirty: true, unsavedEdits: 3 });
  await post(page, {
    type: "kernelStatus",
    state: { occt: "ready", gmsh: gmsh ? "ready" : "idle", meshio: "idle", ftetwild: "idle" },
  });
  // The same library the fe-mesh-panel shot posts, so the Preset picker reads
  // like a session that has the built-in starters rather than the pre-hydration
  // placeholder. Display only: nothing is applied or written.
  await post(page, {
    type: "meshingPresets",
    presets: [
      { name: "balanced", description: null, unit: "mm", engine: "gmsh", readOnly: true },
      { name: "my-coarse", description: "Shop preset", unit: "mm", engine: "gmsh" },
    ],
  });
  await sleep(150);
}

/**
 * Sum of triangle areas for one face of the fixture geometry, in the fixture's
 * own units — what a real `entityFactsResult` would report for a planar face
 * (exact for a plane, which is the only kind the hero shot asks about).
 */
function fixtureFaceArea(faceId) {
  const geo = fixture("geometry");
  const mesh = geo.meshes.find((m) => m.faceId === faceId);
  if (!mesh) return null;
  // Copy out of the Buffer: a small Buffer's `.buffer` is the process-wide 8KB
  // pool, so viewing it directly reads unrelated bytes (and a non-4-aligned
  // offset throws) — the same trap gltfParser.ts documents.
  const bytes = (b64) => {
    const b = Buffer.from(b64, "base64");
    return new Uint8Array(b).buffer;
  };
  const pos = new Float32Array(bytes(mesh.positions));
  const idx = new Uint32Array(bytes(mesh.indices));
  let area = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map((i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cx = u[1] * v[2] - u[2] * v[1];
    const cy = u[2] * v[0] - u[0] * v[2];
    const cz = u[0] * v[1] - u[1] * v[0];
    area += 0.5 * Math.hypot(cx, cy, cz);
  }
  return area;
}

/**
 * Stages the main hero shot like the design mockup: Edits collapsed, and a face
 * selected so the selection pill shows. Harness-only — nothing here is persisted.
 * The pill is driven the way a real session drives it: a genuine click on the
 * canvas posts a real `entityFactsRequest`, and the reply carries that request's
 * own id and the picked face's own area (summed from the fixture triangles), so
 * the picture is the real card with real numbers, not a mock-up.
 */
async function heroSelection(page) {
  await page.click("#edits-header > .panel-chevron");
  await page.click("#select-menu");
  await page.click("#sel-toggle");
  await page.click('.sel-mode[data-mode="surface"]');
  await page.click("#select-menu"); // close it, so the next canvas click is a pick
  await sleep(150);
  const box = await page.locator("#app").boundingBox();
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await sleep(300);
  const req = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "entityFactsRequest").at(-1) ?? null);
  if (!req) throw new Error("heroSelection: the click did not select a face (no entityFactsRequest)");
  const area = fixtureFaceArea(req.entityId);
  await post(page, {
    type: "entityFactsResult",
    requestId: req.requestId,
    facts: {
      entityId: req.entityId, kind: "face",
      bbox: { min: [0, 0, 0], max: [1, 1, 0], diagonal: Math.SQRT2 },
      center: [0, 0, 0], area, length: null,
      normal: [0, 0, 1], planeOrigin: [0, 0, 0], surfaceType: "plane",
      surfaceParams: { kind: "plane", origin: [0, 0, 0], normal: [0, 0, 1] }, curveType: null,
    },
  });
  // The pointer is still over the model, so the readout in the status bar keeps
  // showing (as in the mockup), but the hover tooltip that follows a pick mode would
  // sit on top of the orientation cube — drop just that.
  await page.evaluate(() => document.getElementById("hover-tip")?.classList.add("hidden"));
  await sleep(200);
}

// ── Shot list ────────────────────────────────────────────────────────────
const SHOTS = [
  {
    file: "viewer-main.png",
    setup: async (page) => {
      await populate(page);
      await heroChrome(page, { gmsh: false });
      await heroSelection(page);
    },
    target: {}, // full UI with model + panels
  },
  { file: "toolbar.png", setup: populate, target: { sel: "#toolbar" } },
  {
    file: "file-menu.png",
    setup: async (page) => { await populate(page); await page.click("#file-menu"); await sleep(150); },
    // Height must cover every item in the dropdown — it grew by one row when
    // "Export Silhouette SVG…" was added, and a too-short clip silently cuts
    // the last entry off rather than failing the run. Two more rows landed
    // with Import/Export DXF (285 → 342), one more with Export Technical
    // Drawing (342 → 371), and one more plus a separator with New Blank Model
    // (371 → 410), and one more with Export Drawing Sheet (410 → 439).
    target: { clip: { x: 0, y: 0, width: 320, height: 439 } },
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
    // x 830→770 / height 400→470 — plus one more row for Zoom to selection
    // (470→500). The trigger chevrons became icons (chrome redesign, pass 3),
    // which widened the toolbar and pushed the View panel's left edge to
    // x=766.9 — the clip went 770→750.
    target: { clip: { x: 750, y: 30, width: 610, height: 500 } },
  })),
  { file: "view-controls.png", setup: populate, target: { sel: "#view-controls" } },
  {
    // The "⋯" overflow popover. It hangs ABOVE the dock and outside the dock's own
    // box, so `sel: "#view-controls"` would crop it away entirely — hence a fixed
    // `clip`, with the usual silent-cut hazard (a popover that grows just gets
    // cut off and the run still prints ✓). `webview-test/run.mjs` mirrors this
    // rectangle in "chrome: the overflow popover fits its screenshot clip", so
    // growing it fails a test instead. The dock is bottom-centred over the canvas
    // in a 1360x900 viewport and the popover is right-anchored to the "⋯" at its
    // end, so this covers the popover and the dock row beneath it.
    file: "view-controls-more.png",
    setup: async (page) => {
      await populate(page);
      await page.click("#vc-more");
      await sleep(200);
    },
    target: { clip: { x: 630, y: 470, width: 680, height: 430 } },
  },
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
      // Standard Parts lives inside the Advanced group, which ships collapsed
      // — without opening it the field is in a `display: none` subtree and
      // the fill below waits out its timeout.
      await page.click("#advanced-header > .panel-chevron");
      await page.waitForSelector("#standard-parts-query", { state: "visible" });
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
      // One inline thumbnail (a 1px PNG data URL — the host would fetch the
      // real `pngUrl` and pipe it as `data:`), so the shot shows the
      // thumbnail layout, not just the text fallback.
      await post(page, {
        type: "standardPartsThumbsResult",
        searchId: requestId,
        thumbs: [
          {
            id: "iso-4762-m6x20",
            dataUrl:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          },
        ],
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
    setup: async (page) => {
      await populate(page);
      // The Saved-presets picker starts as a placeholder until the host posts
      // the merged library — post one bundled starter + one user preset so
      // the shot documents the populated picker, not the pre-hydration state.
      await post(page, {
        type: "meshingPresets",
        presets: [
          { name: "balanced", description: null, unit: "mm", engine: "gmsh", readOnly: true },
          { name: "my-coarse", description: "Shop preset", unit: "mm", engine: "gmsh" },
        ],
      });
      // FE Mesh is height-capped (45%) while Edits is expanded, which scrolls
      // its last row (the Handoff manifest checkbox) out of the element shot.
      // Collapsing Edits relaxes the cap to 70%, the hero shot's own staging.
      await page.click("#edits-header > .panel-chevron");
      await sleep(250);
    },
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
  {
    file: "part-sizes.png",
    setup: async (page) => {
      await populate(page);
      // Reveal one part's grading band — the row starts collapsed by design
      // (see meshingPanel.ts's renderParts) so a document with a band set
      // doesn't grow the sidebar past its overflow:hidden squeeze point on
      // load; click it open here so the shot documents the feature.
      await page.locator(".meshing-part-grade-toggle.active").first().click();
      await sleep(150);
    },
    target: { sel: "#meshing-part-sizes" },
  },
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
      await postMeshingResult(page);
      await heroChrome(page, { gmsh: true });
      await sleep(900);
    },
    target: {},
  },
  // --- Tutorial per-step shots (the "per-step tutorial screenshots" feature)
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
