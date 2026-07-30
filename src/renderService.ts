/**
 * Headless multi-view PNG rendering for the `render_snapshot` MCP tool — the
 * runtime (`dist/mcp-server.js`) sibling of `scripts/screenshots/`'s
 * Playwright docs-build harness, reusing the same real webview bundle
 * (`media/viewer.js`) and DOM (`viewerDom.ts`'s `viewerBodyHtml()`, the same
 * single source of truth `provider.ts` uses) but driven programmatically
 * instead of by a fixed shot list, and fed geometry directly from an
 * in-process `loadBRep()` result instead of pre-baked JSON fixture files (no
 * temp file write/re-parse needed — see CLAUDE.md's "Agent feedback tools"
 * section).
 *
 * **Playwright stays a devDependency, by design — this tool degrades
 * gracefully, it never crashes the MCP server.** `.vscodeignore` excludes
 * `node_modules/**` wholesale with no carve-out for `playwright`, and its
 * actual Chromium binary is a separate ~150–300MB download
 * (`npx playwright install chromium`) that never runs for an installed
 * `.vsix`. So this tool only works where that install step has been run
 * once — a repo checkout, CI, or an agent sandbox — never guaranteed for an
 * end user's installed extension. Every entry point here returns
 * `{supported: false, reason}` instead of throwing when Playwright or
 * Chromium is unavailable, mirroring `get_mass_properties`/`compare_models`'s
 * existing `supported: false` graceful-degradation convention for mesh
 * sources (a different unavailability reason, same shape).
 */
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { loadBRep } from "./occtService";
import { encodeBuffer } from "./protocol";
import { viewerBodyHtml } from "./viewerDom";
import type { HostToWebview, EntityType } from "./protocol";
import type { CadFormat } from "./fileRouter";
import type { EditOp } from "./editOps";

export type BRepFormat = Extract<CadFormat, "step" | "iges" | "brep">;

export interface RenderView {
  label: string;
  direction: [number, number, number];
  up?: [number, number, number];
  wireframe?: boolean;
}

export interface RenderImage {
  label: string;
  mimeType: "image/png";
  dataBase64: string;
}

export interface RenderResult {
  supported: boolean;
  reason?: string;
  images?: RenderImage[];
}

/** Two opposed isometrics (negating all 3 components guarantees every
 * outward face normal has a positive dot product with at least one of the
 * two view directions — "by construction, not by suspicion") + top + front.
 * `up` on TOP avoids a gimbal-lock-like flip (the default `[0,1,0]` up is
 * parallel to a straight-down/up view direction). */
export const DEFAULT_VIEWS: RenderView[] = [
  { label: "ISO-A", direction: [1, 0.8, 1] },
  { label: "ISO-B", direction: [-1, -0.8, -1] },
  { label: "TOP", direction: [0, 1, 0], up: [0, 0, -1] },
  { label: "FRONT", direction: [0, 0, 1] },
];

const LAUNCH_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

const NOT_AVAILABLE_REASON =
  'Playwright/Chromium not available in this environment. render_snapshot needs a one-time ' +
  '"npm install --save-dev playwright && npx playwright install chromium" — works in a repo ' +
  "checkout, CI, or an agent sandbox that can run that command, but is not guaranteed present for " +
  "an installed .vsix. See doc/mcp-server.md.";

/** Cheap-ish availability probe (launches + immediately closes a browser) —
 * NOT called by `describe_capabilities` (that tool is meant to be
 * instant/side-effect-free); `render_snapshot` calls this itself and reports
 * `supported: false` with {@link NOT_AVAILABLE_REASON} rather than crashing. */
export async function isRenderAvailable(): Promise<{ available: boolean; reason?: string }> {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
    await browser.close();
    return { available: true };
  } catch (err) {
    return { available: false, reason: `${NOT_AVAILABLE_REASON} (${(err as Error).message})` };
  }
}

const CTYPE: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".map": "application/json",
  ".html": "text/html",
};

function harnessHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<link rel="stylesheet" href="/media/viewer.css" />
<style>html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; }</style>
</head><body>
<script>
  window.acquireVsCodeApi = function () {
    return { postMessage: function (m) { (window.__sent = window.__sent || []).push(m); },
             getState: function () {}, setState: function () {} };
  };
  window.__post = function (m) { window.postMessage(m, "*"); };
