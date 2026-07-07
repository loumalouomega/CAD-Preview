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

## License

This project is licensed **GPL-2.0-or-later** (not MIT) because it bundles
`@loumalouomega/gmsh-wasm`, which statically links the GPL-2.0-or-later-licensed Gmsh
(and OpenCASCADE) into its shipped WASM binary — distributing that binary makes
CAD-Preview a combined/derivative work bound by the same terms. **Before adding any
new dependency that gets bundled into the shipped extension** (i.e. anything that
ends up in the packaged `.vsix`, not just a dev/build-time tool), check its license
for GPL compatibility first — see the README's "Licensing" section for the current
rationale and attribution.

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
  clear/**remove** + redo buffer, DOM-free, unit-tested); the host stays dumb and
  just persists + (for B-rep) re-tessellates whatever list it receives. `remove
  (index)` splices a single op out of anywhere in the list (a per-row ✕ button
  in the history, revealed on hover) — the only way to drop one specific op
  without discarding everything applied after it, since `undo` only pops the
  end. It clears the redo buffer, same as `push`. `editsPanel.ts` is the DOM
  (transform composer + op list); numeric `<input>`s, not `prompt()`.
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
- **OCCT boolean API, verified against the live WASM:** use the `_3` constructor
  `new BRepAlgoAPI_Fuse_3(s1, s2)` / `_Cut_3` / `_Common_3` → `.Shape()` (union /
  subtract / intersect). The 3rd `Message_ProgressRange` arg is **optional and not
  constructible** in this build (`Message_ProgressRange_1` is not a real ctor — the
  same quirk as BREP read), so pass only the two shapes. `occtOperations.booleanSolids`
  builds each operand from its `solid-N` set (a compound when >1), runs the op, and
  rebuilds a compound of `result + untargeted solids`; an op with unresolved operands
  or `IsDone()===false` is **skipped** (graceful, never hard-fails replay). Box
  fixtures for probing: `BRepPrimAPI_MakeBox_3(gp_Pnt_3, gp_Pnt_3)` (two corners).
- **Mesh booleans use `three-bvh-csg`** (`Evaluator`/`Brush` + `ADDITION`/
  `SUBTRACTION`/`INTERSECTION`) in `src/webview/meshEdits.ts`, bundled into the
  **webview iife only** (a normal dep; esbuild bundles it — keep it out of the
  extension-host bundle). `applyMeshBoolean` resolves operand A/B to their first
  mesh, bakes world matrices into the `Brush.matrix`, evaluates, and replaces both
  operands in the tree with the single result mesh (tagged with A's node id).
- **OCCT fillet/chamfer API, verified against the live WASM** (B-rep only): fillet
  `new BRepFilletAPI_MakeFillet(shape, ChFi3d_FilletShape.ChFi3d_Rational)`, chamfer
  `new BRepFilletAPI_MakeChamfer(shape)` (both **unsuffixed** ctors), then
  `.Add_2(amount, edge)` per edge → `.Shape()` (auto-builds; `.Build()` needs the
  unbound `Message_ProgressRange`, so call `.Shape()` and check `.IsDone()`).
  `occtOperations.filletEdges` resolves `edge-N` ids via `collectEdges`, which
  **replicates `extractEdges`' exact ordering** (HashCode+IsSame de-dup, then keep
  only edges that discretize to ≥2 points) so the ids picked in the view map to the
  right live edges. A fillet whose edges don't resolve, or whose `.Shape()` throws
  (radius too large) / `IsDone()` is false, is skipped.
- **OCCT feature-modeling API, verified against the live WASM** (B-rep only): from a
  selected profile **face** (`face-N`, resolved by `collectFaces` in the same global
  solid→face order `tessellateByGroup` assigns) — extrude
  `BRepPrimAPI_MakePrism_1(face, gp_Vec_4, false, true).Shape()` (the `gp_Vec` is the
  unit `dir` scaled to `length`); revolve `BRepPrimAPI_MakeRevol_1(face, gp_Ax1_2(pnt,
  dir), angleRad, false).Shape()`; sweep `BRepOffsetAPI_MakePipe_1(spineWire, face)`
  with the spine `BRepBuilderAPI_MakeWire_2(edge).Wire()` from the path `edge-N`; loft
  `new BRepOffsetAPI_ThruSections(true, false, 1e-6)` + `.AddWire(BRepTools.OuterWire(
  face))` per profile + `.Build()` + `.Shape()`. `occtOperations.featureModel`
  **appends** the new solid as an extra body (`compound(existing shape + new solid)`)
  — non-destructive; it never cuts/fuses the source. Any feature whose operands don't
  resolve or whose builder throws is skipped. The panel's feature composer is in
  `brepOnlyEls` (disabled for meshes via `setBRepOnly`).
- **OCCT assembly API, verified against the live WASM:** explode (`occtOperations.
  explodeSolids`, all formats) spreads each solid by `(solidCentre − modelCentre)·
  factor`, centres from `Bnd_Box`/`CornerMin`/`CornerMax`; the mesh path
  (`meshEdits.applyMeshExplode`) does the same with `THREE.Box3`. Mate
  (`occtOperations.mateShape`, B-rep only) aligns planar `faceA` onto `faceB`: face
  plane via `BRepAdaptor_Surface_2(face, true)` → `GetType()===GeomAbs_Plane` →
  `.Plane()` (`Location()`, `Axis().Direction()`); rigid motion `gp_Trsf.SetDisplacement(
  gp_Ax3_4(ptA, nA), gp_Ax3_4(ptB, −nB))` applied to the solid owning `faceA`
  (`owningSolid` finds it by `IsSame`). Non-planar faces / unresolved ids / failed
  displacement are skipped.
- **Primitive creation (Box/Cube, Sphere, Cylinder, Cone, Torus, N-gon Prism):**
  unlike every other edit op, these need no existing operands — they build a new
  body from scratch and **append** it (`occtOperations.addPrimitive`, same
  `compound(existing shape + new solid)` pattern as `featureModel`). Unlike
  fillet/chamfer/feature-modeling, they are **NOT B-rep only** — the mesh engine
  builds them too, so the panel composer is deliberately never added to
  `brepOnlyEls`. `center` is the geometric centre for symmetric primitives (box,
  sphere, torus) and the **base** centre for extruded ones (cylinder, cone,
  prism) — matches OCCT's natural `gp_Ax2` placement.
  - **OCCT primitive API, verified against the live WASM** (use these exact
    suffixes): box `BRepPrimAPI_MakeBox_3(gp_Pnt_3 corner1, gp_Pnt_3 corner2)`
    (same overload booleans already use); sphere `BRepPrimAPI_MakeSphere_5(
    gp_Pnt_3 center, radius)`; cylinder `BRepPrimAPI_MakeCylinder_3(gp_Ax2_3(
    pnt, dir), radius, height)`; cone `BRepPrimAPI_MakeCone_3(gp_Ax2_3(pnt,
    dir), radius1, radius2, height)`; torus `BRepPrimAPI_MakeTorus_5(gp_Ax2_3(
    pnt, dir), majorRadius, minorRadius)`. Each class has many angle-partial
    overloads (`_1` through `_12` for sphere) — the indices above are NOT the
    first/simplest overload and were found by brute-force probing every index
    against known-good argument shapes, not by guessing from declaration order.
    There is no OCCT "regular polygon" primitive, so the **N-gon prism** is
    built manually: N points around `center` in the plane perpendicular to
    `axis` (computed via `planeBasis()`, pure JS cross-product math — an
    arbitrary non-parallel helper vector + two cross products, no OCCT calls)
    → `BRepBuilderAPI_MakeWire_1` + `.Add_1()` per `BRepBuilderAPI_MakeEdge_3(
    pnt, pnt)` edge → `BRepBuilderAPI_MakeFace_15(wire, true)` → the
    already-verified `BRepPrimAPI_MakePrism_1(face, vec, false, true)`.
  - **Mesh primitive API** (`meshEdits.buildPrimitiveMesh`): Three.js
    `BoxGeometry`/`SphereGeometry`/`CylinderGeometry`/`TorusGeometry`
    (`CylinderGeometry(radius, radius, height, sides)` — flat radial segments —
    doubles as the N-gon prism generator; `CylinderGeometry(radiusTop=radius2,
    radiusBottom=radius1, height)` is the cone). Three's canonical orientation
    is +Y-centred for cylinder/cone (base at local Y = −height/2) and
    +Z-normal, XY-plane-ring for torus — confirmed from the Three.js source,
    not assumed. `baseAlignedMatrix`/`centerAlignedMatrix` rotate the canonical
    axis onto the op's `axis` via `Quaternion.setFromUnitVectors`, THEN
    translate (base-aligned primitives translate by `+height/2` along the
    *rotated* axis so the base — not the mesh's local centre — lands on
    `center`); get this order wrong and cylinders float off-centre on any
    non-canonical axis (regression-tested in `meshEdits.test.ts` with a tilted
    `axis:[1,0,0]` cylinder).
  - **Id scheme (mesh only):** since `applyEditsMesh` always folds over a
    *fresh clone* of the pristine loaded object (`rebuildMeshModel` in
    `main.ts`), added primitives don't pre-exist in that clone — they are
    literally reconstructed on every single replay and tagged
    `userData.groupId = "prim-{K}"`, where `K` is a counter over only `addX`
    ops seen so far **in that fold pass** (reset to 0 at the start of every
    `applyEditsMesh` call). This is deterministic by op-list position, never
    collides with the loaded file's `node-N` ids (assigned once at load, before
    any edits exist), and is stable across repeated replays of the same list.
  - A primitive whose builder throws (host) or whose kind doesn't match any
    case (either engine) is skipped, same graceful-degradation rule as every
    other op.
- **2D profile sketches (Circle, Rectangle, N-gon Polygon) — B-rep only:** like
  primitives, these need no existing operands, but unlike primitives they build a
  bare **flat face** (no thickness), appended the same
  `compound(existing shape + new face)` way (`occtOperations.addProfile`/
  `buildProfileFace`). Their entire purpose is to be picked afterward (Surf mode)
  and fed into `extrude`/`revolve`/`sweep`/`loft` as the `profile` operand — so
  they are meshes-have-no-sketch **B-rep only**, added to `BREP_ONLY_OPS`, and the
  panel composer IS in `brepOnlyEls` (unlike the 3D primitive composer).
  - **CRITICAL — the tessellation pipeline had to be extended for this to work.**
    `tessellateByGroup` (`src/meshExtract.ts`) used to *only* extract faces
    belonging to a `TopAbs_SOLID`; a bare face mixed into the model compound
    would be silently dropped from the tessellated groups sent to the webview —
    never visible, never pickable, `face-N` never assigned. It now also runs a
    **free-face pass**: after tessellating each solid, it walks every face of the
    whole shape and, via the same `HashCode`-bucket + `IsSame` de-dup technique
    `extractEdges` already used for edges, skips any face already "claimed" by a
    solid — the remainder become one extra `"Sketches"` group. **This algorithm
    is duplicated (not shared code) in `occtOperations.ts`'s `collectFaces`/
    `addFreeFacesOf`, and the two MUST stay in lockstep** — `collectFaces`
    resolves `face-N` ids for every existing face-based op (extrude, revolve,
    sweep, loft, boolean's operand faces via mate, etc.), so if its face-visiting
    order ever diverges from `tessellateByGroup`'s, a `face-N` picked in the view
    will silently resolve to the *wrong* live face on the next edit. Verified
    end-to-end against the live WASM: a compound of one solid + one free face
    tessellates to exactly the expected face split (`{claimed: 6, free: 1}` for a
    box + circle); `addCircleProfile` immediately followed by `extrude` on its
    predicted `face-N` correctly resolves to the same face OCCT just built.
  - **OCCT circle API, verified against the live WASM:** `gp_Circ_2(gp_Ax2_3(pnt,
    normal), radius)` → `BRepBuilderAPI_MakeEdge_8(circ)` (of 35 total `MakeEdge`
    overloads — found by probing each index with a `gp_Circ` argument) →
    `BRepBuilderAPI_MakeWire_1` + `.Add_1()` → `BRepBuilderAPI_MakeFace_15(wire,
    true)`. Rectangle/polygon reuse the exact same wire/face code the N-gon prism
    uses (factored into a shared `buildFlatFace()` helper — `addPrism`'s inline
    version was refactored to call it too, regression-verified unchanged).
  - **Orientation is user-controlled, unlike the 3D primitives.** Rectangle/
    polygon take an explicit `up: Vec3` (in addition to `normal`) — `up` must not
    be (anti-)parallel to `normal` (`validateEditOp` rejects that). `inPlaneBasis
    (normal, up)` projects `up` off `normal` and normalizes it for the width axis
    `u`, then `v = normal × u` for the height axis — this is deliberately
    *different* from `planeBasis()` (used by the 3D N-gon prism), which picks an
    arbitrary perpendicular since a solid of revolution mostly doesn't care about
    polygon phase; a flat rectangle very much does. Verified end-to-end: a
    rectangle with `normal:[0,0,1], up:[1,0,0], width:10, height:6` produces the
    exact bbox `x:±5, y:±3, z:0`.
  - **Extruding a profile consumes it — no orphan duplicate.** `BRepPrimAPI_
    MakePrism_1(face, vec, false, true)`'s `Copy=false` means OCCT reuses the
    *original* face object as the resulting solid's base cap rather than copying
    it; after `addCircleProfile` → `extrude`, the free-face pass finds nothing
    left over (the circle face is now "claimed" by the new solid it became part
    of) — confirmed against the live WASM, not assumed.
  - A profile whose builder throws is skipped, same graceful-degradation rule.

## Bottom-up wireframe modeling (Points, Lines, Arcs → Surfaces → Volumes)

Users can also build shapes from scratch, bottom-up: create standalone **points**,
**lines**, and **arcs**; select a set of lines to build a **surface**; select a set
of surfaces to build a **volume**. All five ops are **B-rep only** — mesh files have
no wire/sewing concept, and since the two hardest ops (surface/volume) are
inherently B-rep-only, giving mesh files a sketch-only subset of the workflow would
be incoherent (same rationale as the 2D profile sketches above).

- **Points are a 4th first-class `EntityType`** (`"volume" | "surface" | "line" |
  "point"`), not a special case bolted on. Point-select mode shows **every vertex
  in the model** — original geometry's corners AND user-added standalone points —
  via the same unrestricted whole-shape explorer pattern `extractEdges` already
  used for edges (`extractVertices` in `src/meshExtract.ts`: `TopExp_Explorer_2
  (shape, TopAbs_VERTEX, TopAbs_SHAPE)` + `HashCode`/`IsSame` dedup, no
  discretization filter since a vertex is a single point, not a polyline). This
  is a *consistency* choice: Vol/Surf/Line already show everything (original +
  added), so Point mode doing the same is the coherent design, not a corner-cut —
  confirmed 8 unique corners on a plain box, 64 on `bull.stp`.
- **Points are NEVER resolved as operands by any other *editing* op** —
  `addLine`/`addArc` take typed `Vec3` coordinates, not point-id references,
  matching every other creation op in this codebase (Box/Sphere/.../Circle/
  Rectangle/Polygon all take pure numeric params). So for edit-op replay, point
  extraction is **display-only** — none of the lockstep-pipeline-pair risk the
  free-face fix had (nothing needs to resolve a `point-N` id back to a live
  vertex during editing). This is no longer *globally* true, though: `collectVertices`
  **was** added to `occtOperations.ts` for the Gmsh parts-preservation feature
  (`src/gmshPartsMap.ts`, see the Meshing section below), which does need to
  resolve a part's `point-N` ids back to live vertices for physical-group/sizing
  creation — mirrors `extractVertices`' exact `HashCode`+`IsSame` dedup order.
- **Point rendering: `THREE.Sprite`**, not `THREE.Points`/`PointsMaterial` (which
  packs every point into one `BufferGeometry` and raycasts to an index, not a
  distinct `Object3D` — breaking the "one entity, one tagged object" invariant
  every other picking/colouring path relies on) and not per-vertex `SphereGeometry`
  meshes (real triangle cost × N vertices, doesn't stay a constant screen size). A
  Sprite is individually pickable/colourable at near-zero cost and stays
  camera-facing. The dot texture is a single shared, canvas-drawn circle,
  **lazily built and memoized on first use** (`geometryBuilder.ts`'s
  `dotTexture()`) — NOT eagerly at module load like the texture itself might
  suggest, because `orientationCube.ts`'s existing texture-drawing code only runs
  inside a class constructor (lazy by construction); a naive `const DOT_TEXTURE =
  makeDotTexture()` at module scope broke `viewer.test.ts` (no jsdom in this
  project's vitest config — confirmed by the test failure, not assumed) since
  `geometryBuilder.ts` is transitively imported by `viewer.ts`, which
  `meshFromGeometry`'s pure-function tests import with zero DOM available.
- **Point hit-testing does NOT reuse `pickThreshold`** (that's specifically
  `raycaster.params.Line.threshold`, a Line-only knob) — sprites get their own
  proportional-to-model-radius `pointSpriteScale`, computed in `Viewer.frame()`
  alongside `pickThreshold`, applied to every point sprite's `.scale` each time
  the model is (re)framed.
- **OCCT wireframe-primitive API, verified against the live WASM:** point
  `BRepBuilderAPI_MakeVertex(gp_Pnt)` — **unsuffixed**, this class (like
  `BRepBuilderAPI_Sewing` below) has no `_N` overloads in this binding, unlike
  almost everything else — → `.Vertex()`. Line reuses the already-verified
  `BRepBuilderAPI_MakeEdge_3(pnt, pnt)`. Arc reuses the already-verified
  `gp_Circ_2(gp_Ax2_3(pnt, normal), radius)`, trimmed via `BRepBuilderAPI_
  MakeEdge_9(circ, alpha1, alpha2)` (radians; found by probing all 35 `MakeEdge`
  overloads with a `(gp_Circ, number, number)` argument shape) — confirmed to
  sweep in the increasing-angle (counterclockwise about `normal`) direction,
  wrapping through 0 if `alpha2 < alpha1`.
- **OCCT surface-from-lines API, verified against the live WASM:**
  `BRepBuilderAPI_MakeWire_1` + `.Add_1()` per selected edge (resolved via the
  **existing** `collectEdges`, zero changes needed) — confirmed to auto-assemble
  edges added in **shuffled (non-sequential) order** by their shared vertices, so
  pick order in the view doesn't matter. `.IsDone()` is the primary graceful-skip
  gate: `false` for genuinely disconnected edges (no shared vertices at all,
  confirmed via a probe), `true` for anything that connects — **including an
  "almost closed" open chain that doesn't loop back to its start**, which OCCT
  wires are not required to do. No reliable "is this wire actually a closed loop"
  API was found in this binding (`BRepTools.IsReallyClosed`/`DetectClosedness`
  need extra args this binding doesn't expose usefully; `ShapeAnalysis_Wire.
  CheckClosed` didn't distinguish a closed 4-edge square from an open 3-edge one
  in testing) — accepted: `BRepBuilderAPI_MakeFace_15(wire, true)` on an open
  chain may still produce a best-effort face in this OCCT build, which is
  harmless (never a crash), not a silently-wrong result that matters for this
  feature's purpose. The resulting face benefits from the existing free-face
  pass with **zero further pipeline changes**.
- **OCCT volume-from-surfaces API, verified against the live WASM** (the riskiest
  new surface in this feature — probed with 6 *mutually disconnected* faces built
  independently via `buildFlatFace`, matching what a user actually selects, NOT
  `BRepPrimAPI_MakeBox`): `new BRepBuilderAPI_Sewing(tolerance, true, true, true,
  false)` (only constructor, all 5 params required — no defaulted overload in
  this binding) → `.Add(face)` per face → `.Perform(new Handle_Message_
  ProgressIndicator_1())` (needs this progress-handle arg, unlike most
  single-shape ops elsewhere in this file) → `.SewedShape()`, then an explorer
  pulls the `TopAbs_SHELL` out via `TopoDS.Shell_1`. **Closure check — verified
  NOT to be `.IsNull()`, volume sign, or `BRepCheck_Analyzer`** (all tried and
  rejected): `BRepBuilderAPI_MakeSolid` happily builds a non-null "solid" from an
  OPEN shell, and `BRepGProp.VolumeProperties` returns a plausible-looking
  *wrong* number for one too. The reliable signal is **`sew.NbFreeEdges()`**:
  exactly `0` for a properly closed shell, `>0` for an open one (confirmed: 0 for
  a full 6-face box, 4 for 5-of-6, 8 for 3-of-6) — this is the gate
  `addVolumeFromSurfaces` uses. `BRepBuilderAPI_MakeSolid_3(shell)` builds the
  solid (found by brute-force probing all 7 numbered overloads). **Unlike
  `extrude`'s `Copy=false` (which consumes its source face), sewing does NOT
  consume the input faces** — verified end-to-end on `bull.stp`: after sewing 6
  rectangle-profile faces into a box solid, all 6 originals remain visible in
  "Sketches" alongside the new solid's own 6. Accepted, not a bug — the sketches
  stay available to reuse; suppressing them would need excluding specific faces
  from the compound rebuild, extra complexity for a cosmetic concern.
- Every op in this family is skipped (returns the unmodified shape) on
  unresolved operands, a builder throw, or (surface/volume specifically) a
  structurally invalid selection — same graceful-degradation rule as every
  other op in this file.

## Edits panel redesign (GEOMETRY/EDIT tabs) + extended op catalog

The Edits panel is a single panel with two top-level tabs — **GEOMETRY**
(creation, with **2D**/**3D** subtabs) and **EDIT** (modification, one
categorized list) — sharing the one op stack, undo/redo/Clear header, and
history list. Op buttons render as icon grids; clicking one opens its param
form in the shared `#edits-params` area. Non-negotiable invariants:

