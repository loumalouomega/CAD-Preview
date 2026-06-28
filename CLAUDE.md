# CLAUDE.md

Project memory for CAD-Preview — a VS Code extension that previews 3D CAD/mesh files
in a read-only custom editor.

## Architecture (non-negotiable invariants)

- **OpenCascade.js (OCCT WASM) runs in the Node extension host**, never in the webview.
  The host parses + tessellates B-rep shapes and posts plain typed-array `ArrayBuffer`s
  (`{positions, normals, indices}`) to the webview. The webview runs **only Three.js**.
- **Lazy WASM init.** Never call `initOpenCascade()` in `activate()`. Initialize it on the
  first B-rep open and memoize it as a module singleton. Opening a pure-mesh file
  (STL/OBJ/PLY/glTF) must never load the WASM.
- **Routing.** B-rep (`.step/.stp/.iges/.igs/.brep`) → OCCT pipeline. Mesh
  (`.stl/.obj/.ply/.gltf/.glb`) → native Three.js loaders via `webview.asWebviewUri`. See
  `src/fileRouter.ts`.
- **Custom editor.** Use `CustomReadonlyEditorProvider` (preview only, no edit/undo/save),
  registered from `contributes.customEditors`.

## OCCT memory discipline (top source of bugs)

Every wrapped OCCT object (`reader`, `shape`, `TopExp_Explorer`, `TopLoc_Location`,
triangulation handle, `face`, per-node `gp_Pnt`, the mesher) is an Emscripten heap handle
and is **not** garbage-collected. In `src/meshExtract.ts`, push every created handle into a
cleanup list and `.delete()` all of them in a `try/finally` (reverse order), on both success
and failure. The OCCT singleton is reused across files; only per-file objects are freed.

## Build & test

```bash
npm install        # or: npm ci (CI)
npm run build      # esbuild: extension (node/cjs) + webview (browser/iife) + tsc --noEmit
npm run watch      # rebuild on change
npm test           # unit (meshExtract) + @vscode/test-electron integration
```

- Bundler is **esbuild**, two targets. Keep `opencascade.js` **external** and ship its
  `dist/*.wasm` as a packaged asset — do not let esbuild bundle the WASM. Keep OCCT out of
  the webview bundle entirely.
- Integration tests need a display server; CI runs them under `xvfb-run` on Linux.

## Verify a change

Press **F5** to launch the Extension Development Host. Open `examples/STP/bull.stp` (B-rep)
and an `.stl` (mesh); confirm orbit/pan/zoom, fit-to-view, wireframe toggle. Open/close
repeatedly and watch extension-host memory stay flat (leak check).
