# CLAUDE.md

Project memory for CAD-Preview — a VS Code extension that previews 3D CAD/mesh files
in a read-only custom editor.

## Keep docs in sync

**Every time you change code in this repo, check whether `doc/`, `README.md`, and
this file need updating too — and update them if they do.** Treat doc drift as part
of the change, not a follow-up. Concretely:
- New/changed message types in `src/protocol.ts` → update `doc/protocol.md`.
- New/changed file-format behavior (read or write) → update `doc/file-formats.md` and
  the format tables in `README.md` / `doc/index.md` / `doc/getting-started.md`.
- New/changed module, exported function, or architectural decision → update
  `doc/extension-host-api.md` or `doc/webview-api.md` (whichever process it runs in)
  and, for non-negotiable invariants or non-obvious gotchas, this file.
- New/changed toolbar buttons or UI flows → update `doc/getting-started.md`'s
  toolbar/UI tables.
If a change is purely internal refactoring with no observable behavior or API
difference, docs don't need to move — use judgment, but default to checking.

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

## View manipulation (webview, Three.js only)

The webview viewer exposes discrete view controls plus an orientation gizmo:

- **Pure camera math lives in `src/webview/cameraControls.ts`** (`orbit`, `pan`, `dolly`,
  `setDirection`, `viewDirection`). These operate on a `PerspectiveCamera` + target
  `Vector3` with no DOM/renderer, so they are unit-tested headless. `Viewer`'s
  `rotateView`/`panView`/`zoomView`/`setViewDirection` are thin wrappers that delegate to
  them and then call `controls.update()`. `fitView()` reframes in the current orientation;
  `resetView()` returns to the default isometric and is what `setModel()` calls.
- **The orientation cube (`src/webview/orientationCube.ts`) must NOT create its own
  WebGLRenderer/canvas.** A second WebGL context fails in some environments. It owns only a
  scene/camera/cube/`pick()`; `Viewer.renderGizmo()` draws it into a corner of the **single
  main renderer** via a scissor viewport (clear depth only, keep scene colors). Face clicks
  are routed by a capture-phase `pointerdown` on the canvas that `stopImmediatePropagation()`s
  so OrbitControls doesn't also react.
- **The control panel is static HTML** built in `provider.ts` `getHtml` (`#view-controls`,
  collapsible via `#vc-toggle`), wired in `src/webview/main.ts` `setupViewControls()`. Keep
  that wiring inside its `try/catch` and **before** nothing that the `ready` handshake /
  `post({ type: "ready" })` depends on — a throw there must never block model loading.

## Export

Export mirrors the read-side pipeline split, in reverse — see `src/exportTargets.ts`
for the compatibility matrix (`exportTargetsFor`):

- **B-rep targets** (STEP/IGES/BREP) are written entirely in the extension host.
  `exportBRep()` in `src/occtService.ts` re-parses the source file with the existing
  `readShape()` reader and hands the live `TopoDS_Shape` to the matching OCCT writer
  (`STEPControl_Writer`, `IGESControl_Writer`, or `BRepTools::Write`). The webview is
  never involved for these.
- **Mesh targets** (STL/OBJ/PLY/glTF) are written in the webview
  (`src/webview/meshExporters.ts`), reusing Three.js's bundled exporters
  (`three/examples/jsm/exporters/`) on the `THREE.Object3D` already displayed —
  works for *any* source format, since OCCT-tessellated and natively-loaded meshes
  look identical once they're in the Three.js scene. The serialized result travels
  back to the host as a new `exportResult`/`exportError` message and is written with
  `vscode.workspace.fs.writeFile`, since only the host can show save dialogs.
- This OCCT build has **no STL/OBJ/PLY/glTF writers** (readers only) and **no path
  from a triangle mesh back to a B-rep** — that's why export targets are
  pipeline-dependent rather than a flat list of every supported format.
- glTF export always emits a single binary `.glb`, never a text `.gltf` with embedded
  base64 buffers — simpler, no separate buffer-reference handling.
- `GLTFExporter`'s binary path and `PLYExporter.parse()` both depend on browser-only
  APIs (`FileReader`/`Blob`, `requestAnimationFrame`) that don't exist in plain
  Node — `src/webview/meshExporters.test.ts` polyfills `requestAnimationFrame` for
  PLY and skips unit-testing the glTF binary path (it's covered by the manual F5
  verification only).
- **OCCT API quirk, verified against the live WASM (not just docs):** the writer
  classes' useful overloads are `STEPControl_Writer_1` → `.Transfer(shape,
  STEPControl_StepModelType.STEPControl_AsIs, true)` → `.Write(path)`;
  `IGESControl_Writer_1` → `.AddShape(shape)` → `.ComputeModel()` →
  `.Write_2(path, false)`; `BRepTools.Write_2(shape, path,
  new oc.Handle_Message_ProgressIndicator_1())`. The `_1`-suffixed `Write`/`Read`
  overloads on these classes take a C++ `ostream`/`istream`, which isn't bound in
  this WASM build and throws `UnboundTypeError` — always use the path-based overload.
- **Fixed bug:** BREP *reading* (`readShape()`'s `format === "brep"` branch) used to
  call `new oc.Message_ProgressRange_1()`, which isn't a real constructor in this
  OCCT build — every `.brep` open threw immediately. The 4th param of
  `BRepTools.Read_2` is actually a `Handle_Message_ProgressIndicator`, same type the
  BREP writer above takes.

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
wireframe toggle. Exercise the view-manipulation panel (stepped rotate/pan/zoom, Fit vs
Ctr), the orientation cube (faces snap the view), and the **⌄ / ⌃** hide/show toggle.
Open/close repeatedly and watch extension-host memory stay flat (leak check). Additional
fixtures: `examples/OBJ/cube.obj`, `examples/PLY/cube.ply`, `examples/GLTF/cube.gltf`.

Exercise **Export**: on `bull.stp`, confirm the quick-pick offers IGES/BREP/STL/OBJ/
PLY/glTF (not STEP again); on `cube.stl`, confirm it offers only OBJ/PLY/glTF. Export
to each target and reopen the output file to confirm it round-trips. Repeat
export/cancel a few times and watch extension-host memory, same leak check as above.

On **VS Code Remote/SSH**, the running extension is the installed copy in
`~/.vscode-server/extensions/`, not the workspace `dist/` — rebuilds alone won't show up.
Bump the version, `npx vsce package`, reinstall the `.vsix`, then reload the window.