- **`src/webview/opCatalog.ts` is the single source of truth for the tab
  structure** (pure, DOM-free, unit-tested). A `PanelOpId` is one op *button*
  (booleans are 3 buttons over the one `boolean` kind; each entry's `kinds`
  ties it back to `EditOpKind`s). `describeOp` lives here now (re-exported from
  `editsPanel.ts`). `opCatalog.test.ts` locks: unique ids, icon completeness,
  `brepOnly` ↔ `BREP_ONLY_OPS` agreement over `kinds`, every `EditOpKind`
  reachable from ≥1 button, and **every 2D-tab entry B-rep-only** (that last
  one is what makes greying the whole 2D subtab for meshes valid).
- **`src/webview/opIcons.ts` is the ONE file to edit to swap in real icons**
  (`Record<PanelOpId, string>` — a missing icon is a compile error). Values
  render as `<span class="op-icon">` text; placeholders are unicode glyphs.
- `setBRepOnly` works per op-button (each brepOnly button is in `brepOnlyEls`,
  held by reference) plus the whole **2D subtab**; disabling also collapses an
  open B-rep-only form and auto-switches 2D→3D. The callback-draft
  architecture is unchanged (`main.ts` merges live selection into drafts).
- **Hole ops (`addHole`/`addCounterboreHole`/`addCountersinkHole`) are
  subtractive and run on BOTH engines** (host `cutHole()` via verified `Cut_3`;
  mesh `applyMeshHole()` via three-bvh-csg). **meshEdits dispatch-order trap:**
  their names start with `add`, so `applyEditsMesh` MUST handle them *before*
  the `op.op.startsWith("add")` primitive branch, and they never increment the
  `prim-{K}` counter — both regression-tested in `meshEdits.test.ts`.
