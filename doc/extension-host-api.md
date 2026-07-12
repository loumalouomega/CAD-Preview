# Extension Host API

The extension host is a Node.js process. These modules run there — never in the webview.

## Module Index

| Module | Responsibility |
|--------|---------------|
| `src/extension.ts` | VS Code extension entry point |
| `src/provider.ts` | Custom editor provider, webview lifecycle |
| `src/fileRouter.ts` | Map file extensions to render strategy |
| `src/exportTargets.ts` | Map a `FileRoute` to its compatible export formats |
| `src/occtService.ts` | Lazy WASM singleton, B-rep parsing + tessellation + export (op-list aware) |
| `src/occtOperations.ts` | Host-side OCCT edit engine — folds the op-list over a `TopoDS_Shape` |
| `src/meshExtract.ts` | Extract WebGL geometry (faces + edges) from OCCT shapes |
| `src/partsStore.ts` | Read/write the `<model>.parts.json` sidecar (vscode fs) |
| `src/partsSidecar.ts` | Pure parse/serialize for the parts sidecar (vscode-free, unit-tested) |
| `src/editOps.ts` | The `EditOp` union + `validateEditOp` tolerance gate (vscode-free) |
| `src/editsStore.ts` | Read/write the `<model>.edits.json` sidecar (vscode fs) |
| `src/editsSidecar.ts` | Pure parse/serialize for the edits sidecar (vscode-free, unit-tested) |
| `src/paramExpr.ts` | Parametric expression evaluator + `exprs` field-path addressing (vscode/DOM-free, unit-tested) |
| `src/editVariables.ts` | `ParamVariable` validate/evaluate + `resolveEditOps` op resolver (vscode/DOM-free, unit-tested) |
| `src/gmshService.ts` | Lazy GMSH-wasm singleton, FE mesh generation + `.geo_unrolled` export |
| `src/gmshElementTypes.ts` | Single source of truth for gmsh element types: stride/faces/Kratos mapping + pure overlay-triangulation helpers (vscode/WASM-free, unit-tested) |
| `src/mdpaWriter.ts` | Pure Kratos MDPA serializer over the generic `MdpaCell` catalogue (vscode/WASM-free, unit-tested) |
| `src/meshOptions.ts` | The `MeshOptions` bag + `validateMeshOptions` tolerance gate + `gmshShapeOptions` (vscode-free) |
| `src/meshOptionsStore.ts` | Read/write the `<model>.mesh.json` sidecar + generated `<model>.geo` (vscode fs) |
| `src/meshOptionsSidecar.ts` | Pure parse/serialize for the mesh-options sidecar + `.geo` script generation (vscode-free, unit-tested) |
| `src/protocol.ts` | Shared message types and buffer encoding |
| `src/toolbarIcons.ts` | **Generated** — monochrome, `currentColor`-based toolbar/panel icons (vscode-free) |
| `src/mcpServer.ts` | Standalone stdio MCP server entry (own `dist/mcp-server.js` bundle, not part of the extension) |
| `src/mcpTools.ts` | MCP tool handlers over the headless pipeline (MCP-SDK/WASM-free, unit-tested) |
| `src/mcpSidecars.ts` | Node-fs sidecar store for the MCP server — mirrors the three `*Store.ts` wrappers (vscode-free, unit-tested) |

---

## `src/extension.ts`

Entry point for VS Code extension activation.

```typescript
export function activate(context: vscode.ExtensionContext): void
export function deactivate(): void
```

