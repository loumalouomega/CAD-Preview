# Documentation screenshot pipeline

Generates the per-feature screenshots embedded in the docs (`doc/public/screenshots/`) and the two README hero images (`images/`). Run from the repo root:

```bash
npm run docs:screenshots   # build → fixtures → capture
```

First run only, install the headless browser:

```bash
npx playwright install chromium
```

## How it works

These screenshots are **generated, not hand-captured**, so they never drift from the shipped UI.

| File | Role |
| --- | --- |
| `make-fixtures.mjs` | esbuild-bundles `fixtures-entry.ts` (Node/CJS) and runs it. It calls the **real** host modules — `loadBRep` (OpenCascade tessellation) and `generateMesh` (Gmsh) — on `examples/STP/bull.stp`, and writes the exact `HostToWebview` message payloads plus small realistic `parts`/`edits` and the shared viewer DOM to `fixtures/` (git-ignored). Requires `dist/*.wasm`, so `npm run build` runs first. |
| `fixtures-entry.ts` | The generator logic (imports `src/` host modules; `vscode`-free). Also tessellates the tutorials' cumulative op-prefixes from `block.stp` (`tutorial-*-geometry/tree.json`) plus one `exportBRep`-baked bracket mesh (`tutorial-fea-meshingResult.json`) for the per-step shots. |
| `harness.mjs` | **The shared Playwright harness**: the static server, the `/__harness` page (the shared `viewerBodyHtml()` + an `acquireVsCodeApi` stub + `media/viewer.{js,css}`), the SwiftShader Chromium flags, and `populate()` — whose message ordering is load-bearing. Imported by `capture.mjs` **and** by `scripts/webview-test/run.mjs`. |
| `capture.mjs` | Drives that harness for screenshots: posts the fixtures so the UI shows genuine geometry, walks each panel, and writes one PNG per feature. |

The webview DOM is the single source of truth in `src/viewerDom.ts` (`viewerBodyHtml()`), imported by both `provider.ts` (the real extension) and the harness here.

**Why `harness.mjs` is shared rather than copied.** This repo generally does *not* factor code between `scripts/*` entries (`mcp-smoke` and `perf` deliberately duplicate their small JSON-RPC client). The harness is the exception because its `populate()` ordering has drifted between copies twice already, with real consequences — `src/renderService.ts` was missed by the `viewState`-ordering fix that landed here, so every `render_snapshot` image was silently misframed. A third copy for the assertion runner would have repeated that.

## The assertion harness

`capture.mjs` only *captures*; it asserts nothing, which is how an exit-0 run could coexist with every 3D shot being misframed. `scripts/webview-test/run.mjs` drives the same harness and **asserts** — panels, the export picker against the real registry, picking, overlays, the render-on-demand idle-frame probe, and two previously-fixed dropdown bugs:

```bash
npm run test:webview   # build → fixtures → assertions
```

## Adding or changing a shot

Edit the `SHOTS` array in `capture.mjs`: each entry is `{ file, setup(page), target }`, where `target` is `{}` (full page), `{ sel: "#id" }` (element crop), or `{ clip: {x,y,width,height} }`. Then re-run `npm run docs:screenshots` and embed the new PNG in the relevant `doc/*.md` page with `![alt](/screenshots/<file>.png)`.

Nothing here ships in the packaged `.vsix` — it is dev tooling only.