- **`shell` requires ≥1 opening face** — verified: `MakeThickSolidByJoin` with
  an EMPTY closing list returns the plain inner offset solid (volume 512 for a
  −1 offset of a 10-box), NOT a hollow solid; with a closing face it hollows
  correctly (424 = 1000 − 8·8·9). The op has no `targets` — the host derives
  each opening face's owning solid.
- **`splitByPlane` is a half-space cut with zero new bindings** (deliberately
  not a `BRepAlgoAPI_Splitter` probe): an axis-aligned box on the negative
  side of z=0 (10× bbox diagonal) moved onto the plane with the mate-verified
  `gp_Trsf.SetDisplacement(gp_Ax3, gp_Ax3)`; positive→`Cut_3`,
  negative→`Common_3`, both→compound. `section` intersects a big
  `buildFlatFace` plane with the targets via `Common_3` (verified: exactly the
  trimmed cross-section face) and appends it — it shows up under "Sketches"
  via the existing free-face pass, extrudable like any sketch.
- **`addSpline` is an approximating fit, not exact interpolation** —
  `GeomAPI_Interpolate` (and the `TColgp_HArray1OfPnt` ctor it needs) is NOT
  bound in this build; `GeomAPI_PointsToBSpline_2` is endpoint-exact with tol
  1e-6, which is what the op uses. Label it "Spline", don't promise exactness.
- **OCCT APIs verified against the live WASM for the new ops** (exact
  suffixes; found by the usual brute-force overload probing):
  - explicit-X placement `gp_Ax2_2(gp_Pnt, gp_Dir n, gp_Dir vx)` — the given X
    is projected into the plane and normalized (verified numerically);
  - ellipse `gp_Elips_2(ax2, major, minor)` (major ≥ minor **enforced by
    OCCT** — swap the in-plane basis 90° + radii when radiusY > radiusX; for a
    *trimmed* arc also shift both angles by −90° so they stay measured from
    `up`) → full `BRepBuilderAPI_MakeEdge_12(elips)` / trimmed
    `MakeEdge_13(elips, a1, a2)` (radians, CCW from the Ax2 X-dir);
  - point array `TColgp_Array1OfPnt_2(1, n)` + `.SetValue(i, pnt)` (1-based);
  - Bézier `Geom_BezierCurve_1(arr)`; any Geom curve handle → edge via
    `Handle_Geom_Curve_2(handle.get())` + `MakeEdge_24(hCurve)`
    (`edgeFromCurveHandle` in `occtOperations.ts`);
  - 3-point arc `GC_MakeArcOfCircle_4(p1, p2, p3)` → `.Value()` →
    `edgeFromCurveHandle` (`IsDone()` false for collinear = the skip gate);
  - spline `GeomAPI_PointsToBSpline_2(arr, 3, 8, GeomAbs_Shape.GeomAbs_C2,
    1e-6)` → `.Curve()`;
  - helix `gp_Ax3_4` → `Geom_CylindricalSurface_1(ax3, r)` →
    `Handle_Geom_Surface_2`; `gp_Pnt2d_3(u, v)` (u = angle rad, v = height) →
    `GCE2d_MakeSegment_1` → `Handle_Geom2d_Curve_2` →
    `MakeEdge_30(h2dcurve, hsurface)` → `BRepLib.BuildCurves3d_2(edge)`
    (static, 1-arg; `BuildCurves3d_1` wants 5 args);
  - wedge `BRepPrimAPI_MakeWedge_1(dx, dy, dz, ltx)` /
    `MakeWedge_2(ax2, dx, dy, dz, ltx)` — the Ax2 location is the local
    ORIGIN CORNER (offset by −dx/2·u −dy/2·v to centre the base on `center`);
  - shape list `TopTools_ListOfShape_1()` + `.Append_1(shape)` + `.Size()`
    (there is NO `.Extent()`);
  - shell `new BRepOffsetAPI_MakeThickSolid_1()` + `.MakeThickSolidByJoin(
    solid, list, offset, tol, BRepOffset_Mode.BRepOffset_Skin, false, false,
    GeomAbs_JoinType.GeomAbs_Arc, false)` — exactly 9 args, the 10th progress
    arg is the usual unconstructible `Message_ProgressRange`.