`activate` calls `CadPreviewProvider.register(context)` and nothing else. `deactivate` is a no-op (resources are disposed with the webview panels via VS Code's disposable system).

---

## `src/provider.ts`

### `CadPreviewProvider`

Implements `vscode.CustomReadonlyEditorProvider<CadDocument>`.

```typescript
class CadPreviewProvider implements vscode.CustomReadonlyEditorProvider<CadDocument> {
  static readonly viewType = 'cad-preview.mesh'
  static register(context: vscode.ExtensionContext): vscode.Disposable
  openCustomDocument(uri: vscode.Uri, ...): Promise<CadDocument>
  resolveCustomEditor(document: CadDocument, webviewPanel: vscode.WebviewPanel, ...): Promise<void>
}
```

**`register(context)`** — Registers the provider with VS Code. Called once from `activate()`. Returns a `Disposable` pushed onto `context.subscriptions`.

**`openCustomDocument(uri)`** — Creates a lightweight `CadDocument` wrapper around the URI. The document is read-only (no `backup`, no `revert`).

**`resolveCustomEditor(document, webviewPanel)`** — The main handler called whenever a supported file is opened:
1. Sets the webview options (`enableScripts: true`, `localResourceRoots`).
2. Sets `webviewPanel.webview.html` to the result of `getHtml()`.
3. Registers a `webviewPanel.webview.onDidReceiveMessage` listener (a per-panel
   `pending: Map<string, { resolve; reject }>` correlates export round-trips, and
   **three separate** per-panel debounce timers batch parts/edits/mesh-options
   sidecar writes) that handles `"ready"`, `"partsChanged"`, `"editsChanged"`,
   `"meshingChanged"`, `"meshingGenerate"`, `"meshingExport"`, `"exportRequest"`,
   `"exportResult"`, and `"exportError"`.
4. On `"ready"`: reads the edits sidecar, calls `routeFile()`, dispatches to
   `handleBRep()` (which applies the loaded edits) or posts `"loadUrl"`, then
   posts `"edits"` and calls `sendParts()`/`sendMeshOptions()`.
5. On `"partsChanged"`: debounces (~500 ms) then `writeParts()` to the sidecar. The CAD file is never written.
6. On `"editsChanged"`: debounces (~500 ms, its own timer) then `writeEdits()`; for B-rep sources also re-tessellates immediately with the new op-list.
7. On `"meshingChanged"`: debounces (~500 ms, its own timer) then writes **both**
   `writeMeshOptions()` and `writeGeoScript()`.
8. On `"meshingGenerate"`/`"meshingExport"`: resolves the mesh input via
   `resolveMeshInput()` (re-exports STEP for B-rep sources; uses the message's
   `stl` field for mesh sources) and calls `generateMesh()`/`exportGeoUnrolled()`,
   posting `"meshingResult"`/`"meshingError"` (Generate) or writing the file via
   `promptSaveAndWrite()` (Export).
9. On `"exportRequest"`: dispatches to `handleExport()`.
10. On `"exportResult"`/`"exportError"`: resolves/rejects the matching entry in `pending` by `requestId`.

**`handleBRep(extensionPath, bytes, format, webview, ops)`** — Private method. Calls `loadBRep()` with the current edit op-list, posts `"status"` progress messages, then posts `"geometry"` (faces + edges + points) + `"tree"` messages. Posts `"error"` on failure.

**`sendParts(uri, post)`** — Private method. Reads the parts sidecar via `readParts()` and posts a `"parts"` message (empty array when no sidecar exists).

**`sendMeshOptions(uri, post)`** — Private method. Reads the mesh-options sidecar via `readMeshOptions()` and posts a `"meshingOptions"` message (`DEFAULT_MESH_OPTIONS` when no sidecar exists).

**`resolveMeshInput(uri, route, ops, stl)`** — Private method. Builds the
`MeshGenerationInput` `generateMesh`/`exportGeoUnrolled` need: for a B-rep
document, re-exports the source to STEP via the existing `exportBRep()` (so live
edits are reflected); for a mesh document, decodes the caller-supplied base64
`stl` field. Returns `undefined` when a mesh document has no `stl` payload yet —
callers treat this as a graceful "nothing to mesh", posting `"meshingError"`
rather than throwing.

**`handleExport(uri, route, post, pending)`** — Private method. The whole Export flow (triggered by **File ▸ Export… / Save As…**):
1. `exportTargetsFor(route)` → `vscode.window.showQuickPick()` of compatible formats; bails if cancelled.
2. `vscode.window.showSaveDialog()` defaulting to the source's folder + new extension (`EXPORT_EXTENSION`); bails if cancelled.
3. If the target is a B-rep format (STEP/IGES/BREP): reads the source bytes and calls `exportBRep()` directly — no webview round-trip.
   If the target is a mesh format (STL/OBJ/PLY/glTF): registers a `requestId` in `pending`, posts `"exportMesh"`, and awaits the promise that the `onDidReceiveMessage` handler resolves/rejects when the webview replies.
4. Decodes the result (base64 or UTF-8, per the `binary` flag) and writes it with `vscode.workspace.fs.writeFile()`. Posts `"status"` on success, `"error"` on failure.

**`getHtml(webview, extensionUri)`** — Private method. Generates the full webview HTML with:
- A strict CSP nonce.
- The compiled `media/viewer.js` bundle (IIFE).
- The `media/viewer.css` stylesheet.
- Static toolbar HTML (`#fit`, `#wireframe`, `#grid`, `#export`, `#tree-toggle`, `#meshing-toggle`, and the `#select-group` selection-mode controls) — most of these buttons' icons come from `TOOLBAR_ICONS` (see below), via a local `icon(id)` helper that wraps the markup in `<span class="toolbar-icon">`.
- Static view-controls panel HTML (`#view-controls`, `#vc-toggle`).
- Sidebar (`#side`) containing the tree panel (`#tree-panel`), the Parts panel (`#parts-panel`), the Edits panel (`#edits-panel`), and the FE Mesh panel (`#meshing-panel`).
- Status/error overlay divs.

---

## `src/toolbarIcons.ts`

**Generated — never hand-edit.** Regenerate with `cd icons && make ts` after
changing a source drawing in `icons/tikz-ui/*.tex` (see `icons/README.md` for
the full pipeline). Exports:

```typescript
export type ToolbarIconId = "close" | "export" | "feMesh" | "fit" | "generate"
  | "line" | "point" | "select" | "surface" | "tree" | "volume" | "warning" | "wireframe";
export const TOOLBAR_ICONS: Record<ToolbarIconId, string>; // raw <svg>...</svg> markup
```

These replaced the toolbar/panel's plain-color emoji (📤🔍🕸️🌳🔬🖱️📍🧊◼️📏▶, plus
⚠/✕) with monochrome icons that track VS Code's theme. Each value is inline
SVG using `currentColor` for strokes/solid fills and `currentColor` +
`fill-opacity` for shaded regions (instead of hardcoded colors), generated by
`icons/build-toolbar-icons.mjs` from `pdftocairo -svg` output — see that
script's header comment for the exact color-substitution rules. The module
is plain data with **no `vscode` or DOM dependency**, so it's imported
directly by both this file (`provider.ts`, building static HTML host-side)
and the webview-side `partsPanel.ts` (delete/remove buttons) and
`meshingPanel.ts` (the large-mesh warning line) — see `doc/webview-api.md`.
Consumers wrap the markup in `<span class="toolbar-icon">` (`media/viewer.css`
sizes it to `1em` and deliberately sets no color of its own, so it inherits
whatever `color` the surrounding button/text already has). Chevrons, plain
arrows, and the zoom `−`/`+` are deliberately NOT covered — they already
render as clean monochrome glyphs in every renderer, unlike real emoji.
`src/toolbarIcons.test.ts` enforces the generated file's invariants (valid
non-empty SVG per id, no leftover hardcoded `width`/`height`, no literal
black, no duplicate `fill-opacity` on one path).

---

## `src/fileRouter.ts`

Maps file extensions to a render strategy and canonical format identifier.

### Types

```typescript
type RenderStrategy = 'occt' | 'three'
type CadFormat = 'step' | 'iges' | 'brep' | 'stl' | 'obj' | 'ply' | 'gltf'
interface FileRoute { strategy: RenderStrategy; format: CadFormat }
```

### Function

```typescript
function routeFile(filePath: string): FileRoute | undefined
```

Returns `undefined` for unrecognized extensions (the extension never opens those files because `contributes.customEditors` filters them first, so `undefined` is a safety fallback).

**Extension map:**

| Extension | strategy | format |
|-----------|----------|--------|
| `.step`, `.stp` | `occt` | `step` |
| `.iges`, `.igs` | `occt` | `iges` |
| `.brep` | `occt` | `brep` |
| `.stl` | `three` | `stl` |
| `.obj` | `three` | `obj` |
| `.ply` | `three` | `ply` |
| `.gltf`, `.glb` | `three` | `gltf` |

---

## `src/exportTargets.ts`

Maps a `FileRoute` to the formats it can be exported to, and the file extension/label
to use for each. Pure functions, unit-tested in `src/exportTargets.test.ts`.

```typescript
function exportTargetsFor(route: FileRoute): CadFormat[]
```
B-rep sources (`route.strategy === "occt"`) return the other two B-rep formats plus
all four mesh formats. Mesh sources (`route.strategy === "three"`) return the other
mesh formats only. The source's own format is always excluded.

```typescript
const EXPORT_EXTENSION: Record<CadFormat, string>  // e.g. gltf → "glb"
const EXPORT_LABEL: Record<CadFormat, string>       // e.g. gltf → "glTF Binary"
```
Used by `provider.ts`'s `handleExport()` to build the quick-pick items and the save
dialog's default filename/filter.

