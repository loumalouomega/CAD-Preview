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
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const FIX = path.join(HERE, "fixtures");
const OUT = path.join(ROOT, "doc", "public", "screenshots");
const IMAGES = path.join(ROOT, "images");

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), "utf8"));

// ── Tiny static server: serves the repo tree + a generated harness page ────
const CTYPE = {
  ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm",
  ".json": "application/json", ".map": "application/json", ".html": "text/html",
  ".stl": "model/stl", ".obj": "text/plain", ".ply": "application/octet-stream",
  ".gltf": "model/gltf+json", ".glb": "model/gltf-binary", ".svg": "image/svg+xml",
};

function harnessHtml() {
  const body = fs.readFileSync(path.join(FIX, "body.html"), "utf8");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<link rel="stylesheet" href="/media/viewer.css" />
<style>
  /* Polish over viewer.css's built-in --vscode-* fallbacks: a VS Code Dark+ feel. */
  :root {
    --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Ubuntu", sans-serif;
    --vscode-foreground: #cccccc;
    --vscode-sideBar-background: #252526;
    --vscode-editorWidget-background: #252526;
    --vscode-button-background: #0e639c;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #1177bb;
    --vscode-focusBorder: #007fd4;
    --vscode-input-background: #3c3c3c;
    --vscode-input-foreground: #cccccc;
    --vscode-input-border: #3c3c3c;
    --vscode-list-activeSelectionBackground: #094771;
    --vscode-list-hoverBackground: rgba(255,255,255,0.06);
  }
  html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; background: #1e1e1e; }
</style></head><body>
<script>
  window.acquireVsCodeApi = function () {
    return { postMessage: function (m) { (window.__sent = window.__sent || []).push(m); },
             getState: function () {}, setState: function () {} };
  };
  window.__post = function (m) { window.postMessage(m, "*"); };
</script>
${body}
<script src="/media/viewer.js"></script>
</body></html>`;
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split("?")[0]);
      if (url === "/__harness") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(harnessHtml());
        return;
      }
      const filePath = path.join(ROOT, path.normalize(url));
      if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404); res.end("not found"); return;
      }
      res.writeHead(200, { "Content-Type": CTYPE[path.extname(filePath)] ?? "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ── Page helpers ───────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openHarness(page, base) {
  await page.goto(`${base}/__harness`, { waitUntil: "load" });
  // Wait until the webview finished setup (it posts a `ready` message).
  await page.waitForFunction(() => window.__sent && window.__sent.some((m) => m.type === "ready"), null, { timeout: 20000 });
  await page.waitForSelector("#app canvas", { timeout: 20000 });
}

const post = (page, msg) => page.evaluate((m) => window.__post(m), msg);

/** Post the full set of fixtures so every panel is populated, then settle. */
async function populate(page) {
  await post(page, fixture("geometry"));
  // The webview only frames the camera on first load once BOTH geometry and
  // a "viewState" message have arrived (`main.ts`'s `applyInitialViewIfNeeded`,
  // added by the "View-state persistence" feature — real documents always get
  // a real viewState post from provider.ts, even `{view: null}` for a
  // document with no persisted view yet, so this harness must send the same
  // to avoid leaving the camera at its unframed default position). Without
  // this, every shot renders a giant, wildly misframed close-up instead of
  // the actual model.
  await post(page, { type: "viewState", view: null });
  await sleep(700); // OCCT geometry decode + first frame
  await post(page, fixture("tree"));
  await post(page, fixture("meshingOptions"));
  await post(page, fixture("parts"));
  await post(page, fixture("edits"));
  await sleep(700);
}

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
    // the last entry off rather than failing the run.
    target: { clip: { x: 0, y: 0, width: 320, height: 285 } },
  },
  // The toolbar's four dropdowns. `clip` rather than `sel: "#toolbar"` — a
  // locator screenshot clips to the element box, which would cut off the
  // panel hanging below it. The toolbar is right-anchored in a 1360px
  // viewport, so the region below/left of its right edge covers every panel.
  ...["view", "select", "measure", "markup"].map((name) => ({
    file: `${name}-menu.png`,
    setup: async (page) => { await populate(page); await page.click(`#${name}-menu`); await sleep(150); },
    // View menu grew by one row in Phase 2 (the layout picker) — a too-short
    // clip silently cuts the last entry off, the same trap that bumped
    // file-menu.png 250→285. 300 was tight; 340 leaves margin for future rows.
    target: { clip: { x: 830, y: 30, width: 530, height: 340 } },
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
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`Harness server: ${base}`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
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