- New-op families follow every existing rule: single `validateEditOp` gate,
  graceful skip on unresolved operands / builder throw / `IsDone()` false,
  `compound(existing + new)` append for creation ops, `booleanSolids`-style
  target-replacement for holes/split.

## Parametric variables (expressions in edit-op fields)

Users define named variables (`L = 20`) in a table at the top of the Edits panel
and type expressions (`L*2`) into any numeric op field; changing a variable
re-resolves and rebuilds the geometry live. Non-negotiable invariants:

- **Expressions are an annotation, numeric fields are last-good caches.** An op
  may carry `exprs?: Record<fieldPath, exprString>` (`length`, `size[1]`,
  `points[2][0]`); the addressed numeric fields always hold the most recent
  successful evaluation. Every consumer (`validateEditOp` invariants, both edit
  engines, export, meshing) keeps operating on plain numbers — only
  `resolveEditOps` (`src/editVariables.ts`) reads `exprs`. `validateEditOp`
  sanitizes the annotation (keys must address a finite numeric slot of the
  *validated* op; values must be syntactically valid, size-capped) and carries
  it onto the clean op.
- **Resolution happens at exactly two sites** — `parseEditsJson` (heals stale
  caches in hand-edited sidecars) and the webview's resolve-on-read
  (`currentResolvedOps()` in `src/webview/main.ts`, re-run at every consumption
  point: the `editsChanged` post, panel render, mesh rebuild). The host
  receives already-resolved ops and never evaluates expressions at runtime;
  `EditsModel` is deliberately not variables-aware. Resolve-on-read (rather
  than eagerly patching stored ops on a variable change) is what keeps
  redo-buffer ops from resurfacing with stale numbers — don't "optimize" it
  into a patch pass.
- **The evaluator is a hand-written recursive-descent interpreter**
  (`src/paramExpr.ts`, pure + unit-tested) — webview CSP blocks `eval()`, never
  reintroduce it. Trig functions take **degrees** (every op angle field is
  `*Deg`).
- **Variables live in the same `<model>.edits.json`** (optional `variables`
  field, omitted when empty; `version` stays 1 — the parser never checked it
  and tolerates the missing field). A variable is `{name, expr, value}` where
  `value` is its own last-good cache. A variable's expression may reference
  only variables defined **above it** in the list — derived values (`W = L/2`)
  with zero cycle-detection machinery, since cycles are unrepresentable.
- **Failures freeze, never crash** (same graceful rule as unresolved operand
  ids): a failing variable keeps its cached `value`; an op whose expression
  fails keeps that field's cache (other fields still apply); an op whose
  *resolved* values would violate a cross-field invariant (torus
  `minorRadius ≥ majorRadius`) is kept wholly at its previous values —
  `resolveEditOps` re-validates the patched clone and reverts on failure,
  recording a human-readable issue that main.ts surfaces via `setStatus`.
- **Variable mutations are NOT undoable ops** — `VariablesModel` mirrors
  `PartsModel` (own `onChange`, silent `load()`), outside the op stack.
- **Panel plumbing:** numeric inputs are `type="text"` (`inputmode=decimal`);
  the field readers (`readNum`/`readVec`/`rowVec`) evaluate non-numeric text
  and side-collect the raw strings keyed by op field path;
  `EditsPanel.wrapCallbacks` (constructor) attaches the collected map to the
  outgoing draft — or aborts the apply on an eval error — so the ~40 per-op
  apply closures stay untouched. **Exprs keys must equal op field names**:
  main.ts copies `draft.exprs` verbatim onto the pushed op; the one mismatch is
  fillet/chamfer's shared `amount` field, remapped to `radius`/`distance` in
  `onApplyFillet`. Keep that alignment when adding ops.

## Meshing (GMSH-JS)

Users can generate a finite-element mesh (nodes + triangles/tetrahedra) of the
currently displayed model with [Gmsh](https://gmsh.info) compiled to WebAssembly
via `@loumalouomega/gmsh-wasm`, shown as an overlay on top of the existing view.
Non-negotiable invariants:

- **GMSH runs host-only, never in the webview** — a second, independent
  Emscripten module from OCCT's, but the same architectural rule: `src/gmshService.ts`
  holds the singleton, `src/webview/*` only ever sees the resulting triangulation
  buffers over the postMessage protocol, never the GMSH API itself.
- **Lazy WASM init, mirroring OCCT's.** Never call the factory in `activate()`.
  `getGmsh(extensionPath)` initializes on the first call — i.e. the first click of
  **▶ Generate** or **📤 Export** (any format), never on file open —
  and memoizes the resolved promise as a module singleton. Subsequent generations
  reuse it; per-generation state resets via `gmsh.clear()` + `gmsh.model.add(...)`,
  never a second `gmsh.initialize()`.
- **`wasmBinary` must be passed explicitly — same Node fetch-path lesson as OCCT.**
  `getGmsh` reads `dist/gmsh-core.wasm` via `fs.readFileSync` and passes it as
  `wasmBinary` to the raw Emscripten factory; letting the factory try to resolve
  its own path fails the same way `initOpenCascade`'s zero-arg wrapper does (see
  "WASM loading" above).
- **Default 3D algorithm is Frontal (`Mesh.Algorithm3D = 4`), not GMSH's own
  default.** The WASM build has a documented 3D Delaunay boundary-recovery bug on
  geometry re-imported via `gmsh.model.occ.importShapes` — i.e. every B-rep source
  this feature meshes, by definition, since it's always imported that way. Frontal
  avoids the failure mode for the common case (opening a STEP/IGES/BREP file) out
  of the box; users can still pick Delaunay (`1`) from the 3D algorithm dropdown
  for cases it doesn't affect. See `doc/gmsh-integration.md`'s "Known limitations"
  for the full verification trail (GMSH-JS's own README documents this upstream).
- **The panel's primary size control is a coarser→finer slider with a
  bbox-derived default — and seeding it must never create sidecars.**
  `DEFAULT_MESH_OPTIONS.sizeMax` is the Gmsh "unbounded" `SIZE_MAX_SENTINEL`
  (`1e22`); once the model's extents are known, `syncMeshSizeSeed()`
  (`src/webview/main.ts`, called from the `geometry`/`loadUrl`/`meshingOptions`
  handlers — their arrival order is not deterministic) replaces a still-sentinel
  `sizeMax` with `diagonal/20` via **`MeshingModel.load()`, never `update()`** —
  `update()` fires `meshingChanged`, which would write `.mesh.json`/`.geo` for
  every file merely opened. A persisted user value (≠ sentinel) always wins; the
  panel never displays the raw `1e+22` (empty "auto" Size max field, disabled
  slider until seeded). All slider math (log mapping `diagonal/5`↔`diagonal/200`,
  Coarse/Medium/Fine presets `diagonal/{10,20,50}`, and the order-of-magnitude
  element-count estimate feeding the readout + the ~1M-element warning) lives in
  the pure, headless-tested `src/webview/meshSizeHeuristics.ts` — plain JS from
  the bbox (`Viewer.getModelExtents()`) only, **never a gmsh call**, so the
  lazy-WASM invariant holds. Slider/preset/field commits that would drop
  `sizeMax` below `sizeMin` patch `sizeMin: 0` in the same update, or
  `validateMeshOptions`' pair rule silently resets both on reload. The slider
  commits on `change` (release), not `input` (mid-drag) — no message spam. The
  panel also mirrors the Parts panel's per-part `meshSize` inputs (a "Part
  sizes" section routing to the same `PartsModel.setMeshSize`) and tucks the
  raw options form — including the STL angle field, disabled for B-rep sources
  via `setSourceKind` — into a collapsed-by-default "Advanced settings" section.
- **Element shape & order.** `MeshOptions.elementOrder: 1|2` → `Mesh.ElementOrder`
  (quadratic adds mid-side nodes; the overlay draws corner geometry only).
  `MeshOptions.elementShape: "simplex"|"subdivided"` → `Mesh.RecombineAll` +
  `Mesh.SubdivisionAlgorithm` via the shared `gmshShapeOptions(shape, dimension)`
  helper (`src/meshOptions.ts`), reused by both `loadGeometryAndApplyOptions` and
  `generateGeoScript` so they can't drift. Recipe is **dimension-dependent and
  WASM-verified**: 2D quads via Blossom `RecombineAll=1`; 3D hexes via
  `SubdivisionAlgorithm=2` (3D `RecombineAll` throws). Both option values are set
  every generate (the singleton persists options across `clear()`). **A
  hex-*dominant* mixed mode is deliberately NOT offered** — `Mesh.Recombine3DAll`
  is completely non-functional in the bundled gmsh-wasm build (every variant
  probed produced pure tets or threw); `validateMeshOptions` rejects
  `"hexDominant"`. See `doc/gmsh-integration.md`'s "Known limitations".
- **Sidecar pair `<model>.mesh.json` + `<model>.geo`, beside parts/edits.** The
  FE-mesh options (`MeshOptions` — a flat bag, not an op-list) autosave (~500 ms,
  its own debounce timer, separate from parts/edits) to `<model>.mesh.json` via
  `src/meshOptionsStore.ts`; parse/serialize live in the vscode-free
  `src/meshOptionsSidecar.ts` so they unit-test. `validateMeshOptions` is the
  single tolerance gate — an individually invalid field falls back to
  `DEFAULT_MESH_OPTIONS` for that field alone, never rejecting the whole object.
- **The `.geo` file is ONE-WAY generated — hand-edits are never read back.** On
  the same debounce, `writeGeoScript()` regenerates `<model>.geo` wholesale from
  the current `MeshOptions` (`generateGeoScript` in `meshOptionsSidecar.ts`).
  GMSH-JS has no API to emit a clean, parametric `.geo` script from in-memory
  state — only the fully-expanded `.geo_unrolled` form via `gmsh.write()`, which
  is what picking "Gmsh Geometry (.geo_unrolled)" in the panel's export
  `<select>` and clicking **📤 Export** actually produces (`exportGeoUnrolled`
  in `gmshService.ts`), a *different* file from the autogenerated sidecar
  `.geo`. The sidecar `.geo`'s own header comment says as much; any manual edit
  to it is silently overwritten on the next options change.
- **Export formats are a single shared registry, not one button per format.**
  `src/meshExportFormats.ts`'s `MESH_EXPORT_FORMATS` (`{id, label, extension,
  filterLabel}[]`) is imported by both the host (picks the MEMFS write
  extension `gmsh.write()` dispatches on, and the save-dialog filter) and the
  webview (`meshingPanel.ts` populates the export `<select>` from it) — the
  original design had one button per format (`📤 .msh`, `📤 .geo`), which
  doesn't scale once more formats are added. Every format id except `"msh"`
  (reuses `generateMesh`'s `mshText`), `"geoUnrolled"` (its own XAO-companion
  handling, see below), and `"mdpaElements"`/`"mdpaGeometries"` (see next
  bullet) routes through `gmshService.ts`'s generic `exportMeshFormat()`:
  mesh, then `gmsh.write("/out.<extension>")`, then read back as text —
  confirmed against the live WASM build for all 10 other registered formats
  (`msh2`, `vtk`, `unv`, `inp`, `bdf`, `su2`, `mesh`, `stl`, `diff`, `off`).
  CGNS and MED are recognized by Gmsh's writer-dispatch table but throw
  `"...compiled without CGNS support"`/`"...must be compiled with MED
  support..."` in this build (need HDF5-backed libs not linked in) — excluded
  from the registry rather than offered as an always-failing option. See
  `doc/gmsh-integration.md`'s "Export formats" section for the full probe
  results and which other formats were excluded as unusable/redundant.
