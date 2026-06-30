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

## Geometry parts (editing)

Users define named **parts** (FEM sub-model-parts) by clicking volumes/surfaces/
lines in the view and assigning them. Non-negotiable invariants:

- **The CAD file stays read-only.** Part assignments persist to a JSON sidecar
  `<model>.parts.json` next to the source (`src/partsStore.ts`), never into the CAD
  file. `CustomReadonlyEditorProvider` is unchanged. Parse/serialize live in the
  **vscode-free** `src/partsSidecar.ts` so they unit-test; `partsStore.ts` adds the
  `vscode.workspace.fs` I/O. Autosave is debounced (~500 ms) in `provider.ts` on each
  `partsChanged` message.
- **Entity ids must be deterministic and stable** across reopen (the sidecar
  references them). B-rep: `face-N` and `solid-N` by deterministic `TopExp_Explorer`
  order; `edge-N` by first appearance while de-duplicating shared edges. Mesh formats:
  `node-N` by traversal order (volumes) — **never `THREE` `uuid`** (uuids are random
  per load and would break round-trip). See `tagMeshEntities` in `src/webview/main.ts`.
- **Mesh "surfaces" are computed, not stored.** Mesh formats have no face topology, so
  `splitMeshesIntoFacets` (`src/webview/meshFacets.ts`) segments each loaded mesh into
  connected near-coplanar **facets** (~15° tolerance, position-welded adjacency) and
  replaces it with a `THREE.Group` of per-facet sub-meshes — same per-face object model
  as B-rep. Facet ids `node-N/face-K` by deterministic triangle order. Meshes above
  `MAX_FACETS` facets are kept whole (one surface); meshes have no lines. The Components
  tree is built from the original hierarchy **before** splitting so it lists whole objects.
- **This OCCT build does NOT bind `TopTools_IndexedMapOfShape`** (verified against the
  live WASM). So edge de-dup in `extractEdges` (`src/meshExtract.ts`) uses
  `edge.HashCode(1<<30)` buckets + `IsSame`; the deduped edge handles are kept alive in
  the cleanup list until the end so `IsSame` stays valid, then all deleted in `finally`.
- **OCCT edge API, verified against the live WASM:** discretize with
  `new oc.BRepAdaptor_Curve_2(edge)` → `new oc.GCPnts_UniformDeflection_2(curve, 0.1,
  false)` → `IsDone()`, `NbPoints()`, `Value(i)` (a `gp_Pnt`, must `.delete()`).
- **Webview entity model:** `geometryBuilder.ts` builds **one `THREE.Mesh` per face**
  and **one `THREE.Line` per edge** (own material each) under a per-solid `THREE.Group`,
  tagged `userData = { groupId: solidId, entityType, entityId }`. This keeps the
  existing `highlightGroup` working and makes raycast picking + per-part colouring
  trivial. Picking resolution (`picking.ts`), the transient `SelectionSet`
  (`selection.ts`), and the `PartsModel` (`partsModel.ts`) are DOM-free and unit-tested;
  `partsPanel.ts` is the DOM. Selection happens on a click (down+up without a drag) so
  OrbitControls still orbits — see `onSelectPointerUp` in `viewer.ts`.
- VS Code webviews **block `prompt()`/`alert()`** — the Parts panel renames via an
  inline `<input>`, not a dialog.

## Geometry editing (operations)

Users apply **edit operations** (transforms, booleans, feature modeling, assembly)
on top of the source model. Non-negotiable invariants:

- **The CAD file stays read-only — still.** Edits persist to a *second* sidecar
  `<model>.edits.json` (next to `<model>.parts.json`), an **ordered, replayable
  op-list** re-applied on every open. The displayed model is `base shape ∘ ops`.
  `CustomReadonlyEditorProvider` is unchanged; nothing ever writes the CAD file.
  **Export bakes the edits in** (the export pipeline re-applies the same ops).
- **One shared op model.** `src/editOps.ts` (vscode-free) holds the `EditOp`
  discriminated union + `validateEditOp` — the **single tolerance gate**; the
  sidecar parser and any incoming op run through it, so a malformed op is dropped,
  never crashes replay. Parse/serialize live in the vscode-free
  `src/editsSidecar.ts`; `src/editsStore.ts` adds the `vscode.workspace.fs` I/O.
  Autosave is debounced (~500 ms) in `provider.ts` on each `editsChanged` message,
  on a **separate timer** from parts.