---

## `src/occtService.ts`

Manages the OpenCascade.js WASM singleton and performs B-rep parsing and tessellation.

### Types

```typescript
interface BRepResult {
  groups: SolidGroup[]   // from meshExtract.ts (faces, grouped by solid)
  edges: EdgeLine[]      // from meshExtract.ts (deduped edge polylines)
  points: PointEntity[]  // from meshExtract.ts (every vertex in the shape)
  tree: TreeNode         // from protocol.ts
}
```

### Functions

```typescript
function getOcct(extensionPath: string): Promise<any>
```
Returns the memoized OCCT module. Initializes it on the first call by reading `dist/opencascade.wasm.wasm` and calling the raw Emscripten factory. Subsequent calls return the cached promise immediately.

```typescript
function resetOcct(): void
```
Resets the singleton to `null`. Used in tests and hot-reload scenarios. **Not safe to call while a tessellation is in progress.**

```typescript
async function loadBRep(
  extensionPath: string,
  bytes: Uint8Array,
  format: CadFormat,
  ops?: EditOp[]            // replayable edit op-list (default [])
): Promise<BRepResult>
```
High-level entry point called from `provider.ts`. Calls `getOcct()`, writes the file bytes to the OCCT virtual filesystem, calls `readShape()` to parse, applies the edit op-list via `applyEditsBRep()` (`src/occtOperations.ts`), then calls `tessellateByGroup()` to extract faces, `extractEdges()` to extract deduped edge polylines, `extractVertices()` to extract every vertex in the shape, and `buildTree()` to build the component hierarchy. With an empty `ops` this is the original read-only path; the source bytes are never modified.

```typescript
function readShape(
  oc: any,
  filePath: string,
  format: CadFormat,
  cleanup: { delete(): void }[]
): any  // TopoDS_Shape
```
Exported (used by both `loadBRep` and `exportBRep`). Selects the appropriate OCCT
reader class and calls it. Pushes every handle it creates onto `cleanup` so they're
deleted in the caller's `finally` block. The BREP branch's 4th `BRepTools.Read_2` arg
is a `Handle_Message_ProgressIndicator` — *not* `Message_ProgressRange`, which isn't
a real constructor in this OCCT build and throws immediately.

```typescript
function buildTree(format: CadFormat, groups: SolidGroup[]): TreeNode
```
Builds a `TreeNode` tree from the solid groups. The root label is derived from the format (e.g. `"STEP Assembly"`). Each `SolidGroup` becomes a child node with `id`, `label`, and `faceCount`.

```typescript
async function exportBRep(
  extensionPath: string,
  bytes: Uint8Array,
  sourceFormat: "step" | "iges" | "brep",
  targetFormat: "step" | "iges" | "brep",
  ops?: EditOp[]            // replayable edit op-list (default [])
): Promise<Uint8Array>
```
Re-parses `bytes` with `readShape()`, applies the edit op-list via `applyEditsBRep()`,
and writes the resulting `TopoDS_Shape` out as `targetFormat` via the private
`writeShape()` helper, returning the output file's bytes (read back from the OCCT
virtual filesystem) — so **Export bakes the edits in**. Cleans up every handle —
reader/writer/shape/progress-indicator — in a `finally`, plus `oc.FS.unlink()` on
both the input and output virtual paths, same discipline as `loadBRep`.

```typescript
function writeShape(
  oc: any,
  shape: any,
  filePath: string,
  format: "step" | "iges" | "brep",
  cleanup: { delete(): void }[]
): void
```
Internal helper called by `exportBRep`. Per-format writer calls, verified against the
live WASM build (the `_1`-suffixed overloads take a C++ `ostream`/`istream` that
isn't bound in this build and throw `UnboundTypeError` — always use the path-based
overload instead):
- **step**: `new oc.STEPControl_Writer_1()` → `.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true)` → check `IFSelect_RetDone` → `.Write(filePath)` → check status again.
- **iges**: `new oc.IGESControl_Writer_1()` → `.AddShape(shape)` → `.ComputeModel()` → `.Write_2(filePath, false)` (boolean return).
- **brep**: `oc.BRepTools.Write_2(shape, filePath, new oc.Handle_Message_ProgressIndicator_1())` (boolean return).

---

## `src/occtOperations.ts`

The host-side OCCT **edit engine**. Folds the replayable op-list over a freshly-read
`TopoDS_Shape` and returns the edited shape, which `loadBRep`/`exportBRep` then
tessellate / write exactly as for an unedited file. The webview never sees OCCT.

```typescript
function applyEditsBRep(
  oc: any,
  baseShape: any,            // TopoDS_Shape
  ops: EditOp[],
  cleanup: { delete(): void }[]
): any                       // TopoDS_Shape (edited)
```
Reduces `ops` over `baseShape`. Every wrapped handle it creates is pushed onto
`cleanup` (freed in the caller's `finally`); the **returned** shape is *not* deleted
here — the caller owns its lifetime. Unimplemented ops are skipped, so a sidecar
authored against a newer build never hard-fails an older one.

**Transforms (M1)** are applied by `transformSolids()`, which respects the same
deterministic `solid-N` explorer order the read pipeline uses: when every solid is
targeted (or the shape has no solids) the whole shape is transformed; otherwise a new
`TopoDS_Compound` is assembled from the transformed targets plus the untouched rest.
The `gp_Trsf`/`gp_GTrsf` suffix details are recorded in `CLAUDE.md` (verified against
the live WASM).

**Booleans (M2)** are applied by `booleanSolids()` via `BRepAlgoAPI_{Fuse,Cut,
Common}_3(s1, s2).Shape()` (the progress-range arg is optional/unbound). Each operand
shape is built from its `solid-N` set (a compound when more than one); the operands
are replaced by the single boolean result and the untargeted solids are preserved in
a rebuilt compound. An op with unresolved operands or `IsDone()===false` is skipped.

**Fillet/chamfer (M3)** are applied by `filletEdges()` via `BRepFilletAPI_MakeFillet`
/ `BRepFilletAPI_MakeChamfer` + `.Add_2(amount, edge)` → `.Shape()`. Edge `edge-N` ids
are resolved by `collectEdges()`, which replicates `extractEdges`' exact de-dup +
discretization-validity ordering so the picked ids map to the right live edges. A
fillet whose edges don't resolve or whose `.Shape()` throws / `IsDone()` is false is
skipped.

**Feature modeling (M4)** is applied by `featureModel()`/`buildFeatureSolid()` —
extrude (`MakePrism_1`), revolve (`MakeRevol_1`), sweep (`MakePipe_1`), loft
(`ThruSections`). Profile `face-N` ids are resolved by `collectFaces()` in the same
global solid→face order `tessellateByGroup` assigns; the resulting solid is
**appended** as a new body (`compound(existing + new)`), never cutting/fusing the
source. Operands that don't resolve or builders that throw are skipped.

**Assembly (M5):** `explodeSolids()` spreads each solid from the model bbox centre by
`factor` (all formats; mesh path in `meshEdits.applyMeshExplode`). `mateShape()`
aligns planar `faceA` onto `faceB` via `gp_Trsf.SetDisplacement` of `gp_Ax3` frames
(face planes from `BRepAdaptor_Surface_2`), moving the solid `owningSolid()` finds for
`faceA`. Non-planar faces / unresolved ids / failed displacement are skipped.

**Primitive creation (M6)** is applied by `addPrimitive()`/`buildPrimitiveSolid()` —
the one op family with **no existing operands**: it builds a new solid from
parameters alone and appends it (`compound(existing + new)`, same non-destructive
pattern as `featureModel`), and unlike M3/M4/M5's B-rep-only ops, it also runs on the
mesh engine (`meshEdits.buildPrimitiveMesh`) — see `src/webview/meshEdits.ts` below.
`BRepPrimAPI_MakeBox_3`/`MakeSphere_5`/`MakeCylinder_3`/`MakeCone_3`/`MakeTorus_5`
build the five direct-primitive shapes from a `gp_Pnt_3`/`gp_Ax2_3` placement; the
N-gon prism has no OCCT primitive, so it's built by hand (`planeBasis()` computes two
JS-side perpendicular unit vectors, N points are placed around them, then
`buildFlatFace()` — `BRepBuilderAPI_MakeWire_1`/`MakeFace_15` — makes the base face,
then the already-verified `MakePrism_1` extrudes it). A primitive whose builder
throws is skipped.