- **Kratos MDPA is hand-written — the one export format with no `gmsh.write()`
  support at all.** `mdpaElements`/`mdpaGeometries` are listed *first* in
  `MESH_EXPORT_FORMATS`, making `mdpaElements` the default-selected export
  format. `src/mdpaWriter.ts` (pure, vscode/WASM-free, unit-tested in
  `mdpaWriter.test.ts` against hand-built fixtures — mirrors `partsSidecar.ts`/
  `editOps.ts`'s pure-module convention) serializes a plain `MdpaMesh`
  (`{nodes, volumeCells, surfaceCells, groups}`, where each `MdpaCell` is
  `{kind, nodeTags}`) to ASCII text; `gmshService.ts`'s `exportMdpa()` +
  private `extractMdpaMesh()` pull that data off the live gmsh model after
  `mesh.generate()` (per-entity-tag `getElements(dim, tag)` loops, same
  pattern as `extractBoundaryFaces`/`appendTriangles2D`) and hand it to
  `writeMdpa()` — no MEMFS write/read-back round trip. Two mutually exclusive
  modes: `"elements"` writes one `Element*` block per volume kind +
  `Condition*` per surface kind (each `<id> <prop_id> <n1..nk>`, `prop_id`
  always `0` in a single `Begin Properties 0` block); `"geometries"` writes
  `Geometries` blocks (`<id> <n1..nk>`, **no** property id) which, per Kratos's
  single `Geometries` container, **share one id space** (all volume kinds
  `1..V`, then all surface kinds `V+1..V+S`). A kind's root block and its
  matching `SubModelPart*` sub-block are omitted when empty.
- **The full cell catalogue (linear + quadratic tet/hex/prism/pyramid/tri/quad)
  flows through the single `src/gmshElementTypes.ts` table** — the ONE source of
  truth for every gmsh type's stride, corner count, boundary-face decomposition,
  Kratos block names, and gmsh→Kratos node permutation. Both the overlay builders
  (`surfaceTriangles`/`boundaryTriangles`, now the guts of `appendTriangles2D`/
  `extractBoundaryFaces`) AND `extractMdpaMesh` resolve types through it, so they
  can never drift (replaces the old duplicated-and-must-stay-in-lockstep risk).
  A genuinely unmapped type throws (graceful backstop). **Permutations were
  DERIVED by coordinate-matching against the live WASM** (`getElementProperties().
  localNodeCoord`, not docs): linear cells + `tri6`/`quad9` are identity, `tet10`
  is `[0,1,2,3,4,5,6,7,9,8]`, `hex20`/`hex27`/`prism15`/`pyramid13` are non-trivial.
  Complete order-2 prism18/pyramid14 **truncate** to Kratos `Prism3D15`/`Pyramid3D13`
  (their leading nodes coincide — verified). Geometry block names are certain;
  the newer kinds' `Element*`/`Condition*` names are best-guess transcriptions
  pending Kratos-dev confirmation, so `"elements"` mode pre-flights an actionable
  "use Geometries mode" throw if any produced kind's element/condition name is
  `null` (all filled today, so the guard is dormant).
- **Node ordering / orientation**: `mdpaWriter.ts`'s `orientCell()` recomputes each
  cell's signed volume (divergence theorem over the kind's OUTWARD boundary faces —
  `signedVolume` in `gmshElementTypes.ts`) and, for a negative tet, applies the
  well-defined `tet4`/`tet10` flip (`[0,1,3,2]` / `[0,1,3,2,4,8,7,6,5,9]`); a
  negative hex/prism/pyramid (which gmsh shouldn't emit) is passed through with an
  `onWarning` callback, no unsafe reshuffle. **SubModelParts** map 1:1 to `Part[]`
  (flat, B-rep only). `extractMdpaMesh()`'s `groupPartsAcrossDims()` reuses
  `PartGroupMaps` to bucket cells per part + resolve `lines`/`points` to extra
  node ids (edges/points contribute only to `SubModelPartNodes`). `SubModelPartNodes`
  is the **union** of explicit point/curve selections and every node (incl.
  mid-side) of the grouped cells. Deterministic: node ids by source tag, cell ids
  by canonical node-tuple within a kind, kinds in fixed `VOLUME_KIND_ORDER`/
  `SURFACE_KIND_ORDER`. Verified end-to-end on `angle1.stp` across all four
  `{simplex, subdivided} × {order 1, 2}` combos (watertight overlays, no orient
  warnings, all block names present). See `doc/gmsh-integration.md`'s "Kratos MDPA"
  + "Element shapes & order" sections.
- **Two input paths converge on the same options step.** B-rep documents
  (`kind: "brep"`) re-export the live OCCT shape to STEP bytes via the existing
  `exportBRep()` (so unsaved edits are reflected) and load them with
  `gmsh.model.occ.importShapes` + `synchronize`. Mesh documents (`kind: "stl"`)
  have no B-rep to re-export, so the *webview* serializes the currently displayed
  `THREE.Object3D` to STL (`currentStlIfMeshSource()` in `main.ts`, reusing the
  same `exportModel(..., "stl")` Export already uses) and sends it up as a base64
  `stl` field on `meshingGenerate`/`meshingExport`; the host then reclassifies the
  raw triangle soup into surfaces (`classifySurfaces` → `createGeometry` →
  `addSurfaceLoop`/`addVolume` → `synchronize`) since STL has no volume topology.
- **The mesh overlay is a scene sibling of the model, never mutating the original
  geometry.** `geometryBuilder.buildFEMesh(positionsB64, indicesB64)` builds a
  freestanding `THREE.Group` (a shaded mesh + wireframe, both tagged
  `userData.entityType = "mesh"` — deliberately not `"surface"`/`"line"`, so
  existing picking/parts-colouring code never touches it). `Viewer.setMeshOverlay()`
  adds/replaces it as a sibling of `model` in the scene (never a child), disposing
  the previous overlay's geometries/materials on swap. **It is auto-cleared when a
  new model loads** — `setModel()` calls `setMeshOverlay(null)` as its very first
  line, since a previously-generated overlay was computed from the *old* geometry
  and must not linger looking valid. The toolbar's **🔬 FE Mesh** toggle
  show/hides the *existing* overlay in place (`Viewer.setMeshOverlayVisible()`,
  `Object3D.visible`, no dispose) rather than clearing it — toggling off then
  back on must redisplay the same generated mesh instantly, with no need to
  re-run Generate. Only three things actually dispose the overlay: a new model
  loading (above), the panel's **Clear** button, and a fresh **Generate**
  replacing it with a new one; all three also reset the toggle's `.active`
  state to stay truthful about what's currently displayed (same rule
  `meshingResult`/`meshingError` already followed for Generate — the toggle
  must never claim "on" for content that isn't actually shown). The FE Mesh
  panel itself is always present in the sidebar regardless of toggle state.
- **The overlay's shaded mesh is unlit (`MeshBasicMaterial`, one per
  `elementGroups` entry — see below), not `MeshStandardMaterial` like every
  other face material in this codebase.** A tet-mesh boundary is
  thousands of small, irregularly-oriented triangles — unlike a B-rep face's
  smooth NURBS-tessellated triangulation — so a lit material shades each one
  differently under the scene's directional/hemisphere lights; triangles
  facing away from the light go dark/near-black, which reads as scattered
  holes even though the geometry is a complete, watertight surface (verified:
  re-running the STEP-export→GMSH-tetrahedralize→boundary-extraction pipeline
  standalone on `examples/STP/angle1.stp` and rendering the raw output
  triangles headlessly showed a complete boundary from every angle — the
  "holes" were a shading artifact, not a gap in the GMSH-generated geometry).
  A flat unlit color removes that per-facet brightness variation entirely.
  `buildFEMesh`'s `THREE.LineSegments` wireframe is built from the host-supplied
  **true element-edge** buffer (`MeshResult.edges` → `meshingResult.edges`),
  NOT a `THREE.WireframeGeometry` of the triangulated fill. This matters for
  recombined meshes: a hex boundary is quad faces, each split into 2 triangles
  for the shaded fill — `WireframeGeometry` would draw the diagonal across every
  quad, making a hex mesh look identical to a tet mesh. `gmshElementTypes.ts`'s
  `boundaryEdges`/`surfaceEdges` emit only the polygon perimeters (quad → its 4
  edges, tri → 3), deduplicated across shared faces, so hexes render as quads and
  tets as triangles (verified on `angle1.stp`: subdivided gives edges = quad
  perimeters with no diagonals, ratio 1.0 edges-per-fill-triangle vs 1.5 for
  tets). The wireframe shares the fill's `positions` (own line index buffer) and
  is perfectly coincident with the triangles, so the shaded material still needs
  `polygonOffset: true` (+ `polygonOffsetFactor`/`polygonOffsetUnits: 1`) or the
  GPU depth test can't reliably resolve filled-triangle-vs-coincident-line per
  pixel (z-fighting speckle).