- **Pipeline split mirrors read/export.** B-rep ops run in the **host** via OCCT
  (`src/occtOperations.ts` `applyEditsBRep` — folds ops over the live
  `TopoDS_Shape`, then the existing `tessellateByGroup`/`extractEdges` re-display
  it). Mesh ops run in the **webview** via Three.js (`src/webview/meshEdits.ts`
  `applyEditsMesh`). Feature-modeling ops are **B-rep only** (`BREP_ONLY_OPS`) —
  meshes have no sketch/exact topology — and the panel disables them for meshes.
- **The webview owns the op-stack** (`src/webview/editsModel.ts`: push/undo/redo/
  clear + redo buffer, DOM-free, unit-tested); the host stays dumb and just
  persists + (for B-rep) re-tessellates whatever list it receives. `editsPanel.ts`
  is the DOM (transform composer + op list); numeric `<input>`s, not `prompt()`.
- **Mesh replay is non-destructive:** `main.ts` caches the pristine tagged
  `Object3D` and rebuilds the displayed model from a clone on every edit
  (`rebuildMeshModel`), so ops replay cleanly. B-rep replay happens in the host.
- **Transforms act on whole solids/volumes.** Operands are the same stable
  `solid-N`/`node-N` ids; `occtOperations.transformSolids` transforms the whole
  shape when all solids are targeted, else assembles a `TopoDS_Compound` of the
  transformed targets + untouched rest (deterministic `TopExp_Explorer` order, the
  same the read pipeline uses for ids).
- **Entity-id drift (known, accepted):** topology-changing ops (booleans, fillet,
  feature modeling) re-tessellate into **new** `face-N`/`edge-N` ids, so existing
  *part* assignments may not resolve after them — the tolerant sidecar parser drops
  unresolved ids on reload, degrading gracefully. No id-rebinding is attempted.
- **OCCT transform API, verified against the live WASM** (use these exact suffixes;
  others throw `BindingError`/`UnboundTypeError`): translate
  `gp_Trsf.SetTranslation_1(gp_Vec_4)`; rotate `gp_Trsf.SetRotation_1(gp_Ax1_2(
  gp_Pnt_3, gp_Dir_4), angleRad)`; **plane** mirror `gp_Trsf.SetMirror_3(gp_Ax2_3(
  gp_Pnt_3, gp_Dir_4))` (NB: `SetMirror_1` is point, `SetMirror_2` is axis/`gp_Ax1`);
  uniform scale `gp_Trsf.SetScale(gp_Pnt_3, s)`; non-uniform scale `gp_GTrsf` +
  `SetValue(row, col, v)` (1-based 3×4) applied via `BRepBuilderAPI_GTransform_2(
  shape, gtrsf, true).Shape()`; rigid transforms via `BRepBuilderAPI_Transform_2(
  shape, trsf, true).Shape()`. Compound rebuild: `new TopoDS_Compound()` +
  `BRep_Builder.MakeCompound(c)` + `.Add(c, TopoDS.Solid_1(exp.Current()))`.
  `Bnd_Box.Get()` is **not** bound (throws and aborts the module) — read corners
  via `CornerMin()`/`CornerMax()` instead.

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

Exercise **Parts**: on `bull.stp`, click **Select**, then pick faces in **Surf** mode,
edges in **Line** mode, and the solid in **Vol** mode (shift-click for multi-select).
Click **＋ New**, assign the selection, and confirm the entities recolour and appear
under the part in the panel; recolour/rename/delete; expand a part and remove an
entity. Close and reopen the tab → assignments reload from `bull.stp.parts.json`
(inspect it: valid JSON, CAD file untouched). On `cube.stl`, confirm Surf/Line are
disabled and only whole-object **Vol** assignment works and round-trips.

Exercise **Edits**: on `bull.stp`, **Select** the solid in **Vol** mode, then in the
**Edits** panel pick **Move/Rotate/Scale/Mirror**, enter params, **Apply** → the model
updates live and the op appears in the list. **Undo/Redo/Clear** the stack. Close and
reopen the tab → ops reload from `bull.stp.edits.json` (inspect: valid JSON, CAD file
untouched). **Export** the edited model (e.g. to STEP/STL) and reopen the output → the
edits are baked in. On `cube.stl`, confirm transforms apply (mesh path) and that any
B-rep-only ops are unavailable. Apply/undo repeatedly + open/close → host memory stays
flat (OCCT handle-leak check, same as above). (M1 ships transforms; booleans/feature
modeling/assembly land in later milestones.)

On **VS Code Remote/SSH**, the running extension is the installed copy in
`~/.vscode-server/extensions/`, not the workspace `dist/` — rebuilds alone won't show up.
Bump the version, `npx vsce package`, reinstall the `.vsix`, then reload the window.
