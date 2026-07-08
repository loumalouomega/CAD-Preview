# Documentation screenshot pipeline

Generates the per-feature screenshots embedded in the docs (`doc/public/screenshots/`)
and the two README hero images (`images/`). Run from the repo root:

```bash
npm run docs:screenshots   # build → fixtures → capture
```

First run only, install the headless browser:

```bash
npx playwright install chromium
```

## How it works

These screenshots are **generated, not hand-captured**, so they never drift from
the shipped UI.

| File | Role |
|------|------|
| `make-fixtures.mjs` | esbuild-bundles `fixtures-entry.ts` (Node/CJS) and runs it. It calls the **real** host modules — `loadBRep` (OpenCascade tessellation) and `generateMesh` (Gmsh) — on `examples/STP/bull.stp`, and writes the exact `HostToWebview` message payloads plus small realistic `parts`/`edits` and the shared viewer DOM to `fixtures/` (git-ignored). Requires `dist/*.wasm`, so `npm run build` runs first. |
| `fixtures-entry.ts` | The generator logic (imports `src/` host modules; `vscode`-free). |
| `capture.mjs` | Serves the repo + a harness page (the shared `viewerBodyHtml()` + an `acquireVsCodeApi` stub + `media/viewer.{js,css}`) from a tiny static server, launches headless Chromium (Playwright, SwiftShader WebGL), posts the fixtures so the UI shows genuine geometry, drives each panel, and writes one PNG per feature. |

The webview DOM is the single source of truth in `src/viewerDom.ts`
(`viewerBodyHtml()`), imported by both `provider.ts` (the real extension) and the
harness here.

## Adding or changing a shot

Edit the `SHOTS` array in `capture.mjs`: each entry is `{ file, setup(page), target }`,
where `target` is `{}` (full page), `{ sel: "#id" }` (element crop), or
`{ clip: {x,y,width,height} }`. Then re-run `npm run docs:screenshots` and embed
the new PNG in the relevant `doc/*.md` page with `![alt](/screenshots/<file>.png)`.

Nothing here ships in the packaged `.vsix` — it is dev tooling only.