- **`setMeshOverlay()` also hides the model's shaded faces while an overlay is
  shown** (`entityType === "surface"` meshes get `.visible = false`; edges/points
  stay visible as a feature-line reference), restoring them when the overlay is
  cleared. Two opaque solids occupying the same space are unreadable stacked on
  each other — display-only, never touches geometry, same "never mutate the
  original" invariant as the overlay itself.
- **Generate has no progress reporting from GMSH itself** — `gmsh.model.mesh.
  generate()` is one opaque blocking WASM call with no progress hook (`GmshLogger`
  only exposes post-hoc wall/CPU time). `MeshingPanel.setBusy(true/false)`
  (called from `onGenerate` before posting, and from the `meshingResult`/
  `meshingError` handlers) is therefore an indeterminate signal only: it disables
  `#meshing-generate` and shows a CSS keyframe-sweep progress bar
  (`#meshing-progress`) plus a `"Generating…"` status line. **📤 Export** (any
  format) isn't wired to it — its save-dialog completion already surfaces
  through the generic toolbar status bar.
- **Parts are preserved in generated meshes as Gmsh physical groups —
  B-rep sources only**, matching the existing `BREP_ONLY_OPS` scope (Gmsh's STL
  reclassification pipeline produces brand-new surface/volume tags with zero
  correlation to a mesh document's original ids, so there is no reliable
  per-part correlation for STL/OBJ/PLY/glTF sources). `src/gmshPartsMap.ts`'s
  `applyPartsToGmshModel` resolves each part's `face-N`/`edge-N`/`solid-N`/
  `point-N` ids to Gmsh `(dim,tag)` entities **geometrically** — bounding-box
  centre matching between CAD-Preview's own OCCT (`bboxCenter`, already used by
  `explodeSolids`) and Gmsh's own `getBoundingBox`, both computed from the
  *same* STEP bytes (their two independent, separately-versioned OCCT builds
  give no ordering guarantee, so `importShapes`'s `outDimTags` order is
  deliberately **not** relied on) — within a tolerance of `1e-3 × model bbox
  diagonal`, accepted only if unambiguous. An unresolved/ambiguous entity is
  silently skipped, same graceful-degradation rule as every other unresolved-id
  path in this codebase. Resolved entities become one
  `gmsh.model.addPhysicalGroup(dim, tags, -1, part.name)` per part per
  dimension, which lands in `.msh` output's `$PhysicalNames` section
  automatically once created. **`gmsh.write()`'s `Mesh.SaveAll` option must be
  forced to `1`** (`loadGeometryAndApplyOptions`, unconditionally, parts or no
  parts) — Gmsh's own default (`0`) writes only elements belonging to *some*
  physical group once *any* physical group exists, so the instant one part
  resolves one entity, every other entity's elements would otherwise vanish
  from `.msh`/`.geo_unrolled` output (physical groups are meant to tag a subset
  of a full mesh here, never filter it — confirmed as a real, silent regression
  before this override was added: one part on 1 of 15 surfaces produced a
  `.msh` containing only that surface's 88 triangles). The **live** overlay is
  unaffected by `Mesh.SaveAll` either way — it's built from `getNodes()`/
  `getElements()` calls directly against Gmsh's in-memory model, not from
  re-reading a written file. **Confirmed against the live WASM**
  (`examples/STP/angle1.stp`): a no-parts baseline generate produced 499 nodes;
  the same geometry with one volume-scoped part's `meshSize: 0.5` produced
  235,088 nodes (clear, correctly-directed local refinement, not a silent
  no-op), and the resulting `.msh`'s `$PhysicalNames` section listed both a
  volume- and a surface-scoped part by name at the right dimension. One
  confirmed gap from that same pass: for a **3D** (`dimension === 3`) generate,
  a **surface**-scoped part still gets its own `Physical Surface` in `.msh`
  output correctly, but does **not** get its own overlay colour range
  (`buildIndices3D` only groups triangles by their owning *volume*, since
  Gmsh's tet-boundary triangles carry no parent-B-rep-surface link) — it falls
  into the default-blue trailing range instead. **2D** generates are
  unaffected (`buildIndices2D` groups directly by surface). **`.geo_unrolled`
  output does NOT carry `Physical Volume(...)`/`Physical Surface(...)` as
  textual statements for B-rep sources at all** — see the next bullet for why
  and how it's made to round-trip them anyway. See `doc/gmsh-integration.md`'s
  "Parts → physical groups" section for the full write-up.
- **`gmsh.write("*.geo_unrolled")` cannot textually inline OCC-imported B-rep
  geometry** — confirmed against the live WASM: for every B-rep source, it
  writes a single-line stub (`Merge "/out.geo_unrolled.xao";`) referencing a
  companion **XAO** file (Gmsh's own OCC-preserving exchange format, which does
  preserve shapes + physical groups + mesh-size fields) it wrote alongside in
  MEMFS — a path this code originally never read back, so the exported
  `.geo_unrolled` was a dangling reference to a file that didn't exist on the
  user's disk. `gmshService.ts`'s `exportGeoUnrolled` now returns `{ text, xao
  }` (`xao` is `null` for the STL/GEO-kernel path, which unrolls fully inline
  with no companion needed); `provider.ts`'s `meshingExport` "geo" branch
  writes the XAO bytes as a sibling of the chosen save path and rewrites the
  stub's `Merge` reference to that sibling's relative filename before writing
  the `.geo_unrolled` text, so the pair is self-contained. Verified end-to-end:
  reopening the rewritten pair in a fresh Gmsh model restored the same
  volume/surface counts, the same physical groups, and — after re-running
  `mesh.generate()` — the same node count as the original sized-part generate.
- **A part's optional `meshSize` (a single target size, not min/max) becomes a
  Gmsh `Constant` field** scoped to that part's resolved entities (`VIn` +
  `PointsList`/`CurvesList`/`SurfacesList`/`VolumesList`), and all parts'
  Constant fields combine via a `Min` field set as the background mesh — so the
  smallest requested size wins on overlap, and unsized regions keep the global
  `sizeMin`/`sizeMax` clamps. **STL/mesh sources can't get per-entity sizing**
  (no correlation, same as physical groups above) — instead
  `meshOptions.ts`'s `applyStlPartSizeOverride` applies a one-off
  `sizeMin`/`sizeMax` override for that one generate/export call **only** when
  *exactly one* part in the document has `meshSize` set (never persisted to
  `<model>.mesh.json`; 0 or 2+ sized parts is ambiguous and silently no-ops).
- **The mesh overlay is multi-material, one `MeshBasicMaterial` per
  `meshingResult.elementGroups` entry** (`{name,color,indexStart,indexCount}`,
  via `THREE.BufferGeometry.addGroup`) — `gmshService.ts`'s `buildIndices` scopes
  `getElements(dim, tag)` to one entity at a time (instead of one global call)
  to bucket triangles into contiguous per-part ranges, with an always-present
  trailing ungrouped range (`name`/`color` both `null`, rendered in the
  original default blue) for anything not claimed by a part. For `dimension
  === 3` this buckets **per volume** — `getElements(3, tag)` limits tets to
  one volume before the shared-tet-face dedup runs — which stays correct even
  for two touching part-volumes, since Gmsh tags each tet by its single owning
  volume regardless of geometric adjacency.
- Bundling gmsh-wasm is *why this project is GPL-2.0-or-later, not MIT* — see the
  "License" section above and the README's "Licensing" section for the full
  rationale. Full technical write-up (input paths, GMSH API call sequences,
  protocol messages, licensing, and the upstream GMSH-JS gaps found while
  building this): `doc/gmsh-integration.md`.

## Toolbar/panel icons — generated, theme-adaptive SVG

The toolbar and a few panels (tree-close, parts delete/remove, the meshing
large-mesh warning) used plain-color emoji (📤🔍🕸️🌳🔬🖱️📍🧊◼️📏▶, plus ⚠/✕) as
button icons. These are now monochrome, `currentColor`-based inline SVG that
track VS Code's light/dark theme automatically, replacing the emoji.

- **`src/toolbarIcons.ts` is GENERATED — never hand-edit it.** It's produced
  wholesale by `icons/build-toolbar-icons.mjs` from `icons/svg-ui/*.svg`
  (themselves built from `icons/tikz-ui/*.tex` via `pdflatex` +
  `pdftocairo -svg`). To change an icon: edit its `.tex` source, then
  `cd icons && make ts`. See `icons/README.md` for the full pipeline — it's a
  separate, differently-wired set from the 46 `icons/tikz/*.tex` Edits-panel
  op icons (those stay flat PNG, still unwired into the running extension;
  this toolbar set is SVG and *is* wired in).
- **Every icon is `currentColor`-based, not a fixed color** — the generator
  strips `pdftocairo`'s literal black (`rgb(0%, 0%, 0%)`) stroke/fill down to
  `currentColor`, and any gray shading fill (from a TikZ `gray!N` fill) down
  to `currentColor` + a proportional `fill-opacity` (`(100-N)/100`), so an
  icon's relative internal shading survives (e.g. `volume`'s front/top/side
  faces) instead of flattening to one constant tint. The fixed `width`/
  `height` `pdftocairo` emits are stripped too — only `viewBox` survives, so
  CSS (`.toolbar-icon svg { width: 1em; height: 1em; }` in `media/viewer.css`)
  controls the rendered size, and the icon inherits whatever `color` its
  containing button/text already has (VS Code already themes those) instead
  of setting its own.