**2D profile sketches (M7)** are applied by `addProfile()`/`buildProfileFace()` —
like primitives, no existing operands, but the appended body is a bare
**`TopoDS_Face`** (no thickness), meant to be picked (Surf mode) and fed into
`extrude`/`revolve`/`sweep`/`loft` as the `profile` operand afterward. B-rep only
(`BREP_ONLY_OPS`). Circle uses `gp_Circ_2(gp_Ax2_3(pnt, normal), radius)` →
`BRepBuilderAPI_MakeEdge_8(circ)` → wire → face; rectangle/polygon reuse the same
`buildFlatFace()` helper the N-gon prism uses, with corners computed via
`inPlaneBasis(normal, up)` — unlike `planeBasis()`, this derives the in-plane `u`
axis from the op's explicit `up` vector (projected off `normal`, normalized) so
orientation is user-controlled, not arbitrary.

**This required extending the tessellation pipeline itself.** `tessellateByGroup`
(`src/meshExtract.ts`) used to only extract faces belonging to a solid; a bare face
appended into the model compound would be silently invisible. It now also runs a
free-face pass — after tessellating each solid, it claims every face it touched
(`HashCode` bucket + `IsSame`, the same de-dup technique `extractEdges` already uses
for edges) and then walks the whole shape's faces once more, surfacing anything not
claimed as an extra `"Sketches"` group. **`collectFaces()`/`addFreeFacesOf()` in this
file duplicate that exact algorithm** so `face-N` ids resolve to the same live face
on both the read/display path and the edit-resolution path — if the two ever drift
out of lockstep, a `face-N` picked in the view will silently target the wrong face.
Verified end-to-end against the live WASM, not assumed: a compound of a solid + a
free face splits into exactly the expected claimed/free counts, and
`addCircleProfile` immediately followed by `extrude` on the predicted `face-N`
resolves to the exact face OCCT just built. Extruding a profile **consumes** it —
`MakePrism_1`'s `Copy=false` reuses the source face as the new solid's base cap, so
no duplicate face is left behind in `"Sketches"` afterward. A profile whose builder
throws is skipped.

**Bottom-up wireframe modeling (M8)** — `addWireframePrimitive()` (point/line/arc),
`addSurfaceFromLines()`, and `addVolumeFromSurfaces()` — is B-rep only
(`BREP_ONLY_OPS`), all five ops. Point/line/arc follow the same append pattern as
every other creation op: `BRepBuilderAPI_MakeVertex(pnt)` (unsuffixed — this class,
like `BRepBuilderAPI_Sewing` below, has no `_N` overloads in this binding), the
already-verified `BRepBuilderAPI_MakeEdge_3(pnt, pnt)` for lines, and the
already-verified `gp_Circ_2` trimmed via `BRepBuilderAPI_MakeEdge_9(circ, alpha1,
alpha2)` for arcs (radians; found among the 35 `MakeEdge` overloads). Neither points
nor edges built this way are resolved as operands by anything else — `addLine`/
`addArc` take typed `Vec3` coordinates, not entity-id references, so there is
**no `collectVertices()`** in this file.