</script>
${viewerBodyHtml()}
<script src="/media/viewer.js"></script>
</body></html>`;
}

/** Same tiny static server pattern as `scripts/screenshots/capture.mjs`'s
 * `startServer()`, rooted at `extensionPath` (where `media/` lives) instead
 * of the repo root, with an in-memory `/__harness` route (no temp file). */
function startServer(extensionPath: string): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
      if (url === "/__harness") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(harnessHtml());
        return;
      }
      const filePath = path.join(extensionPath, path.normalize(url));
      if (!filePath.startsWith(extensionPath) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": CTYPE[path.extname(filePath)] ?? "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parses a `solid-N`/`face-N`/`edge-N`/`point-N` id into the
 * `{entityType, entityId}` shape `Viewer.applyPartVisibility` expects — the
 * webview has no such id-prefix parser of its own (every existing caller
 * already carries `entityType` alongside `entityId`), so this host-side,
 * already-B-rep-aware layer is the natural place to attach it. */
function toSelectedEntity(id: string): { entityType: EntityType; entityId: string } | null {
  if (/^solid-\d+$/.test(id)) return { entityType: "volume", entityId: id };
  if (/^face-\d+$/.test(id)) return { entityType: "surface", entityId: id };
  if (/^edge-\d+$/.test(id)) return { entityType: "line", entityId: id };
  if (/^point-\d+$/.test(id)) return { entityType: "point", entityId: id };
  return null;
}

/**
 * Renders `bytes` (a B-rep source, with `ops` replayed) to a labelled
 * multi-view PNG packet via a headless, disposable Chromium page running the
 * real `media/viewer.js` bundle. Re-parses/re-tessellates fresh on every
 * call, exactly like every other B-rep read path in this codebase — no
 * shape/session cache, no lingering browser/page state (the page is created
 * and closed within this single call).
 */
export async function renderSnapshot(
  extensionPath: string,
  bytes: Uint8Array,
  format: BRepFormat,
  ops: EditOp[],
  opts: { focus?: string[]; hide?: string[]; wireframe?: boolean; views?: RenderView[] }
): Promise<RenderResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let playwright: any;
  try {
    playwright = await import("playwright");
  } catch (err) {
    return { supported: false, reason: `${NOT_AVAILABLE_REASON} (${(err as Error).message})` };
  }

  const { groups, edges, points, tree } = await loadBRep(extensionPath, bytes, format, ops);
  const geometryMsg: HostToWebview = {
    type: "geometry",
    meshes: groups.flatMap((g) =>
      g.faces.map((f) => ({
        positions: encodeBuffer(f.buffers.positions),
        indices: encodeBuffer(f.buffers.indices),
        groupId: g.id,
        faceId: f.faceId,
      }))
    ),
    edges: edges.map((e) => ({ positions: encodeBuffer(e.positions), edgeId: e.edgeId })),
    points: points.map((p) => ({ position: encodeBuffer(new Float32Array(p.position)), pointId: p.pointId })),
  };
  const treeMsg: HostToWebview = { type: "tree", root: tree };

  const focus = (opts.focus ?? []).map(toSelectedEntity).filter((e): e is NonNullable<typeof e> => e !== null);
  const hide = (opts.hide ?? []).map(toSelectedEntity).filter((e): e is NonNullable<typeof e> => e !== null);
  const views = opts.views ?? DEFAULT_VIEWS;

  let server: http.Server | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  try {
    server = await startServer(extensionPath);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    browser = await playwright.chromium.launch({ headless: true, args: LAUNCH_ARGS });
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 });
    const page = await context.newPage();

    await page.goto(`${base}/__harness`, { waitUntil: "load" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.waitForFunction(() => (window as any).__sent?.some((m: any) => m.type === "ready"), null, {
      timeout: 20000,
    });
    await page.waitForSelector("#app canvas", { timeout: 20000 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const post = (msg: unknown) => page.evaluate((m: any) => (window as any).__post(m), msg);
    await post(geometryMsg);
    await sleep(700); // OCCT geometry decode + first frame, same settle time capture.mjs uses
    await post(treeMsg);
    await sleep(200);

    const images: RenderImage[] = [];
    const errors: string[] = [];
    for (let i = 0; i < views.length; i++) {
      const view = views[i];
      const requestId = `rv-${i}`;
      await post({
        type: "renderViewRequest",
        requestId,
        direction: view.direction,
        up: view.up,
        label: view.label,
        focus: focus.length > 0 ? focus : undefined,
        hide: hide.length > 0 ? hide : undefined,
        wireframe: opts.wireframe ?? view.wireframe,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await page.waitForFunction(
        (rid: string) =>
          (window as any).__sent?.find(
            (m: any) => m.requestId === rid && (m.type === "renderViewResult" || m.type === "renderViewError")
          ) ?? null,
        requestId,
        { timeout: 20000 }
      );
      const msg = (await result.jsonValue()) as { type: string; data?: string; message?: string };
      if (msg.type === "renderViewResult" && msg.data) {
        images.push({ label: view.label, mimeType: "image/png", dataBase64: msg.data });
      } else {
        errors.push(`${view.label}: ${msg.message ?? "unknown error"}`);
      }
    }

    await page.close();

    if (images.length === 0) {
      return { supported: false, reason: `Every view failed: ${errors.join("; ")}` };
    }
    return { supported: true, images, ...(errors.length > 0 ? { reason: `Some views failed: ${errors.join("; ")}` } : {}) };
  } finally {
    if (browser) await browser.close();
    if (server) server.close();
  }
}