- **Gotcha, hit once and now regression-tested:** `pdftocairo -svg` always
  emits a fill as a `fill="rgb(...)" fill-opacity="1"` *pair*. A first-pass
  regex that only rewrote the `fill="rgb(...)"` part left the original
  `fill-opacity="1"` trailing right after the new one — two `fill-opacity`
  attributes on one `<path>`, and the second (unwanted) one silently won,
  erasing the intended partial-opacity shading. The generator's regex now
  consumes both in one match. `src/toolbarIcons.test.ts` asserts no generated
  path ever has more than one `fill-opacity` attribute.
- Since this module has **no `vscode`/DOM dependency**, both the host
  (`provider.ts`, building static HTML) and the webview
  (`partsPanel.ts`/`meshingPanel.ts`) import it directly — no bundling or
  `asWebviewUri` needed, the SVG markup is just inlined into whatever HTML
  string or `innerHTML` assignment needs it.
- Chevrons (`▾▸⌄⌃`), plain arrows (`↑↓←→`), and the zoom `−`/`+` are
  deliberately NOT covered by this — they already render as clean monochrome
  glyphs in every renderer, unlike real emoji, so replacing them would add
  icons for no visual benefit.

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

Confirm the toolbar/panel icons (Fit, Wireframe, Export, Tree, FE Mesh, Select,
Point/Vol/Surf/Line, the FE Mesh panel's Generate/Export, tree-close, Parts
delete/remove, and the large-mesh warning) render crisply and legibly at their
actual small size — this is the one thing automated tests can't check. Then
switch VS Code to a light theme (`Ctrl+K Ctrl+T` → e.g. "Light+") and confirm
every one of those icons re-colors to match (dark strokes on the now-light
toolbar buttons) without needing a reload; switch back to a dark theme and
confirm the reverse.

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
updates live and the op appears in the list. Then exercise **booleans** (Set A on one
volume, Apply against another), **Fillet/Chamfer** (select edges in Line mode),
**Extrude/Revolve/Sweep/Loft** (select a profile face in Surf mode — adds a new body),
and **Explode/Mate**. Then exercise the **primitive composer** (no selection needed):
pick each of **Box/Sphere/Cylinder/Cone/Torus/Prism**, enter parameters (try a
non-axis-aligned `Axis` on cylinder/cone/torus/prism), **Add** → confirm each new body
appears correctly placed and oriented. Then exercise the **2D profile composer**
(also no selection needed, B-rep only): **Sketch** a Circle, a Rectangle (try a
non-default `Up`), and a Polygon → confirm each appears as a flat face grouped under
"Sketches" in the Components tree; **Select** it in **Surf** mode and feed it into
**Extrude** (or Revolve/Sweep/Loft) → confirm it builds a new solid at the sketch's
location and the sketch face disappears from "Sketches" (consumed into the new solid,
not duplicated). **Undo/Redo/Clear** the stack. Close and reopen the tab → ops
(including primitives and sketches) reload from `bull.stp.edits.json` (inspect: valid
JSON, CAD file untouched). **Export** the edited model (e.g. to STEP/STL) and reopen
the output → the edits, including added primitives and extruded sketches, are baked
in. On `cube.stl`, confirm transforms, booleans, explode, and **all six primitives**
apply (mesh path, matching the B-rep path's placement/orientation for the same
params) and that the B-rep-only ops (fillet/chamfer, feature modeling, mate, and the
**2D profile composer**) are disabled. Apply/undo repeatedly + open/close → host
memory stays flat (OCCT handle-leak check, same as above).

Then exercise **bottom-up wireframe modeling** (also B-rep only): click the new
**📍 Point** select-mode button and confirm a sprite appears at every existing vertex
of `bull.stp`. In the **Edits** panel's wireframe composer, add a **Point**, a **Line**
(two typed endpoints), and an **Arc** → confirm each is selectable in the matching
pick mode alongside the model's real geometry and colourable via a Part. Build 4 Lines
forming a closed square (typed endpoints), select all 4 in **Line** mode, click
**Build → Surface** → confirm a new face appears under "Sketches"; try an open
(non-closing) set of lines → confirm a graceful no-op (no crash, no new face). Build 6
Rectangle profiles positioned as a box's faces, select all 6 in **Surf** mode, click
**Build → Volume** → confirm a new closed solid appears in **Vol** mode; try only 5 of
the 6 (open shell) → confirm a graceful no-op. **Undo/Redo/Clear**; close and reopen
the tab → all five op kinds reload from `bull.stp.edits.json`. **Export** the model →
reopen the output → the points/lines/arcs/surfaces/volumes are baked in. On
`cube.stl`, confirm the **📍 Point** button and the wireframe/build composers are
disabled. Apply/undo repeatedly + open/close → host memory stays flat (OCCT
handle-leak check, same as above).

Then exercise the **GEOMETRY/EDIT tab redesign + new ops**: on `bull.stp`, confirm
the Edits panel shows GEOMETRY|EDIT tabs (2D|3D subtabs under GEOMETRY), each op as
an icon button that opens its param form below the grid (clicking again collapses
it), and that one op from every pre-existing family still behaves identically from
its new home. Then the new ops — **2D sketches**: Ellipse (try radiusY > radiusX),
Rounded rect (near-limit corner radius), Slot, Trapezoid → each under "Sketches",
extrudable and consumed on extrude. **Curves**: Polyline (add/remove point rows;
open + closed), 3-Pt Arc (collinear → graceful skip), Spline, Bezier, Ellipse Arc
(non-default Up), Helix → each pickable in Line mode. **3D**: Wedge (tilted axis);
Hole/Counterbore/Countersink into a selected volume (tilted axis too) → correctly
placed cuts. **EDIT → Modify**: Shell (select opening faces in Surf mode; walls of
|thickness|), Split (all three Keep modes), Section (face under "Sketches"; plane
that misses → no-op). On `cube.stl`: the 2D subtab is greyed with a tooltip;
Wedge/Volume-from-Surfaces/Fillet/Features/Modify/Mate are greyed; Box…Prism and
all three holes work (mesh CSG placements match the B-rep path); loading the mesh
while a B-rep-only form is open collapses it. Undo/redo/clear, reload → replay
from `bull.stp.edits.json`, export → baked in, and the usual host-memory leak
check — all unchanged.

