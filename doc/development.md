# Development Guide

## Prerequisites

- **Node.js 20** or later (LTS recommended)
- **npm** (included with Node.js)
- **VS Code 1.80+** for running the Extension Development Host
- **Git**

## Setup

```bash
git clone https://github.com/loumalouomega/CAD-Preview.git
cd CAD-Preview
npm install
```

## Build Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Bundle extension host + MCP server + webview (esbuild) and type-check (tsc) |
| `npm run watch` | Rebuild incrementally on file changes |
| `npm test` | Run unit tests with Vitest (headless, no display server needed) |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run package` | Produce `cad-preview.vsix` for manual installation |
| `npm run docs:dev` | Serve the VitePress documentation site locally |
| `npm run docs:build` | Build the static documentation site to `doc/.vitepress/dist/` |
| `npm run docs:preview` | Preview the built documentation site locally |
| `npm run docs:screenshots` | Regenerate every feature screenshot under `doc/public/screenshots/` |
| `npm run mcp` | Run the standalone MCP server (`dist/mcp-server.js`; requires a prior build) |
| `npm run mcp:smoke` | Build, then run the real-WASM end-to-end MCP smoke test (see [MCP Server](./mcp-server.md)) |

## Regenerating Documentation Screenshots

The per-feature screenshots embedded in the docs are generated automatically —
they are **not** hand-captured — so they stay in lockstep with the real UI:

```bash
npm run docs:screenshots   # runs build → fixtures → capture
```

The pipeline lives in `scripts/screenshots/`:

1. **`make-fixtures.mjs`** runs the *real* extension-host geometry pipeline in
   plain Node — OpenCascade tessellation + a Gmsh mesh of `examples/STP/bull.stp`
   — and writes the exact `geometry`/`tree`/`meshingResult`/`parts`/`edits`
   message payloads (plus the shared viewer DOM) to `scripts/screenshots/fixtures/`
   (git-ignored).
2. **`capture.mjs`** loads the shipped webview bundle (`media/viewer.js`) into a
   headless Chromium via Playwright, stubs `acquireVsCodeApi`, posts those
   fixtures so the UI shows genuine geometry (WebGL renders through SwiftShader —
   no display server needed), drives each panel, and writes one PNG per feature
   to `doc/public/screenshots/`. It also refreshes the two README hero images.

The webview DOM is shared with the real extension via `src/viewerDom.ts`
(`viewerBodyHtml()`), which `provider.ts` also uses, so a UI change can never
leave the screenshots showing stale markup. First run needs the Playwright
browser: `npx playwright install chromium`.

## Running in the Extension Development Host

Press **F5** in VS Code (with the `launch.json` already configured) to open the Extension Development Host. This is the recommended way to test the extension end-to-end.

### Test fixtures

| Fixture | Format | What to test |
|---------|--------|-------------|
| `examples/STP/bull.stp` | STEP (B-rep) | OCCT pipeline, multi-solid tree panel |
| `examples/STL/cube.stl` | STL | Three.js pipeline, basic geometry |
| `examples/OBJ/cube.obj` | OBJ | OBJ loader, default material |
| `examples/PLY/cube.ply` | PLY | PLY loader, normal computation |
| `examples/GLTF/cube.gltf` | glTF | GLTFLoader, scene hierarchy |

### Manual checklist

After any non-trivial change, run through:

1. Open `examples/STP/bull.stp` — model renders, component tree visible.
2. Open `examples/STL/cube.stl` — renders without loading the WASM.
3. Orbit, pan, zoom with mouse — smooth movement with damping.
4. Click each toolbar button: Fit, Tree, FE Mesh, and open each of the **View ▾** / **Select ▾** / **Measure ▾** / **Markup ▾** dropdowns. Use **File ▸ Export…** (or Ctrl+E) to export.
5. Use the view-controls panel: step rotate (15°/45°/90°), pan, zoom, Fit, Ctr (reset).
6. Collapse and expand the view-controls panel with ⌄/⌃.
7. Click all six faces of the orientation cube — view snaps to ±X/Y/Z.
8. Click a row in the component tree — solid highlights, others dim. Click again to deselect.
9. Click **Export** on `bull.stp` — quick-pick offers IGES/BREP/STL/OBJ/PLY/glTF (not STEP); export to each and reopen the output to confirm it round-trips. On `cube.stl`, confirm only OBJ/PLY/glTF are offered.
10. Open and close the same file several times — extension host memory stays flat (no OCCT heap leak). Repeat with export/cancel cycles.

## Project Structure

```
CAD-Preview/
├── src/
│   ├── extension.ts          # Extension entry point
│   ├── provider.ts           # Custom editor provider
│   ├── fileRouter.ts         # File extension → strategy routing
│   ├── exportTargets.ts      # Compatible export formats per route
│   ├── protocol.ts           # Host↔webview message types
│   ├── occtService.ts        # WASM singleton + B-rep loading + export
│   ├── meshExtract.ts        # OCCT geometry extraction
│   └── webview/
│       ├── main.ts           # Webview entry point
│       ├── viewer.ts         # Three.js scene controller
│       ├── cameraControls.ts # Pure camera math
│       ├── orientationCube.ts# Orientation gizmo
│       ├── geometryBuilder.ts# Decode buffers → THREE.Group
│       ├── meshLoaders.ts    # Three.js loader dispatch
│       ├── meshExporters.ts  # Three.js exporter dispatch
│       └── treePanel.ts      # Component tree DOM panel
├── media/                    # Runtime webview assets (built)
│   ├── viewer.js             # Compiled webview IIFE bundle
│   └── viewer.css            # Webview styles
├── dist/                     # Extension host build output
│   ├── extension.js          # Compiled extension CJS bundle
│   └── opencascade.wasm.wasm # WASM binary (copied from node_modules)
├── doc/                      # Documentation source (VitePress)
│   └── .vitepress/
│       └── config.ts         # VitePress configuration
├── examples/                 # Sample CAD/mesh fixtures
├── esbuild.mjs               # Build configuration
├── tsconfig.json             # TypeScript configuration (noEmit)
└── .github/
    ├── dependabot.yml            # Automated dependency-update PRs (npm + GitHub Actions)
    └── workflows/
        ├── ci.yml                # Build + test + release CI
        ├── docs.yml              # Docs build + GitHub Pages deploy
        └── dependency-review.yml # Blocks PRs introducing vulnerable/risky dependencies