`addSurfaceFromLines()` resolves `edge-N` ids via the **existing** `collectEdges()`
(unchanged), assembles them with `BRepBuilderAPI_MakeWire_1` + `.Add_1()` per edge —
verified to auto-connect edges added in shuffled order via their shared vertices —
then `BRepBuilderAPI_MakeFace_15(wire, true)`. `.IsDone()` catches genuinely
disconnected edges but **not** an "almost closed" open chain (no reliable
closed-loop check was found in this binding — `BRepTools.IsReallyClosed`/
`DetectClosedness` need args this binding doesn't expose usefully, and
`ShapeAnalysis_Wire.CheckClosed` didn't distinguish closed from open in testing);
an open chain may still produce a best-effort face, which is harmless. The
resulting face flows through the existing free-face pass with no further changes.

`addVolumeFromSurfaces()` resolves `face-N` ids via the **existing** `collectFaces()`
(which already includes the M7 free-face pass, so an M8b-built surface is
selectable here too), sews them with `new BRepBuilderAPI_Sewing(tolerance, true,
true, true, false)` (5 required params, no shorter overload) → `.Add(face)` per
face → `.Perform(new Handle_Message_ProgressIndicator_1())` → `.SewedShape()`, pulls
the `TopAbs_SHELL` via `TopoDS.Shell_1`. The closure check is **`sew.NbFreeEdges()`**
— `0` for a properly closed shell, `>0` for an open one — found only after
`.IsNull()`, sign/magnitude of `BRepGProp.VolumeProperties`, and
`BRepBuilderAPI_MakeSolid` all gave misleading non-error results on an open shell.
`BRepBuilderAPI_MakeSolid_3(shell)` builds the final solid. **Sewing does not
consume its input faces** (unlike extrude's `Copy=false`) — the source faces remain
visible in `"Sketches"` after a successful volume build; left as-is rather than
suppressed (would need excluding specific faces from the compound rebuild, extra
complexity for a cosmetic concern). Any op with unresolved operands, a builder
throw, or (surface/volume specifically) a structurally invalid selection is skipped.

**Extended sketch profiles (M9)** widen `buildProfileFace()` with ellipse
(`gp_Elips_2(gp_Ax2_2(pnt, normal, xdir), major, minor)` → `MakeEdge_12` — the
`gp_Ax2_2` overload pins the major axis to an explicit in-plane X; when
`radiusY > radiusX` the basis rotates 90° and the radii swap, since `gp_Elips`
requires major ≥ minor), rounded rectangle and slot (mixed straight edges +
quarter/half-circle corner arcs via the shared `cornerArcEdge()` — explicit-X
`gp_Ax2_2` + the already-verified `gp_Circ_2`/`MakeEdge_9` — assembled by
`faceFromEdges()`), and trapezoid (4 computed corners → the existing
`buildFlatFace()`). All flow through the same free-face pass; verified
end-to-end (exact bboxes, tilted planes, radii-swap path, extrude-consumes).

**Wedge + holes (M10):** `buildPrimitiveSolid()` gains `addWedge` —
`BRepPrimAPI_MakeWedge_2(gp_Ax2_2(origin, axis, u), dx, dy, dz, ltx)`, where the
Ax2 location is the wedge's local origin corner, so it's offset by
−dx/2·u −dy/2·v to make the op's `center` the base-rectangle centre (B-rep only;
no Three.js wedge). The hole family is applied by `cutHole()`/`buildHoleTool()`:
a cylinder (plus a fused wider mouth cylinder for counterbore, or a mouth cone
for countersink — cone depth derived from the included angle) subtracted from
the resolved targets via the verified `Cut_3`, rebuilt with untargeted solids
preserved (the `booleanSolids` skeleton). Holes run on **both engines**
(`meshEdits.applyMeshHole` mirrors it with CSG). Verified: through/blind/
counterbore/countersink volumes all match analytic expectations.

**Curves (M11)** extend `buildWireframePrimitive()`: polyline (a wire of
verified `MakeEdge_3` segments — each segment gets its own pickable `edge-N`),
three-point arc (`GC_MakeArcOfCircle_4(p1, p2, p3)`; `IsDone()` false for a
collinear triple), spline (`GeomAPI_PointsToBSpline_2(TColgp_Array1OfPnt_2, 3,
8, GeomAbs_C2, 1e-6)` — an approximating, endpoint-exact fit;
`GeomAPI_Interpolate` is **not bound** in this build), Bézier
(`Geom_BezierCurve_1(arr)`), ellipse arc (trimmed `MakeEdge_13(elips, a1, a2)`,
with a −90° angle shift when the radii swap so trim angles stay measured from
`up`), and helix (a 2D segment in the (angle, height) parameter space of a
`Geom_CylindricalSurface_1`, `MakeEdge_30(h2dcurve, hsurface)`, then
`BRepLib.BuildCurves3d_2(edge)` builds the real 3D curve). Geom-handle curves
become edges via the shared `edgeFromCurveHandle()` (`Handle_Geom_Curve_2` +
`MakeEdge_24`).

**Modify ops (M12)**, all B-rep only: `shellSolids()` hollows the solid(s)
owning the selected opening faces via `BRepOffsetAPI_MakeThickSolid_1()` +
`MakeThickSolidByJoin(solid, TopTools_ListOfShape, offset, tol, BRepOffset_Skin,
false, false, GeomAbs_Arc, false)` — 9 args, no progress arg; **an empty closing
list does NOT hollow** (it yields the plain offset solid), which is why the op
requires ≥1 opening face and derives each face's owning solid itself.
`splitSolidsByPlane()` is a **half-space cut with zero new bindings**: an
axis-aligned box spanning the negative side of z=0 (10× bbox diagonal) is moved
onto the split plane with the mate-verified `SetDisplacement`, then
`positive → Cut_3`, `negative → Common_3`, `both → compound of both`.
`sectionSolids()` intersects a large `buildFlatFace()` plane with the targets
via `Common_3` (verified to return exactly the trimmed cross-section face) and
**appends** the result non-destructively — it lands under `"Sketches"` via the
free-face pass, pickable like any sketch; a plane that misses appends nothing.

---

## `src/editOps.ts`, `src/editsStore.ts`, `src/editsSidecar.ts`

The edit-operation model and its sidecar, mirroring the parts trio.

`src/editOps.ts` is **vscode-free** and holds the `EditOp` discriminated union plus:

```typescript
type ExprMap = Record<string, string>                    // field path → expression string
function validateEditOp(raw: unknown): EditOp | null   // single tolerance gate
const TOPOLOGY_CHANGING_OPS: ReadonlySet<EditOp["op"]>  // re-id faces/edges on reload
const BREP_ONLY_OPS: ReadonlySet<EditOp["op"]>          // disabled for mesh files
```

Every `EditOp` may carry an optional parametric annotation `exprs?: ExprMap`
(see [File Formats](./file-formats.md#parametric-variables)); `validateEditOp`
sanitizes it against the already-validated op (only keys addressing a finite
numeric slot, only syntactically valid expressions, size-capped) and carries it
onto the clean op.

`src/editsSidecar.ts` is **vscode-free** (unit-tested): `parseEditsJson(text)`
returns `{ ops, variables }` — it runs every op through `validateEditOp` and the
variables through `validateVariables`, then **re-resolves** the ops' expressions
against the variables (`resolveEditOps`), healing stale cached numbers in a
hand-edited sidecar. `serializeEditsJson(sourceName, ops, variables)` is
version-stamped with a trailing newline; `variables` is omitted when empty.

`src/editsStore.ts` wraps them with VS Code filesystem access: `editsSidecarUri()`
(`<model>.edits.json`), `readEdits()` (tolerant — empty lists on
missing/unreadable), and `writeEdits(uri, ops, variables)` (writes only the
sidecar; the CAD file is never touched).

---

## `src/paramExpr.ts`, `src/editVariables.ts`

The parametric layer — both **vscode/DOM-free** (unit-tested), imported by the
host (sidecar parsing) and the webview (input parsing, resolve-on-read).

`src/paramExpr.ts` is a hand-written recursive-descent expression evaluator
(webview CSP blocks `eval()`): numbers, variable identifiers, `+ - * / ^`,
unary minus, parentheses, `sqrt/abs/min/max/floor/ceil/round/sin/cos/tan`
(degrees) and `pi`. Plus field-path addressing for `exprs` keys:

```typescript
function evalExpr(src: string, vars: Record<string, number>): { ok: true; value: number } | { ok: false; error: string }
function parseExprSyntax(src: string): boolean       // unknown identifiers allowed
function extractIdentifiers(src: string): string[]
function isValidVariableName(s: string): boolean
function parseFieldPath(path: string): (string | number)[] | null  // "size[1]", "points[2][0]"
function getNumericField(op: unknown, path: FieldPath): number | null
function setNumericField(op: unknown, path: FieldPath, v: number): boolean  // only into finite-number slots
```

`src/editVariables.ts` holds `ParamVariable` (`{name, expr, value}` — `value`
is the cached last-good evaluation) and:

```typescript
function validateVariables(raw: unknown): ParamVariable[]  // tolerance gate (names, dupes, size caps)
function evaluateVariables(vars: ParamVariable[]): { values: Record<string, number>; errors: Map<string, string> }
function resolveEditOps(ops: EditOp[], values: Record<string, number>): { ops: EditOp[]; issues: string[] }
```

`evaluateVariables` runs in list order against earlier-defined names only
(derived variables work, cycles are unrepresentable); a failing variable keeps
its cached `value`. `resolveEditOps` clones each annotated op, patches the
addressed fields, and re-runs `validateEditOp` on the result — an op whose
resolved values violate a cross-field invariant is kept at its previous values
(issue recorded, replay never hard-fails). Resolution runs at exactly two
sites: `parseEditsJson` (host) and the webview's resolve-on-read
(`currentResolvedOps` in `src/webview/main.ts`) — the host otherwise receives
already-resolved ops and never evaluates expressions at runtime.

---

## `src/gmshService.ts`

Manages the GMSH-wasm singleton (a **second**, independent Emscripten module from
OCCT's) and performs finite-element mesh generation. See
[GMSH Integration](./gmsh-integration.md) for the full write-up (input paths,
options, sidecars, protocol messages, and known WASM-build limitations); this
section covers the module's API surface only.

### Types

```typescript
type MeshGenerationInput =
  | { kind: "brep"; stepBytes: Uint8Array }
  | { kind: "stl"; stlBytes: Uint8Array }

interface MeshResult {
  positions: Float32Array   // boundary triangulation vertices
  indices: Uint32Array      // boundary triangulation indices (0-based)
  nodeCount: number         // full mesh node count
  elementCount: number      // full mesh element count
  mshText: string           // raw .msh file contents
}
```

### Functions

```typescript
function getGmsh(extensionPath: string): Promise<GmshApi>
```
Returns the memoized GMSH-wasm module, mirroring `getOcct`'s lazy-init discipline:
never called from `activate()`, initialized on the first call to `generateMesh`/
`exportGeoUnrolled`/`exportMeshFormat` (i.e. the first time the user clicks
**▶ Generate** or **📤 Export** — never on file open). Reads
`dist/gmsh-core.wasm` and passes it as `wasmBinary` to the raw Emscripten factory
(the same reason as OCCT: passing `wasmBinary` explicitly avoids Node's `fetch()`
fallback, which cannot resolve a filesystem path), then calls the module's own
`gmsh.initialize()` exactly once and memoizes the resolved promise. Subsequent
mesh generations reuse this singleton — per-generation state is reset with
`gmsh.clear()` + `gmsh.model.add(...)` inside `loadGeometryAndApplyOptions`
(private), never a second `gmsh.initialize()`.

```typescript
function resetGmsh(): void
```
Resets the singleton (and the internal model-name counter) to its initial state.
Used by tests and for future hot-reload support.

```typescript
async function generateMesh(
  extensionPath: string,
  input: MeshGenerationInput,
  options: MeshOptions
): Promise<MeshResult>
```
Loads `input`'s geometry into a fresh GMSH model, applies `options` (`Mesh.
MeshSizeMin/Max`, `Mesh.Algorithm`, `Mesh.Algorithm3D`, `Mesh.ElementOrder`, `Mesh.
RecombineAll`, `Mesh.SubdivisionAlgorithm`, `Mesh.Optimize`), calls
`gmsh.model.mesh.generate(options.dimension)`, and reads the result back. For
`dimension === 3` the returned `positions`/`indices` are the volume mesh's
**boundary surface**, derived by enumerating each 3D cell's boundary faces
(tetrahedra, hexahedra, prisms, pyramids — via the shared `src/gmshElementTypes.ts`
table) keyed by *sorted corner* node tags so a face shared by two cells collides to
the same key, keeping only faces that occur exactly once (quad faces triangulate
into two); for `dimension === 2` the generated surface elements (triangles or
recombined quads) are used directly; for `dimension === 1` there is
no triangle to display and both buffers are empty. Writes `/out.msh` to GMSH's
MEMFS and reads it back as `mshText`. Cleans up (`FS.unlink`) both the input and
output MEMFS paths in a `finally`, mirroring `occtService.ts`'s handle-cleanup
discipline (though here the "handles" are MEMFS files, not Emscripten object
handles — GMSH-wasm's JS API doesn't expose C++ object lifetimes the way OCCT's
bindings do).

```typescript
async function exportGeoUnrolled(
  extensionPath: string,
  input: MeshGenerationInput,
  options: MeshOptions
): Promise<string>
```
Same geometry-import + options setup as `generateMesh` (via the shared private
`loadGeometryAndApplyOptions`), but calls `gmsh.write("/out.geo_unrolled")`
instead of meshing, and returns the resulting text — lets the FE Mesh panel's
export `<select>`/**📤 Export** offer a `.geo_unrolled` target without a second
`getGmsh`/import round trip. Note this is **not** the same file as the
autogenerated `<model>.geo` sidecar (see `meshOptionsSidecar.ts` below) — GMSH-JS
has no API to emit a clean, parametric `.geo` script from in-memory state, only
this fully-expanded "unrolled" form.

```typescript
async function exportMeshFormat(
  extensionPath: string,
  input: MeshGenerationInput,
  options: MeshOptions,
  parts: Part[],
  formatId: Exclude<MeshExportFormatId, "msh" | "geoUnrolled">
): Promise<string>
```
The generic sibling of `generateMesh`/`exportGeoUnrolled` covering every other
format in `src/meshExportFormats.ts`'s `MESH_EXPORT_FORMATS` registry (VTK,
I-DEAS Universal, Abaqus, Nastran, SU2, INRIA Medit, STL, Diffpack, OFF, and
the legacy MSH v2 writer). Unlike `.geo_unrolled`, none of these formats have a
companion file to handle — `gmsh.write()` dispatches purely by the output
path's extension, so this is a thin `loadGeometryAndApplyOptions` →
`mesh.generate(options.dimension)` → `gmsh.write("/out.<extension>")` →
read-back-as-text. CGNS and MED are recognized by Gmsh's writer-dispatch table
but throw `"...compiled without CGNS support"`/`"...must be compiled with MED
support..."` in this WASM build (both need HDF5-backed libs not linked in) —
excluded from the registry entirely rather than offered as a format that
always fails; see [GMSH Integration](./gmsh-integration.md) for the full
per-format probe results against the live WASM build.

**Two input paths, both converging on the shared options step:**
- **B-rep** (`kind: "brep"`) — `stepBytes` are written to GMSH's MEMFS as
  `/model.step`, then `gmsh.model.occ.importShapes(tmpPath)` +
  `gmsh.model.occ.synchronize()` load them.
- **STL** (`kind: "stl"`) — `stlBytes` are written as `/model.stl`, then
  `gmsh.merge(tmpPath)` + `gmsh.model.mesh.classifySurfaces(...)` +
  `gmsh.model.mesh.createGeometry()` reclassify the raw triangle soup into
  parametric surfaces, and `gmsh.model.geo.addSurfaceLoop`/`addVolume`/
  `synchronize` declare a volume so a 3D mesh can be generated from a format
  that otherwise has no volume topology.

`src/provider.ts`'s `resolveMeshInput` decides which input a given document
produces: B-rep documents call the existing `exportBRep()` to get `stepBytes`
(so live, unsaved edits are baked in the same way normal Export does); mesh
documents have no B-rep to re-export, so the *webview* serializes its currently
displayed model to STL and sends it up as a base64 `stl` field on the
`meshingGenerate`/`meshingExport` message.

---

## `src/meshExtract.ts`

Extracts WebGL-ready geometry buffers from an OCCT shape.

### Types

```typescript
interface GeometryBuffers {
  positions: Float32Array   // XYZ vertex positions
  normals: Float32Array     // XYZ vertex normals (currently unused by the webview material)
  indices: Uint32Array      // Triangle indices (0-based)
}

interface FaceMesh {
  faceId: string            // stable per-face entity id ("face-N")
  buffers: GeometryBuffers
}

interface EdgeLine {
  edgeId: string            // stable per-edge entity id ("edge-N")
  positions: Float32Array   // consecutive xyz points; pairs form polyline segments
}

interface PointEntity {
  pointId: string            // stable per-vertex entity id ("point-N")
  position: [number, number, number]
}

interface SolidGroup {
  id: string
  label: string
  faceCount: number
  faces: FaceMesh[]
}
```

Duck-typed interfaces for OCCT objects (so unit tests can mock them without WASM):

```typescript
interface OcctPoint { X(): number; Y(): number; Z(): number }
interface OcctTriangle { Get(): [number, number, number] }
interface OcctPolyTriangulation {
  NbNodes(): number
  NbTriangles(): number
  Node(i: number): OcctPoint
  Triangle(i: number): OcctTriangle
}
interface OcctTrsf { /* transform methods */ }
interface OcctDiscretizer { NbPoints(): number; Value(i: number): OcctPoint }
```

### Functions

```typescript
function extractFaceGeometry(
  tri: OcctPolyTriangulation,
  trsf: OcctTrsf,
  isReversed: boolean
): GeometryBuffers
```
Extracts vertices and triangles from a single OCCT face's triangulation. Applies the face's location transform. If `isReversed` is true, swaps triangle winding order so face normals point outward. OCCT uses 1-based indexing; this function converts to 0-based for WebGL.

```typescript
function tessellateByGroup(oc: any, shape: any): SolidGroup[]
```
Tessellates the entire `TopoDS_Shape`. Uses `BRepMesh_IncrementalMesh_2` with linear deflection `0.1`. Explores solids via `TopExp_Explorer`, then within each solid explores faces and calls `extractFaceGeometry`. Returns one `SolidGroup` per solid, each face tagged with a stable global `faceId` (deterministic explorer order).

When solids exist, it also runs a **free-face pass** (`extractFreeFaces`): every face touched while processing a solid is "claimed" into a `HashCode`-bucketed map (via `extractFacesFromShape`'s optional `claim` parameter — the claimed face handles are pushed into `tessellateByGroup`'s own long-lived `cleanup`, not the per-call one, so they outlive the comparison), then the whole shape's faces are walked once more and anything not claimed (`IsSame` check) becomes an extra `"Sketches"` group. This surfaces standalone 2D profile faces added via `addCircleProfile`/`addRectangleProfile`/`addPolygonProfile` (`src/occtOperations.ts`), which would otherwise be silently dropped — without it, a bare `TopoDS_Face` mixed into the compound never gets tessellated or a `faceId`. **`occtOperations.ts`'s `collectFaces` duplicates this exact algorithm** so `face-N` ids resolve consistently between the read/display path and the edit-resolution path; see that file's docs above for why keeping the two in lockstep matters. `triangulateFace` factors out the per-face triangulation logic shared by the solid pass, the no-solids fallback, and the free-face pass.

```typescript
function extractEdges(oc: any, shape: any): EdgeLine[]
```
Explores every `TopoDS_Edge`, de-duplicating shared edges by `HashCode` bucket + `IsSame` (this OCCT build does **not** bind `TopTools_IndexedMapOfShape`), then discretizes each unique edge to a polyline via `BRepAdaptor_Curve_2` + `GCPnts_UniformDeflection_2` (both verified against the live WASM). The first appearance in explorer order fixes the stable `edgeId`.

```typescript
function polylineFromDiscretizer(disc: OcctDiscretizer): Float32Array
```
Pure helper (unit-tested) that packs a discretizer's points into a flat xyz array, deleting each `gp_Pnt` handle it reads.

```typescript
function extractVertices(oc: any, shape: any): PointEntity[]
```
Explores every `TopoDS_VERTEX` in the whole shape (`TopExp_Explorer_2(shape,
TopAbs_VERTEX, TopAbs_SHAPE)`), de-duplicating by `HashCode` bucket + `IsSame` (same
technique as `extractEdges`). Unlike face/edge extraction there is no claim/free
distinction and no discretization filter — a vertex is always exactly one point.
Runs unconditionally over the whole shape (original geometry's corners **and** any
user-added standalone points), since nothing downstream ever resolves a `point-N`
id back to a live vertex — point extraction is purely for display.

**Memory discipline:** Every OCCT handle created in these functions is pushed onto a local `cleanup[]` array. A `try/finally` block deletes them in reverse order regardless of success or failure. In `extractEdges`, deduped edge handles are kept alive in `cleanup` until the end so later `IsSame` comparisons stay valid.

```typescript
function tessellateShape(oc: any, shape: any): GeometryBuffers[]
```
Legacy flat tessellation (no grouping). Kept for test compatibility. Returns one `GeometryBuffers` per face.

---

## `src/partsStore.ts` and `src/partsSidecar.ts`

Persist user-defined parts in a `<model>.parts.json` sidecar beside the CAD file.
The CAD file is never written — only the sidecar — so the editor stays read-only.

`src/partsSidecar.ts` is **vscode-free** (so it unit-tests under vitest):

```typescript
function parsePartsJson(text: string): Part[]          // tolerant: returns [] on bad input
function serializePartsJson(sourceName: string, parts: Part[]): string
```

`src/partsStore.ts` wraps them with VS Code filesystem access:

```typescript
function sidecarUri(modelUri: vscode.Uri): vscode.Uri  // <model>.parts.json
async function readParts(modelUri): Promise<Part[]>     // [] if missing/unreadable
async function writeParts(modelUri, parts): Promise<void>
```

`provider.ts` calls `readParts()` on open (posts a `parts` message) and, on each
debounced `partsChanged` message (~500 ms), `writeParts()`.

---

## `src/meshOptions.ts`, `src/meshOptionsStore.ts`, `src/meshOptionsSidecar.ts`

The FE-mesh options model and its sidecar pair, mirroring the parts/edits trios
(see [GMSH Integration](./gmsh-integration.md) for the feature-level write-up).

`src/meshOptions.ts` is **vscode-free** and holds the flat `MeshOptions` bag plus:

```typescript
const DEFAULT_MESH_OPTIONS: MeshOptions
function validateMeshOptions(raw: unknown): MeshOptions | null   // single tolerance gate
```
Unlike `EditOp`'s validator, `validateMeshOptions` clamps/defaults **individual**
invalid fields to the matching `DEFAULT_MESH_OPTIONS` field rather than rejecting
the whole object — `raw` is only rejected outright (returns `null`) when it isn't
an object at all. `sizeMin`/`sizeMax` are validated as a pair: if `sizeMin >
sizeMax` after individually clamping each, both fall back to the defaults
together rather than leaving an inconsistent pair.

`src/meshOptionsSidecar.ts` is **vscode-free** (unit-tested):

```typescript
function parseMeshJson(text: string): MeshOptions          // tolerant: DEFAULT_MESH_OPTIONS on any failure
function serializeMeshJson(sourceName: string, options: MeshOptions): string
function generateGeoScript(sourceName: string, options: MeshOptions): string
```
`generateGeoScript` templates a `.geo` Gmsh script directly from the `MeshOptions`
JSON (`Merge "<source>"` + one `Mesh.*` assignment per field + a trailing
`Mesh <dimension>;`) — this exists because GMSH-JS itself has no API to emit a clean,
parametric `.geo` file from in-memory model state (only the fully-expanded
`.geo_unrolled` form via `gmsh.write()`, see `gmshService.ts` above). The
generated file's own header comment states it is auto-generated; **hand-edits to
`<model>.geo` are never read back by the extension** — it is regenerated
wholesale from the sidecar on every options change.

`src/meshOptionsStore.ts` wraps them with VS Code filesystem access:

```typescript
function meshOptionsSidecarUri(modelUri: vscode.Uri): vscode.Uri  // <model>.mesh.json
async function readMeshOptions(modelUri): Promise<MeshOptions>     // DEFAULT_MESH_OPTIONS if missing/unreadable
async function writeMeshOptions(modelUri, options): Promise<void>
function geoScriptUri(modelUri: vscode.Uri): vscode.Uri            // <model>.geo
async function writeGeoScript(modelUri, options): Promise<void>
```
`provider.ts` calls `readMeshOptions()` on `ready` (posts a `meshingOptions`
message) and, on each debounced `meshingChanged` message (~500 ms, its own timer
separate from parts/edits), calls **both** `writeMeshOptions()` and
`writeGeoScript()` — the sidecar and the generated script are always kept in
sync with each other. Neither the CAD file nor any other sidecar is touched.

---

## `src/protocol.ts`

Defines the host ↔ webview message contract. See [Host ↔ Webview Protocol](./protocol.md) for the full reference.

### Buffer Encoding

```typescript
function encodeBuffer(arr: Float32Array | Uint32Array): string
```
Encodes a typed array as a base64 string for safe `postMessage` transport. Uses `Buffer.from(arr.buffer).toString('base64')` (Node.js `Buffer` — host-side only).

The corresponding decode helpers (`decodeF32`, `decodeU32`) live in `src/webview/geometryBuilder.ts` and use browser `atob`.

---

## `src/mcpServer.ts`, `src/mcpTools.ts`, `src/mcpSidecars.ts`

The standalone MCP server — a third esbuild bundle (`dist/mcp-server.js`) that
exposes the same headless pipeline (`loadBRep`/`exportBRep`/`generateMesh`/
`exportMeshFormat`/`exportMdpa`/`exportGeoUnrolled`) to AI agents over stdio
JSON-RPC, with no VS Code involved.

- **`mcpServer.ts`** is the entry: it rebinds `console.log/info/warn/debug` to
  stderr *before anything else* (the Emscripten WASM modules print through
  `console.log`, and stdout is the JSON-RPC channel), resolves `extensionPath`
  (`CAD_PREVIEW_ROOT` env var or the bundle dir's parent), and registers the
  eleven tools with the `@modelcontextprotocol/sdk` `McpServer` +
  `StdioServerTransport`.
- **`mcpTools.ts`** holds the tool handlers as plain async functions over an
  injected `Pipeline` object (defaulting to the real OCCT/Gmsh functions in the
  server, faked in `mcpTools.test.ts` — the `.wasm` imports only resolve under
  esbuild's plugin, never vitest). Ops arrive as raw JSON gated by
  `validateEditOp`; results are stats/summaries, never geometry buffers.
- **`mcpSidecars.ts`** is the node-fs counterpart of `editsStore.ts`/
  `partsStore.ts`/`meshOptionsStore.ts` over the same pure `*Sidecar.ts`
  parsers — byte-compatible with what `provider.ts` reads on reopen — plus the
  `assertNotSourcePath` guard enforcing the CAD-file-is-never-written invariant.

See [MCP Server](./mcp-server.md) for registration, the tool reference, and the
headless capability matrix.