Then exercise **parametric variables**: on `bull.stp`, click **＋ New** in the
Edits panel's **Variables** table, rename the variable to `L`, set its expression
to `20` → the row shows `= 20`. Add a **Box** with size `(L, L/2, 5)` and an
**Extrude** on a sketch face with length `L*2` → both apply at the current value
and the history lines show the `[… = …]` binding suffix. Change `L` to `40` in
the table → the box and extrusion rebuild live (B-rep round-trips through the
host; on `cube.stl` the same works locally for mesh-legal ops). Add a derived
variable `W = L/2` **below** `L` → works; move the reference the other way
(a variable referencing one defined below it) → its row shows ⚠ and keeps its
last value. Type an unknown name into an op field → Apply is blocked with an
inline error. Delete `L` while referenced → the delete tooltip warns, geometry
freezes at the last values with a status warning, and re-adding `L` restores the
parametric link. Undo/redo ops after a variable change → redone ops use the
*current* value, not the one they were created with. Close and reopen the tab →
variables + expressions reload from `bull.stp.edits.json` (inspect: a
`variables` array plus per-op `exprs`; CAD file untouched); hand-edit `L`'s
expression in the sidecar and reopen → the geometry reflects the new value
(parse-time re-resolution). **Export** → the current resolved values are baked
in. Rapid variable changes + open/close → host memory stays flat (same leak
check as above).

Then exercise **Meshing (GMSH-JS)**: on `bull.stp`, click the toolbar **🔬 FE Mesh**
toggle (this just arms overlay display — the **FE Mesh** panel is already visible in
the sidebar). Confirm the **coarser→finer slider** starts at the bbox-derived default
(readout `Size: X · ~N elements`, with the Advanced "Size max" field showing the same
number — never a raw `1e+22`), that **Coarse/Medium/Fine** snap it, and that dragging
it to the finest end on a large model raises the ⚠ large-mesh warning (drag updates
only the readout; the sidecar write happens on release). Expand **Advanced settings**
(collapsed by default) and set options (try 2D vs 3D dimension, a smaller **Size
max** — the slider must follow it, and clearing the field must restore the bbox
default — a different 2D/3D algorithm; confirm **STL angle** is disabled for this
B-rep source), click **▶ Generate** → while the WASM call runs, confirm the
`#meshing-generate` button disables and an indeterminate progress bar/`"Generating…"`
status appear; once done, confirm a blue mesh overlay appears (the original model's
shaded faces auto-hide so they don't visually compete with the overlay, but its edges
stay visible as a feature-line reference — unchanged geometry, `.visible` toggle only)
and the panel status line shows `Nodes: N · Elements: M · T s` (wall-clock generate
time). Also confirm that merely opening a file and moving nothing writes **no**
sidecars (the bbox seed uses `load()`, not `update()`). Confirm the export
`<select>`'s default selection is "Kratos MDPA — Elements + Conditions (.mdpa)". Pick
each of that, "Kratos MDPA — Geometries (.mdpa)", "Gmsh Mesh (.msh)", "Gmsh Mesh v2,
Legacy (.msh2)", and "Gmsh Geometry (.geo_unrolled)" in the export `<select>` and click
**📤 Export** for each, saving and reopening them (both MDPA modes should contain
`Begin Nodes`/`Begin Elements`+`Begin Conditions` or `Begin Geometries` blocks and, if
any Parts exist, `Begin SubModelPart` blocks; `.msh`/`.msh2` are GMSH's native mesh
formats at two schema versions; `.geo_unrolled` is the fully-expanded script, not the
sidecar `.geo` — see below) to confirm they contain real content. Also pick a couple
of the other formats (e.g. VTK, Abaqus `.inp`, or STL) and confirm those export and
reopen too. Set **Element order** to Quadratic (2) and try exporting either MDPA
format → confirm a clear error message instead of a corrupt file. Close and reopen the tab → confirm
`bull.stp.mesh.json` (the options) and `bull.stp.geo` (the generated, editable script)
exist next to the source, are valid JSON/text, and the CAD file itself is untouched;
hand-edit `bull.stp.geo` and change an option in the panel → confirm your hand-edit is
overwritten (one-way generation, by design). Toggle **🔬 FE Mesh** off → confirm the
overlay disappears and the original model is completely unaffected (no geometry
change, still editable/exportable normally); toggle back on **without regenerating**
→ confirm the same overlay reappears instantly. Click **Clear** → confirm the overlay
is disposed and the toggle turns itself off. Repeat on `cube.stl` (a mesh-format source — Generate
should still work, reclassifying the STL's triangle soup into a volume before
meshing). Apply **Generate** repeatedly, toggle on/off, and open/close the tab
repeatedly → watch extension-host memory stay flat (same OCCT-style leak check as
above; the GMSH-wasm singleton is reused across generations, only per-generation MEMFS
files are cleaned up).

Then exercise **element shapes + quadratic meshing**: on `bull.stp`, in Advanced
settings set **Element shape** to "Quads / Hexahedra" and **▶ Generate** → confirm the
overlay shows an all-quad surface pattern (each quad rendered as two coplanar triangles
under the wireframe) with **no holes** (watertight). Switch **Element order** to
Quadratic (2) for each of the two shapes and regenerate → confirm the overlay still
renders complete (corner-node display; the node count in the status line jumps
markedly). Confirm the slider's element estimate visibly drops when switching to
"Quads / Hexahedra" (≈1 hex per h-cube vs ≈6 tets), and that `bull.stp.geo` gains
matching `Mesh.RecombineAll` / `Mesh.SubdivisionAlgorithm` lines. Export **both Kratos
MDPA modes** for: simplex+order2 (`Tetrahedra3D10`/`Triangle3D6` geometries, or
`Element3D10N`/`SurfaceCondition3D6N` elements), subdivided+order1
(`Hexahedra3D8`/`Quadrilateral3D4`), and subdivided+order2
(`Hexahedra3D27`/`Quadrilateral3D9`) → open each `.mdpa` and confirm the expected block
names, that geometries-mode ids form one continuous space across kinds, and (with 2+
parts assigned) per-part `SubModelPart` blocks still appear with non-empty membership.
Set **Dimension** to 2D with shape "Quads / Hexahedra" → confirm an all-quad 2D overlay
and a `Quadrilateral3D4`/`SurfaceCondition3D4N` MDPA. Repeat one subdivided generate on
`cube.stl` (reclassified STL path — hexes still generate). Note: only "Triangles /
Tetrahedra" and "Quads / Hexahedra" are offered — hex-dominant mixed meshing is
unavailable in this WASM build (see `doc/gmsh-integration.md`'s Known limitations).
Regenerate across shapes/orders repeatedly → host memory stays flat (same leak check).

Then exercise **parts-preserving meshing**: on `angle1.stp` (or another multi-face
STEP), create 2+ parts covering different faces/solids and set one part's **mesh
size** field (in its row in the Parts panel — or equivalently in the FE Mesh panel's
mirrored **Part sizes** section; confirm a value typed in either shows up in the
other) to a value noticeably smaller than the model's default size. Click **▶ Generate** → confirm the overlay recolours per part
(each part's assigned faces/solids render in that part's colour, everything else in
the original default blue) and the sized part's region visibly refines. Pick "Gmsh
Mesh (.msh)" and click **📤 Export**, save, and open the file in a text editor →
confirm a `$PhysicalNames` section listing the part names, AND confirm the
`$Elements` section has more than one entity block (i.e. the *whole* model was
written, not just the sized/assigned part — `Mesh.SaveAll` must be forced on once
any part exists, or every other entity's elements silently vanish from the file
even though the live overlay still looks correct). Pick "Kratos MDPA — Elements +
Conditions" and export it → open the `.mdpa` file and confirm one `Begin SubModelPart
<name>` per part (names matching the Parts panel, sanitized), each with a non-empty
`SubModelPartNodes` list and the correct `SubModelPartElements`/`SubModelPartConditions`
membership for that part's assigned faces/solids; repeat for "Kratos MDPA — Geometries"
and confirm the equivalent `SubModelPartGeometries` blocks. Pick "Gmsh Geometry
(.geo_unrolled)" and export it — a companion `<name>.geo_unrolled.xao`
file is written alongside it (B-rep sources only; this is expected and required, not
an error) — then reopen the `.geo_unrolled` in a real Gmsh install (or via this
repo's own `gmsh.open(...)`) with the `.xao` sibling present and confirm the full
geometry, physical groups, and any per-part sizing field all come back (the
`.geo_unrolled` text itself has no textual `Physical Volume(...)`/`Physical
Surface(...)` statements for B-rep sources — OCC geometry can't be unrolled to native
GEO primitives, so the XAO companion carries that data instead). Reassign/rename/
recolour a part and regenerate → confirm the overlay and exports pick up the change. On
`cube.stl`, set a single part's mesh size → confirm Generate applies it as a global
size override for that one run (no per-part overlay colouring, no physical groups —
expected, since STL sources can't correlate parts) and `cube.stl.mesh.json` is
unaffected; set two parts' mesh sizes → confirm it silently falls back to the panel's
own global size (ambiguous, ignored). Apply/regenerate repeatedly + open/close the
tab → watch extension-host memory stay flat (same leak check as above).

On **VS Code Remote/SSH**, the running extension is the installed copy in
`~/.vscode-server/extensions/`, not the workspace `dist/` — rebuilds alone won't show up.
Bump the version, `npx vsce package`, reinstall the `.vsix`, then reload the window.