```

## Build System Details

### esbuild

`esbuild.mjs` produces two bundles:

**Extension host** (`dist/extension.js`):
- Format: `cjs` (Node requires CommonJS)
- Platform: `node`
- Target: `es2020`
- `vscode` is marked external (provided by VS Code at runtime)
- `opencascade.js` is **bundled** (not external) — ESM is converted to CJS

**Webview** (`media/viewer.js`):
- Format: `iife` (immediately-invoked, consistent with webview CSP)
- Platform: `browser`
- Target: `es2020`
- Three.js is bundled

**`wasmPathPlugin`**: A custom esbuild plugin intercepts `*.wasm` imports and emits a `require('path').join(__dirname, '<name>')` CJS stub. After the bundle is written, `esbuild.mjs` copies the actual `.wasm` binary from `node_modules/` to `dist/`. This ensures the WASM is always co-located with the extension bundle.

### TypeScript

`tsconfig.json` uses `"noEmit": true` — type-checking only. esbuild handles the actual compilation. Run `npm run compile` (or `tsc --noEmit`) to check types without building.

## Test Suite

Unit tests use [Vitest](https://vitest.dev/). They run headlessly — no display server or VS Code host needed.

| Test file | Covers |
|-----------|--------|
| `src/fileRouter.test.ts` | Extension → `FileRoute` mapping |
| `src/exportTargets.test.ts` | Export target matrix per route, extension map |
| `src/meshExtract.test.ts` | `extractFaceGeometry`, winding order, index conversion |
| `src/webview/cameraControls.test.ts` | `orbit`, `pan`, `dolly`, `setDirection`, `viewDirection` |
| `src/webview/orientationCube.test.ts` | Cube initialization, `syncCamera`, `faceNormalToDirection` |
| `src/webview/viewer.test.ts` | `Viewer` construction, `setModel`, `fitView` |
| `src/webview/meshLoaders.test.ts` | Loader dispatch by format |
| `src/webview/meshExporters.test.ts` | Exporter dispatch by format, base64 round-trip |

Run all tests: `npm test`

Run a specific test file: `npx vitest run src/fileRouter.test.ts`

## VS Code Remote / SSH

When using VS Code Remote or SSH, the **running extension** is the installed copy in `~/.vscode-server/extensions/`, not the `dist/` directory in the workspace. Rebuilding alone won't show your changes.

To update the running extension after code changes:
1. Bump the version in `package.json`.
2. `npm run package` — produces `cad-preview-<version>.vsix`.
3. `code --install-extension cad-preview-<version>.vsix` (or install via the Extensions view).
4. Reload the VS Code window (`Developer: Reload Window`).

Also watch out for stale duplicate entries in `~/.vscode-server/extensions/` if you have installed both a published version and a local `.vsix`.

## CI Pipeline

See `.github/workflows/ci.yml`. Two jobs:

**`build-and-test`** (every push/PR to `master`):
1. Checkout + Node 20 setup
2. `npm ci` — clean install
3. `npm run build` — bundle + type-check
4. `npm test` — unit tests
5. `npm run package` — produce `.vsix`
6. Upload `.vsix` as a workflow artifact

**`release`** (only on `v*` tags):
1. Same steps as `build-and-test`
2. `npx vsce package --out cad-preview-<tag>.vsix`
3. Create a GitHub Release with auto-generated release notes
4. Attach the `.vsix` as a release asset

## Dependency Hygiene

Two mechanisms keep dependencies current and non-malicious, configured in `.github/`:

- **`dependabot.yml`** opens weekly PRs for outdated `npm` packages (dev-dependency
  minor/patch bumps grouped into one PR) and GitHub Actions versions. It also drives
  GitHub's native Dependabot security alerts/PRs for the `npm` ecosystem regardless of
  the update schedule.
- **`dependency-review.yml`** runs `actions/dependency-review-action` on every PR to
  `master` and fails the check (`fail-on-severity: moderate`) if the diff introduces a
  package with a known moderate-or-worse vulnerability, posting a summary comment on
  the PR.

Before adding any new **bundled** dependency (see the License section in
[`CLAUDE.md`](../CLAUDE.md) — anything that ends up in the packaged `.vsix`, not just a
dev/build-time tool), check its license for GPL compatibility first regardless of what
these two checks report, since they scan for vulnerabilities/version currency, not
license terms.

**`docs`** (see `.github/workflows/docs.yml`, every push to `master`):
1. Checkout + Node 20 setup
2. `npm ci`
3. `npm run docs:build` — VitePress build
4. Deploy to GitHub Pages via `actions/upload-pages-artifact` + `actions/deploy-pages`
