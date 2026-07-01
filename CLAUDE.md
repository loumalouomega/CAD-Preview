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
- **Points are NEVER resolved as operands by any other op** — `addLine`/`addArc`
  take typed `Vec3` coordinates, not point-id references, matching every other
  creation op in this codebase (Box/Sphere/.../Circle/Rectangle/Polygon all take
  pure numeric params). This means point extraction is **display-only** — there
  is **no `collectVertices` in `occtOperations.ts`**, and therefore **none of the
  lockstep-pipeline-pair risk** the free-face fix had (nothing needs to resolve a
  `point-N` id back to a live vertex during editing).
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

On **VS Code Remote/SSH**, the running extension is the installed copy in
`~/.vscode-server/extensions/`, not the workspace `dist/` — rebuilds alone won't show up.
Bump the version, `npx vsce package`, reinstall the `.vsix`, then reload the window.
