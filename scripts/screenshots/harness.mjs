/**
 * The shared Playwright harness both webview tools drive: `capture.mjs` (docs
 * screenshots) and `../webview-test/run.mjs` (assertions).
 *
 * **Why this is a shared module, against this repo's usual "don't factor
 * between `scripts/*` entries" convention.** That convention holds for
 * `mcp-smoke` vs `perf`, which share only a trivial JSON-RPC client shape.
 * What lives here is different: `populate()`'s message ordering is
 * load-bearing (see its own comment), and a second copy of it has ALREADY
 * drifted from the first twice, with real consequences —
 * `src/renderService.ts` was missed by the `viewState`-ordering fix that
 * landed in `capture.mjs` (commit f20816c), so every `render_snapshot` image
 * was silently misframed for as long as Chromium happened to be available;
 * and the geometry fixture here still omits `smooth` on edges where
 * `renderService.ts` includes it. Adding a THIRD copy for the assertion
 * runner would be repeating a failure this codebase has already paid for.
 *
 * `src/renderService.ts` is deliberately NOT unified into this module: it is
 * TypeScript, it ships inside `dist/mcp-server.js`, and it feeds geometry
 * in-process from `loadBRep()` rather than from pre-baked JSON fixtures.
 * Different constraints, different process — the duplication there is a known,
 * accepted cost, recorded here so it is at least visible.
 */
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo root — also the static server's document root. */
export const ROOT = path.resolve(HERE, "..", "..");
/** Where `make-fixtures.mjs` writes the real OCCT/Gmsh message fixtures. */
export const FIX = path.join(HERE, "fixtures");

/**
 * SwiftShader software rendering — this exact flag list is also in
 * `src/renderService.ts`'s `LAUNCH_ARGS`. Headless Chromium has no GPU, and
 * without these the WebGL context creation fails outright rather than falling
 * back, so every canvas comes out blank.
 */
export const LAUNCH_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
];

/**
 * `playwright-core`'s own `lib/bootstrap.js` calls `process.exit(1)`
 * **synchronously at module-load time** when Node's major version is below its
 * minimum. `process.exit()` is not a thrown exception, so no `try/catch`
 * around an `import("playwright")` can intercept it — the only safe move is to
 * never reach the import. Same guard, same reason, as
 * `src/renderService.ts`'s `nodeSupportsPlaywright()`.
 */
export const MIN_NODE_MAJOR_FOR_PLAYWRIGHT = 20;
export function nodeSupportsPlaywright() {
  return parseInt(process.versions.node.split(".")[0], 10) >= MIN_NODE_MAJOR_FOR_PLAYWRIGHT;
}

/** Reads one `make-fixtures.mjs` JSON fixture by name (no extension). */
export const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), "utf8"));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CTYPE = {
  ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm",
  ".json": "application/json", ".map": "application/json", ".html": "text/html",
  ".stl": "model/stl", ".obj": "text/plain", ".ply": "application/octet-stream",
  ".gltf": "model/gltf+json", ".glb": "model/gltf-binary", ".svg": "image/svg+xml",
};

/**
 * The harness page: the REAL shipped `media/viewer.js` + `media/viewer.css`
 * over `viewerDom.ts`'s own body markup (written to `fixtures/body.html` by
 * `fixtures-entry.ts`, which CAN import the TypeScript this `.mjs` cannot).
 *
 * The `acquireVsCodeApi` stub queues every webview→host message on
 * `window.__sent`, which is the entire assertion surface the test runner reads;
 * `window.__post` is the host→webview direction.
 */
export function harnessHtml() {
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

/** Serves the repo tree plus the generated `/__harness` page on an ephemeral port. */
export function startServer() {
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

/** Loads the harness page and waits until the webview has finished its own setup. */
export async function openHarness(page, base) {
  await page.goto(`${base}/__harness`, { waitUntil: "load" });
  // Wait until the webview finished setup (it posts a `ready` message).
  await page.waitForFunction(() => window.__sent && window.__sent.some((m) => m.type === "ready"), null, { timeout: 20000 });
  await page.waitForSelector("#app canvas", { timeout: 20000 });
}

export const post = (page, msg) => page.evaluate((m) => window.__post(m), msg);

/**
 * Post the full set of fixtures so every panel is populated, then settle.
 *
 * **The ordering here is load-bearing — do not reorder or drop a step.**
 */
export async function populate(page) {
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
