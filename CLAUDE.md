# CLAUDE.md

Project memory for CAD-Preview — a VS Code extension that previews 3D CAD/mesh files
in a read-only custom editor.

## Architecture (non-negotiable invariants)

- **OpenCascade.js (OCCT WASM) runs in the Node extension host**, never in the webview.
  The host parses + tessellates B-rep shapes and posts plain typed-array `ArrayBuffer`s
  (base64-encoded `{positions, indices}`) to the webview. The webview runs **only Three.js**.
- **Lazy WASM init.** Never call the factory in `activate()`. Initialize it on the first
  B-rep open and memoize it as a module singleton (`src/occtService.ts`). Opening a
  pure-mesh file (STL/OBJ/PLY/glTF) must never load the WASM.
- **Routing.** B-rep (`.step/.stp/.iges/.igs/.brep`) → OCCT pipeline. Mesh
  (`.stl/.obj/.ply/.gltf/.glb`) → native Three.js loaders via `webview.asWebviewUri`. See
  `src/fileRouter.ts`.
- **Custom editor.** Use `CustomReadonlyEditorProvider` (preview only, no edit/undo/save),
  registered from `contributes.customEditors`.

## WASM loading — critical detail

**Do NOT use `initOpenCascade` from `opencascade.js/index.js`.** That wrapper takes
zero arguments and silently ignores any options you pass (including `wasmBinary`). In
Node 18 the emscripten code's fallback is to call `fetch(wasmPath)` which fails for
filesystem paths (`TypeError: Failed to parse URL`).

Instead, import the raw emscripten factory directly and pass `wasmBinary`:

```typescript
import openCascadeFactory from "opencascade.js/dist/opencascade.wasm.js";

const wasmBinary = fs.readFileSync(path.join(extensionPath, "dist", "opencascade.wasm.wasm"));
_ocPromise = openCascadeFactory({ wasmBinary });
```

## Bundling — opencascade.js is NOT external

`opencascade.js` is **bundled by esbuild** (ESM→CJS conversion), not marked external.
A `wasmPathPlugin` in `esbuild.mjs` intercepts the `.wasm` import and returns a
`require("path").join(__dirname, "opencascade.wasm.wasm")` stub. After the extension
bundle is built, `dist/opencascade.wasm.wasm` is copied there from `node_modules/`.
Keep OCCT out of the webview bundle entirely.

## OCCT memory discipline (top source of bugs)

Every wrapped OCCT object (`reader`, `shape`, `TopExp_Explorer`, `TopLoc_Location`,
triangulation handle, `face`, the mesher) is an Emscripten heap handle and is **not**
garbage-collected. In `src/meshExtract.ts`, push every created handle into a cleanup
list and `.delete()` all of them in a `try/finally` (reverse order), on both success
and failure. The OCCT singleton is reused across files; only per-file objects are freed.

## Build & test

```bash
npm install        # or: npm ci (CI)
npm run build      # esbuild: extension (node/cjs) + webview (browser/iife) + tsc --noEmit
npm run watch      # rebuild on change
npm test           # unit tests via vitest
```

- Integration tests need a display server; CI runs them under `xvfb-run` on Linux.

## Verify a change

Press **F5** to launch the Extension Development Host. Open `examples/STP/bull.stp`
(B-rep) and `examples/STL/cube.stl` (mesh); confirm orbit/pan/zoom, fit-to-view,
wireframe toggle. Open/close repeatedly and watch extension-host memory stay flat
(leak check). Additional fixtures: `examples/OBJ/cube.obj`, `examples/PLY/cube.ply`,
`examples/GLTF/cube.gltf`.
