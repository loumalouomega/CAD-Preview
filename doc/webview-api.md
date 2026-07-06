# Webview API

The webview runs in a Chromium browser context. These modules are bundled into `media/viewer.js` (IIFE) and have no access to Node.js APIs.

## Module Index

| Module | Responsibility |
|--------|---------------|
| `src/webview/main.ts` | Entry point, VS Code API, message routing, UI wiring |
| `src/webview/viewer.ts` | Three.js scene, camera, rendering, gizmo |
| `src/webview/cameraControls.ts` | Pure camera math utilities (unit-testable) |
| `src/webview/orientationCube.ts` | Orientation gizmo (no own renderer) |
| `src/webview/geometryBuilder.ts` | Decode and build per-face meshes + per-edge lines from encoded buffers |
| `src/webview/meshLoaders.ts` | Dispatch to Three.js loaders by format |
| `src/webview/meshExporters.ts` | Dispatch to Three.js exporters by format |
| `src/webview/treePanel.ts` | Component tree panel DOM management |
| `src/webview/picking.ts` | Resolve a raycast hit + selection mode to an entity (unit-testable) |
| `src/webview/selection.ts` | Transient (not-yet-assigned) entity selection set |
| `src/webview/partsModel.ts` | Parts data model + operations, colour resolution (unit-testable) |
| `src/webview/partsPanel.ts` | Editable Parts panel DOM management |
| `src/webview/editsModel.ts` | Edit op-stack (push/undo/redo/clear + redo buffer), DOM-free (unit-tested) |
| `src/webview/opCatalog.ts` | Op catalog: GEOMETRY/EDIT tab structure + `describeOp`, DOM-free (unit-tested) |
| `src/webview/opIcons.ts` | Per-op icon placeholders — the one file to edit for real icons |
| `src/webview/editsPanel.ts` | Edits panel DOM — GEOMETRY (2D/3D) / EDIT tabs, op grids, param forms, op list |
| `src/webview/meshEdits.ts` | Webview edit engine for mesh formats (Three.js transforms; unit-tested) |
| `src/webview/meshFacets.ts` | Segment a mesh into coplanar facets → per-face sub-meshes (unit-tested) |
| `src/webview/meshingModel.ts` | Current FE-mesh `MeshOptions` store, DOM-free (unit-tested) |
| `src/webview/meshingPanel.ts` | FE Mesh panel DOM — size slider/presets, part sizes, Advanced settings, Generate/Export/Clear |
| `src/webview/meshSizeHeuristics.ts` | Pure size-slider math: bbox default, log mapping, element-count estimate (unit-tested) |

---

## `src/webview/main.ts`

Entry point for the webview bundle. Not exported — all logic runs at module level.

**Startup sequence:**
1. Acquire VS Code API: `const vscode = acquireVsCodeApi()`.
2. Instantiate `Viewer(document.getElementById('canvas'))`.
3. Instantiate `TreePanel(document.getElementById('tree-panel'))`, `PartsPanel`, `EditsPanel`, and `MeshingPanel(document.getElementById('meshing-panel'), ...)`.
4. Call `setupViewControls(viewer)` (in a `try/catch` — a UI wiring failure must not block the ready handshake).
5. Wire toolbar buttons (`#fit`, `#wireframe`, `#grid`, `#export`, `#tree-toggle`, `#meshing-toggle`). The `#export` button posts `{ type: "exportRequest" }` — it doesn't show any UI itself; the host owns the quick-pick and save dialog. `#meshing-toggle` (in its own `try/catch`, same rule as the view controls) only shows/clears the FE-mesh overlay — the panel itself is always visible.
6. Register `window.addEventListener('message', ...)` for host messages.
7. Post `{ type: 'ready' }` to the host.

**Message handler (host → webview):**

| `type` | Action |
|--------|--------|
| `"geometry"` | `buildGroupFromEncoded(msg.meshes, msg.edges, msg.points)` → `viewer.setModel(group)`, recolour, enable all pick modes (`volume`/`surface`/`line`/`point`), `MeshingPanel.setSourceKind("brep")`/`setModelExtents(...)` + `syncMeshSizeSeed()` |
| `"tree"` | `TreePanel.render(msg.root)` |
| `"loadUrl"` | `loadMeshFromUrl(msg.url, msg.format)` → `tagMeshEntities(obj)` → `splitMeshesIntoFacets(obj)` → `viewer.setModel(model)`, pick modes `volume` + `surface`, `MeshingPanel.setSourceKind("mesh")`/`setModelExtents(...)` + `syncMeshSizeSeed()` |
| `"parts"` | `PartsModel.load(msg.parts)` → recolour model → `PartsPanel.render()` + `MeshingPanel.renderParts()` |
| `"edits"` | `EditsModel.load(msg.ops)` → (mesh sources) `rebuildMeshModel()` → `EditsPanel.render()` |
| `"status"` | Set `#status-text` content |
| `"error"` | Show `#error-overlay` with message |
| `"editError"` | Show `#error-overlay` with message (same rendering as `"error"`, distinct only by intent) |
| `"exportMesh"` | `exportModel(viewer.getModel(), msg.format)` → posts back `"exportResult"` (with `data`/`binary`) or `"exportError"` on failure, correlated by `msg.requestId` |
| `"meshingOptions"` | `MeshingModel.load(msg.options)` (hydration only) → `syncMeshSizeSeed()` → `MeshingPanel.render()` |
| `"meshingResult"` | `viewer.setMeshOverlay(buildFEMesh(msg.positions, msg.indices, msg.elementGroups))` → `MeshingPanel.render(..., { nodeCount, elementCount, elapsedMs })` |
| `"meshingError"` | `MeshingPanel.render(..., { error: msg.message })` |

The webview also posts `{ type: "partsChanged", parts }` whenever the user edits
parts, `{ type: "editsChanged", ops }` whenever the op-stack mutates, and
`{ type: "meshingChanged", options }` whenever a mesh-option control changes;
the host debounces each independently and writes the matching sidecar(s). See
`meshingModel.ts`/`meshingPanel.ts` below for the FE-mesh wiring, including
`currentStlIfMeshSource()` — the helper that snapshots the displayed model to
base64 STL (via `meshExporters.ts`'s `exportModel`) for `meshingGenerate`/
`meshingExport` on mesh-format documents, since the host has no B-rep to
re-export for those.

**Helper functions:**

```typescript
function tagMeshEntities(obj: THREE.Object3D): void
```
Assigns **stable** traversal-order ids (`node-N`, not `uuid`) as `userData.groupId`
to every object, and additionally tags each `THREE.Mesh` as a pickable whole-object
volume entity (`entityType: "surface"`, `entityId: node-N`). Stable ids let mesh-format
part assignments round-trip across reopen; the shared id keeps `viewer.highlightGroup()`
working for the component tree.

```typescript
function extractObjectTree(obj: THREE.Object3D, rootLabel: string): TreeNode
```
Builds a `TreeNode` hierarchy from a Three.js `Object3D` tree. Uses `obj.name` (or a fallback label) for `label`; the stable `userData.groupId` for `id`.

```typescript
function hasMultipleNodes(root: TreeNode): boolean
```
Returns `true` if the root has more than one child (or any grandchild). The tree panel is shown only when this is true.

---

## `src/webview/viewer.ts`

### `Viewer`

The main Three.js controller. Owns the scene, camera, renderer, lights, controls, helpers, and gizmo.

```typescript
class Viewer {
  constructor(canvas: HTMLCanvasElement)
}
```

The constructor creates:
- `PerspectiveCamera` (FOV 45, near 0.001, far 10000)
- `WebGLRenderer` with antialiasing and device pixel ratio
- `OrbitControls` with damping (factor 0.1)
- Two lights: `AmbientLight(0xffffff, 0.6)` + `DirectionalLight(0xffffff, 0.8)`
- `GridHelper` and `AxesHelper` (hidden by default)
- `OrientationCube` instance

**Model management:**

```typescript
getModel(): THREE.Object3D | null
```
Returns the currently displayed model, or `null` if none has loaded yet. Used by
`main.ts`'s `"exportMesh"` handler to hand the model to `exportModel()`.

```typescript
getModelExtents(): { size: [number, number, number]; diagonal: number } | null
```
The current model's world-space bounding-box dimensions and diagonal, or `null`
if no model is loaded (or its box is empty). Recomputed on demand with the same
`Box3` math `frame()` uses, so it automatically tracks edit-driven model
rebuilds. Feeds the FE Mesh panel's bbox-derived default size and element-count
estimate (`meshSizeHeuristics.ts`) — display-only, never mutates geometry.

```typescript
setModel(object: THREE.Object3D): void
```
Replaces the current model. Calls `clearModel()`, adds the new object to the scene, applies the current wireframe state to all meshes, calls `resetView()` to reframe.

```typescript
clearModel(): void
```
Removes the current model from the scene, disposes all geometries and materials (recursive), and resets the root reference.

```typescript
setMeshOverlay(obj: THREE.Object3D | null): void
```
Replaces the generated FE-mesh overlay (from `geometryBuilder.buildFEMesh()`).
Disposes the previous overlay's geometries/materials and removes it from the
scene — the overlay is a **sibling of `model`**, never one of its children, so
toggling it off leaves the original geometry completely untouched. Pass `null`
to just clear the overlay. `setModel()` calls `this.setMeshOverlay(null)` as its
very first line: a previously-generated overlay was computed from the *old*
geometry and must not linger looking valid over a newly-loaded model.

`setMeshOverlay()` also toggles the model's shaded faces via the private
`setModelFacesVisible()` helper: showing an overlay (`obj !== null`) hides every
mesh tagged `userData.entityType === "surface"` (leaving edges/points visible as
a feature-line reference), and clearing it (`obj === null`) restores them. Two
opaque solids occupying the same space are illegible layered on top of each
other; this is display-only (`Object3D.visible`), never touches geometry.

```typescript
setMeshOverlayVisible(visible: boolean): void
```
Shows/hides the *current* overlay in place (`Object3D.visible`) without
disposing it, mirroring the model-faces visibility via the same
`setModelFacesVisible()` helper. This is what the toolbar's FE Mesh toggle
calls — switching it off then back on must redisplay the same generated mesh
instantly, with no re-run of Generate needed. A no-op when `meshOverlay` is
`null` (nothing generated yet). Distinct from `setMeshOverlay(null)`, which
actually disposes the overlay and is reserved for a new model loading, the
panel's Clear button, or a fresh Generate replacing it with a new one.

**Camera operations:**

```typescript
fitView(): void
```
Computes the bounding sphere of the model and repositions the camera to frame it while keeping the current view direction. Also adjusts `OrbitControls.target` to the sphere center and updates near/far clip planes.

```typescript
resetView(): void
```
Resets the view direction to the default isometric `(1, 0.8, 1)` (normalized) and then calls `fitView()`. Called by `setModel()` on every new file open.

```typescript
rotateView(azimuthDeg: number, polarDeg: number): void
```
Orbits the camera by the given azimuth and polar increments (degrees) via `cameraControls.orbit()`. Then calls `controls.update()`.

```typescript
panView(dxFrac: number, dyFrac: number): void
```
Pans both the camera and `OrbitControls.target` by fractions of the viewport via `cameraControls.pan()`. Then calls `controls.update()`.

```typescript
zoomView(factor: number): void
```
Dollies the camera toward/away from the target by the given multiplier via `cameraControls.dolly()`. Then calls `controls.update()`.

```typescript
setViewDirection(dir: THREE.Vector3): void
```
Repositions the camera along `dir` (from the current target) without changing the orbit distance. Uses `cameraControls.setDirection()`.

```typescript
getViewDirection(): THREE.Vector3
```
Returns the normalized vector from the current OrbitControls target to the camera.

```typescript
getCameraUp(): THREE.Vector3
```
Returns `camera.up` (the "up" vector used by OrbitControls).

**Scene state:**

**Point rendering:** each `frame()` call (on `setModel`/`fitView`/`resetView`)
computes `pointSpriteScale = radius * 0.01` (the model's bounding-sphere radius,
same input `pickThreshold` already uses) and applies it to every `THREE.Sprite`'s
`.scale` in the model — this keeps point markers a roughly constant fraction of
model size regardless of scale. This is a separate mechanism from
`raycaster.params.Line.threshold` (Line-only); sprites have their own hit-testing
via `THREE.Sprite`'s native raycasting.

```typescript
highlightGroup(groupId: string | null): void
```
If `groupId` is non-null, dims all meshes in the model except the one whose `userData.groupId` matches — opacity set to `0.08` for dimmed meshes, `1.0` for the selected one, `transparent: true` on dimmed materials. If `groupId` is null, restores all meshes to full opacity.

```typescript
setWireframe(on: boolean): void
```
Sets `material.wireframe` on every mesh in the scene. Memoizes the state so `setModel()` can re-apply it.

```typescript
toggleGrid(): void
```
Toggles the visibility of the `GridHelper` and `AxesHelper`.

```typescript
dispose(): void
```
Full cleanup: disposes model, renderer, and removes the resize observer.

**Internal:**

```typescript
private renderGizmo(): void
```
Draws the `OrientationCube` into a 120×120 scissor viewport in the top-left corner using the main renderer. Called at the end of each `animate` frame.

```typescript
private onGizmoPointerDown(event: PointerEvent): void
```
Capture-phase handler on the canvas. If the pointer is within the gizmo rectangle, calls `orientationCube.pick(ndcX, ndcY)` to get a snap direction and calls `setViewDirection()`. Calls `event.stopImmediatePropagation()` to prevent OrbitControls from firing.

### `meshFromGeometry`

```typescript
function meshFromGeometry(geometry: THREE.BufferGeometry): THREE.Mesh
```
Creates a `THREE.Mesh` with a standard grey `MeshStandardMaterial` (color `0xc0c4cc`, metalness `0.1`, roughness `0.7`, `DoubleSide`).

---

## `src/webview/cameraControls.ts`

Pure math functions — no DOM, no renderer, no OrbitControls dependency. Unit-tested headlessly via Vitest.

All functions operate on a `THREE.PerspectiveCamera` and a `THREE.Vector3` target. They mutate `camera.position` and/or `target` in place.

```typescript
function orbit(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  azimuthDeg: number,
  polarDeg: number
): void
```
Rotates the camera around the target using spherical coordinates. `azimuthDeg` rotates in the horizontal plane; `polarDeg` rotates vertically. Clamps polar angle to `[1°, 179°]` to avoid gimbal lock at the poles.

```typescript
function pan(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  dxFrac: number,
  dyFrac: number
): void
```
Translates both camera and target by `dxFrac` × viewport-width in the camera's right direction and `dyFrac` × viewport-height in the camera's up direction. Maintains the camera-to-target distance.

```typescript
function dolly(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  factor: number
): void
```
Moves the camera toward (`factor > 1`) or away from (`factor < 1`) the target, scaling the distance by `factor`. Does not move the target.

```typescript
function setDirection(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  dir: THREE.Vector3
): void
```
Repositions the camera along the direction `dir` (normalized) from the target, maintaining the current camera-to-target distance.

```typescript
function viewDirection(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3
): THREE.Vector3
```
Returns the normalized vector from the target to the camera (`camera.position.clone().sub(target).normalize()`).

---

## `src/webview/orientationCube.ts`

### `OrientationCube`

A labeled 3D orientation gizmo. Has its own `THREE.Scene` and `THREE.OrthographicCamera` but **no `WebGLRenderer`**. Drawn by `Viewer.renderGizmo()` via scissor viewport.

```typescript
class OrientationCube {
  readonly scene: THREE.Scene
  readonly viewCamera: THREE.Camera
  constructor()
}
```

The cube is a `THREE.BoxGeometry(1,1,1)` with six `MeshStandardMaterial`s, one per face. Each material uses a `CanvasTexture` with a drawn label:

| Face index | Label | Standard view |
|-----------|-------|---------------|
| 0 | +X | Right |
| 1 | -X | Left |
| 2 | +Y | Top |
| 3 | -Y | Bottom |
| 4 | +Z | Front |
| 5 | -Z | Back |

Three RGB axis arrows (`ArrowHelper`) are added to the scene alongside the cube.

```typescript
syncCamera(dir: THREE.Vector3, up: THREE.Vector3): void
```
Aligns the gizmo camera to match the main view. `dir` is the view direction (target → camera); `up` is `camera.up`.

```typescript
pick(ndcX: number, ndcY: number): THREE.Vector3 | null
```
Casts a ray from NDC coordinates `(ndcX, ndcY)` into the gizmo scene. Returns the face normal (in world space) of the first intersected face, or `null` if nothing was hit. The caller (`Viewer.onGizmoPointerDown`) converts NDC to the gizmo viewport's local coordinate space before calling this.

```typescript
dispose(): void
```
Disposes geometries, materials, and textures.

### `faceNormalToDirection`

```typescript
function faceNormalToDirection(n: THREE.Vector3): THREE.Vector3
```
Snaps a face normal (which may be slightly off-axis due to floating point) to the nearest cardinal axis direction (`±X`, `±Y`, `±Z`). Returns a unit vector along that axis.

### `makeLabelTexture`

```typescript
function makeLabelTexture(text: string): THREE.CanvasTexture
```
Draws `text` centered on a 64×64 `<canvas>` with a colored background matching the axis color convention (red for X, green for Y, blue for Z, grey for opposite faces). Returns a `THREE.CanvasTexture`.

---

## `src/webview/geometryBuilder.ts`

Decodes base64-encoded geometry from the host and builds a `THREE.Group`.

```typescript
function buildGroupFromEncoded(
  encodedMeshes: EncodedMesh[],
  encodedEdges: EncodedEdge[] = [],
  encodedPoints: EncodedPoint[] = []
): THREE.Group
```
Groups `encodedMeshes` by `groupId`. For each group, calls `mergeAndBuild()` to produce a `THREE.Mesh`. Sets `mesh.userData.groupId` so `Viewer.highlightGroup()` can identify it. Edges become a sibling `"edges"` group of `THREE.Line`s; points become a sibling `"points"` group of `THREE.Sprite`s (via `buildPointSprite`). Returns the root `THREE.Group`.

```typescript
function buildPointSprite(ep: EncodedPoint): THREE.Sprite
```
Builds a `THREE.Sprite` at the decoded position, tagged `userData = { entityType:
"point", entityId: ep.pointId }`. Uses a single shared, lazily-built canvas dot
texture (`dotTexture()` — memoized on first call, **not** built eagerly at module
load: an earlier eager version broke `viewer.test.ts`, which imports this module
transitively in a plain-Node vitest environment with no `document` available).
`THREE.Sprite` was chosen over `THREE.Points`/`PointsMaterial` (which would raycast
to a shared-buffer index, not a distinct `Object3D`, breaking the "one entity, one
tagged object" invariant every other picking/colouring path relies on) and over
per-vertex mesh geometry (real triangle cost × N, doesn't stay constant screen-size).

```typescript
function mergeAndBuild(meshes: { positions: Float32Array; indices: Uint32Array }[]): THREE.Mesh
```
Concatenates positions and remaps indices from multiple buffers into a single `THREE.BufferGeometry`. Calls `geometry.computeVertexNormals()`. Returns a `THREE.Mesh` via `meshFromGeometry()` (imported from `viewer.ts`).

```typescript
function buildFEMesh(positionsB64: string, indicesB64: string): THREE.Group
```
Builds the display group for a generated FE-mesh surface (a `meshingResult`
message's boundary triangulation), shown via `Viewer.setMeshOverlay()` — distinct
from the model's own B-rep/native faces. Decodes the buffers, builds a
`THREE.BufferGeometry`, and returns a `"feMesh"`-named `THREE.Group` containing:
a shaded `THREE.Mesh` (`MeshStandardMaterial`, color `0x4ea1ff` — a distinct hue
from the default face color so the overlay reads as separate from the model) plus
a `THREE.LineSegments` wireframe (`WireframeGeometry` + `LineBasicMaterial`,
color `0x1a3d66`) over the same geometry. Both are tagged
`userData.entityType = "mesh"` — deliberately **not** `"surface"`/`"line"`, so
the existing picking/parts-colouring code (which only recognizes
`"volume"|"surface"|"line"|"point"`) never tries to pick or colour the overlay.
The shaded mesh uses an unlit `MeshBasicMaterial` (not `MeshStandardMaterial`
like other face materials) — a tet-mesh boundary's many small, irregularly
oriented triangles shade unevenly under scene lighting, which looks like
scattered holes even on a complete, watertight mesh; flat color avoids that.
It also sets `polygonOffset: true` (`polygonOffsetFactor`/`polygonOffsetUnits:
1`) because its wireframe is built from that exact same geometry — perfectly
coincident triangles/lines z-fight without it.

**Decode helpers:**

```typescript
function decodeF32(b64: string): Float32Array
function decodeU32(b64: string): Uint32Array
```
Decode a base64 string (via `atob`) to a typed array. Browser-side counterparts to `encodeBuffer()` on the host.

---

## `src/webview/meshLoaders.ts`

Dispatches to Three.js loaders by format.

```typescript
async function loadMeshFromUrl(
  url: string,
  format: CadFormat
): Promise<THREE.Object3D>
```

| `format` | Loader | Post-processing |
|----------|--------|----------------|
| `"stl"` | `STLLoader` | Wraps `BufferGeometry` in a `THREE.Mesh` |
| `"obj"` | `OBJLoader` | Calls `applyDefaultMaterial(group)` |
| `"ply"` | `PLYLoader` | Calls `geometry.computeVertexNormals()` |
| `"gltf"` | `GLTFLoader` | Returns `gltf.scene` |

```typescript
function applyDefaultMaterial(group: THREE.Group): void
```
Walks all `THREE.Mesh` children. For each mesh that has no material or has a `MeshBasicMaterial` (the OBJLoader default), replaces it with a `MeshStandardMaterial` (color `0x888888`).

---

## `src/webview/meshExporters.ts`

Dispatches to Three.js's bundled exporters (`three/examples/jsm/exporters/`) by
format. Works on any loaded `THREE.Object3D`, regardless of whether it arrived via a
native mesh loader or OCCT tessellation in the host — both end up as ordinary
Three.js geometry in the scene.

```typescript
interface ExportedMesh { data: string; binary: boolean }

async function exportModel(model: THREE.Object3D, format: CadFormat): Promise<ExportedMesh>
```

| `format` | Exporter | Result |
|----------|----------|--------|
| `"stl"` | `STLExporter` (`{ binary: true }`) | `DataView` → base64 |
| `"obj"` | `OBJExporter` | text (OBJ has no binary form) |
| `"ply"` | `PLYExporter` (`{ binary: false }`, callback-based — wrapped in a `Promise`) | text |
| `"gltf"` | `GLTFExporter.parseAsync(model, { binary: true })` | `ArrayBuffer` (`.glb`) → base64 |

```typescript
function arrayBufferToBase64(buf: ArrayBufferLike): string
```
Browser-side `btoa` counterpart to the `atob`-based decode in `geometryBuilder.ts`.

**Browser-only dependencies:** `GLTFExporter`'s binary path uses `FileReader`/`Blob`,
and `PLYExporter.parse()` uses `requestAnimationFrame` — neither exists in plain
Node, so they only run for real inside the webview. `meshExporters.test.ts`
polyfills `requestAnimationFrame` to unit-test the PLY path and skips the glTF binary
path entirely (covered by the manual F5 verification instead).

---

## `src/webview/treePanel.ts`

### `TreePanel`

Manages the `#tree-panel` DOM element. Renders a collapsible tree from `TreeNode` data.

```typescript
class TreePanel {
  constructor(container: HTMLElement)
  onSelect: ((id: string | null) => void) | null  // callback set by main.ts
}
```

**`render(root: TreeNode): void`** — Clears the panel, builds the DOM tree from `root`, and shows the panel. Each node is rendered as an `<li>` with a chevron button for expand/collapse and a label span. The root node is not rendered as a row (its children are the top level).

**`hide(): void`** — Hides and clears the panel container.

**`toggle(): void`** — Toggles panel visibility.

**Private `buildList(nodes, depth): HTMLUListElement`** — Recursively builds `<ul>/<li>` elements. Each leaf `<li>` has a `data-group-id` attribute matching `TreeNode.id`. Click handlers call `this.onSelect(id)`.

**`private updateSelection(): void`** — Adds/removes the `selected` CSS class from rows based on `this._selectedId`. Called after each click.

The `onSelect` callback is wired in `main.ts` to call `viewer.highlightGroup(id)`.

## `src/webview/editsModel.ts`

### `EditsModel`

The in-webview **op-stack** for the replayable edit list. Pure data (no DOM),
mirroring `PartsModel`. Owns both the applied list and a redo buffer; the host
stays dumb and just persists / re-tessellates whatever list this produces.

```typescript
class EditsModel {
  constructor(onChange: () => void)
  load(ops: EditOp[]): void   // hydrate from sidecar — does NOT fire onChange
  list(): EditOp[]            // deep copies, in order
  push(op: EditOp): void      // append; clears the redo buffer
  undo(): void                // pop last → redo buffer
  redo(): void                // re-apply most recently undone
  clear(): void               // empty both stacks
  get size(): number
  get canUndo(): boolean
  get canRedo(): boolean
}
```

Every mutation fires `onChange`, wired in `main.ts` to post `editsChanged`, render
the panel, and (for mesh files) rebuild the displayed model. `load` does **not**
fire — it is the initial sidecar load and must not echo back as a write.

## `src/webview/opCatalog.ts`

The **op catalog** — the single source of truth for the Edits panel's tab
structure. Pure and DOM-free (unit-tested in `opCatalog.test.ts`).

```typescript
type PanelOpId = "translate" | "booleanUnion" | ... | "buildVolume"  // one id per op BUTTON
interface CatalogEntry { id: PanelOpId; label: string; brepOnly: boolean; kinds: EditOpKind[] }
interface CatalogCategory { title: string; ops: CatalogEntry[] }
const OP_CATALOG: { geometry2d: CatalogCategory[]; geometry3d: CatalogCategory[]; edit: CatalogCategory[] }
function allCatalogEntries(): CatalogEntry[]
function describeOp(op: EditOp): string   // moved here from editsPanel.ts (re-exported there)
```

A `PanelOpId` is one op **button** — usually 1:1 with an `EditOpKind`, but the
three booleans are separate buttons over the single `boolean` op kind, and the
two Build buttons emit `addSurfaceFromLines`/`addVolumeFromSurfaces`. Each
entry's `kinds` lists the EditOp kind(s) the button can emit; `brepOnly` is
derived from `BREP_ONLY_OPS` over `kinds` and the agreement is locked by a test,
as are icon completeness (every id keyed in `OP_ICONS`) and full `EditOpKind`
reachability.

## `src/webview/opIcons.ts`

`OP_ICONS: Record<PanelOpId, string>` — the **one file to edit to swap in real
icons**. Each value renders as the text of the button's `<span class="op-icon">`;
the current values are placeholder unicode glyphs. The `Record` type makes a
missing icon a compile error.

## `src/webview/editsPanel.ts`

### `EditsPanel`

Manages the `#edits-panel` DOM: two top-level tabs — **GEOMETRY** (creation ops,
split into **2D**/**3D** subtabs) and **EDIT** (modification ops, one
categorized list) — each rendered from `OP_CATALOG` as grids of icon op-buttons
(`.op-grid`/`.op-btn`), a single shared parameter-form area (`#edits-params`)
under the grids, the Undo/Redo/Clear control row, and the ordered op-history
list with a one-line summary each (`describeOp`). Clicking an op button renders
its parameter form; clicking it again collapses it. There is only one op stack
regardless of which tab an op came from. VS Code webviews block `prompt()`, so
all input is via numeric fields.

```typescript
class EditsPanel {
  constructor(panel: HTMLElement, cb: EditsPanelCallbacks)
  render(ops: EditOp[], canUndo: boolean, canRedo: boolean): void
  setBRepOnly(enabled: boolean): void
}
```

**Callback-draft architecture:** each form's Apply handler builds a params-only
draft and hands it to a callback; `main.ts` merges the live selection (target
volumes, edges, faces) into it, applies a light client-side guard mirroring the
matching `validateEditOp` rule (with a human status message), and pushes the
`EditOp` into `EditsModel`. The callbacks:

- `onApplyTransform(TransformDraft)` — Move/Rotate/Scale/Mirror; targets = selected volumes.
- `onCaptureBooleanA()` / `onApplyBoolean(kind)` — the boolean two-step: **Set A**
  captures the selection (count echoed in the form; the panel mirrors it in
  `booleanACount` so it survives form re-renders), **Apply** uses the live
  selection as operand B. Three buttons (Unite/Subtract/Intersect) share one form.
- `onApplyFillet(kind, amount)` — selected edges (B-rep only).
- `onApplyFeature(FeatureDraft)` — Extrude/Revolve/Sweep/Loft from the selected
  profile face(s)/path edge (B-rep only).
- `onApplyModify(ModifyDraft)` — Shell (opening faces = selected surfaces; the
  host derives each face's owning solid), Split-by-plane and Section (targets =
  selected volumes). B-rep only.
- `onApplyExplode(factor)` / `onApplyMate()` — assembly ops.
- `onApplyPrimitive(PrimitiveDraft)` — Box/Sphere/Cylinder/Cone/Torus/Prism/Wedge;
  self-contained placement, **no selection needed**. All-formats except Wedge
  (B-rep only).
- `onApplyHole(HoleDraft)` — Hole/Counterbore/Countersink; subtractive, cut into
  the selected volumes (all formats — the mesh engine cuts via CSG).
- `onApplyProfile(ProfileDraft)` — Circle/Rectangle/Polygon/Ellipse/Rounded
  rect/Slot/Trapezoid sketches; no selection needed, B-rep only. The
  rectangle-family drafts carry an explicit `up: Vec3` so in-plane orientation is
  user-controlled. A sketch is created to be picked afterward (Surf mode) and fed
  into a feature op's `profile`.
- `onApplyWireframe(WireframeDraft)` — Point/Line/Arc plus the curve family
  (Polyline/3-Pt Arc/Spline/Bezier/Ellipse Arc/Helix); typed coordinates, B-rep
  only. Polyline/Spline/Bezier use the panel's **dynamic point-list widget**
  (`pointListField`): `.point-row`s of vec triples with per-row `−` remove
  buttons (disabled at the minimum count) and a trailing `+ Add point`;
  `readPoints()` walks rows in DOM order at emit time.
- `onBuildSurfaceFromLines()` / `onBuildVolumeFromSurfaces()` — the Build
  buttons; no capture step — `main.ts` reads the live Line/Surf selection at
  click time and guards the minimum count (≥3 lines, ≥4 faces).

**B-rep gating:** every `CatalogEntry.brepOnly` button is pushed into
`brepOnlyEls`, plus the whole **2D subtab** (every 2D op is B-rep-only — locked
by a catalog test) with a tooltip. `setBRepOnly(false)` also collapses an open
B-rep-only form and auto-switches an active 2D subtab to 3D. Elements are held
by reference, so the tab re-parenting is transparent to the mechanism.

## `src/webview/meshEdits.ts`

The webview edit engine for **mesh formats** (no OCCT in the host). Folds the op-list
over a pristine `THREE.Object3D` clone so ops replay cleanly on every change.

```typescript
function applyEditsMesh(root: THREE.Object3D, ops: EditOp[]): THREE.Object3D
function transformMatrixForOp(op: EditOp): THREE.Matrix4 | null   // pure, unit-tested
function resolveMeshTargets(root: THREE.Object3D, ids: string[]): THREE.Object3D[]
```

`transformMatrixForOp` builds the world-space matrix for translate/rotate/scale/
mirror (rotation/scale/mirror conjugated about their point via `T(p)·M·T(−p)`;
mirror is a Householder reflection). **Booleans** go through `applyMeshBoolean`,
which resolves operand A/B to their first mesh, evaluates a CSG via **`three-bvh-csg`**
(`Evaluator`/`Brush` with `ADDITION`/`SUBTRACTION`/`INTERSECTION`), and replaces both
operands in the tree with the single result mesh (tagged with A's node id).
Feature-modeling ops (`BREP_ONLY_OPS`) are skipped — meshes have no sketch/exact
topology. `main.ts` caches the pristine tagged object and calls `applyEditsMesh` on a
clone inside `rebuildMeshModel()`.

**Primitives** (`addBox`/`addSphere`/`addCylinder`/`addCone`/`addTorus`/`addPrism`)
go through `buildPrimitiveMesh(op)`, which constructs a fresh `THREE.BufferGeometry`
(`BoxGeometry`/`SphereGeometry`/`CylinderGeometry`/`TorusGeometry` — `CylinderGeometry
(radius, radius, height, sides)` doubles as the N-gon prism) and attaches it under
`root`. Because `applyEditsMesh` always folds over a **fresh clone** of the pristine
object (primitives never pre-exist in it), this construction happens on every replay
— tagged `userData.groupId = "prim-{K}"`, where `K` counts only `addX` ops seen so
far in that fold pass (reset per call), so ids are deterministic by op-list position
and never collide with the loaded file's `node-N` ids. `baseAlignedMatrix`/
`centerAlignedMatrix` rotate Three's canonical primitive orientation (cylinder/cone:
+Y-centred; torus: XY-plane ring, +Z normal — verified from the Three.js source) onto
the op's `axis` via `Quaternion.setFromUnitVectors`, then translate; get the
rotate-then-translate order wrong and non-canonical-axis primitives land off-centre
(regression-tested with a tilted-axis cylinder in `meshEdits.test.ts`).

**Holes** (`addHole`/`addCounterboreHole`/`addCountersinkHole`) go through
`applyMeshHole`, which subtracts a cylinder tool brush — plus a second wider
cylinder (counterbore) or cone (countersink) as a sequential second
`SUBTRACTION` — from the first mesh of the resolved targets, then replaces the
target with the result (tagged with the target's node id, mirroring
`applyMeshBoolean`). Tool placement reuses `baseAlignedMatrix` (mouth at
`position`, drilled along `axis`). **Dispatch-order invariant:** hole op names
start with `add`, so `applyEditsMesh` must handle them *before* the generic
`op.op.startsWith("add")` primitive branch, and they never increment the
`prim-{K}` counter (they don't create a body) — both locked by regression tests
in `meshEdits.test.ts`.

## `src/webview/meshingModel.ts`

### `MeshingModel`

The in-webview store for the current FE-mesh generation options. Pure data (no
DOM), mirroring `EditsModel`/`PartsModel`'s pattern but simpler: since options are
a single flat bag rather than a list, there is no undo/redo/redo-buffer — just a
current value that `update()` patches in place.

```typescript
class MeshingModel {
  constructor(onChange: () => void)
  load(options: MeshOptions): void        // hydrate from host — does NOT fire onChange
  get(): MeshOptions                       // a copy; mutating it does not affect internal state
  update(patch: Partial<MeshOptions>): void // merge + fire onChange
}
```

Every `update()` fires `onChange`, wired in `main.ts` to post `meshingChanged`
(persisting the sidecar host-side) and re-render the panel — clearing any stale
stats/error readout, since changing options doesn't itself produce a new result
until the next **Generate**. `load()` does **not** fire — it is the initial
host→webview hydration (from the sidecar or `DEFAULT_MESH_OPTIONS`) and must not
echo back as a write.

## `src/webview/meshingPanel.ts`

### `MeshingPanel`

Manages the `#meshing-panel` DOM, top to bottom: a large-mesh warning strip
(`#meshing-warning`, its icon from `TOOLBAR_ICONS.warning` — see
`doc/extension-host-api.md`'s `src/toolbarIcons.ts` section — set via
`innerHTML` since it's mixed with formatted text, not `textContent`); the
primary size control (Coarse/Medium/Fine preset
buttons, a coarser→finer log-scale slider driving `sizeMax`, and a
`Size: X · ~N elements` readout); a "Part sizes" section mirroring the Parts
panel's per-part `meshSize` inputs (hidden while no parts exist); a
collapsed-by-default "Advanced settings" section with the raw options form
(dimension, size min/max, 2D/3D algorithm dropdowns, element order, optimize
checkbox, STL angle) — plus a Generate button, an export-format `<select>`
(populated from `MESH_EXPORT_FORMATS` in `src/meshExportFormats.ts` — one
shared registry instead of one button per format) + Export button, a Clear
button, and a status line. Pure DOM, no business logic (size math delegates to
`meshSizeHeuristics.ts`), no `prompt()`/`alert()` (VS Code webviews block
those — same constraint as the Parts/Edits panels).

```typescript
interface ModelExtents { size: [number, number, number]; diagonal: number }
interface MeshingStats { nodeCount: number; elementCount: number; elapsedMs?: number }
interface MeshingError { error: string }

interface MeshingPanelCallbacks {
  onOptionsChange: (patch: Partial<MeshOptions>) => void
  onPartMeshSize: (index: number, size: number | undefined) => void  // undefined = inherit global
  onGenerate: () => void
  onExport: (format: MeshExportFormatId) => void  // the format currently picked in the `<select>`
  onClear: () => void
}

class MeshingPanel {
  constructor(panel: HTMLElement, cb: MeshingPanelCallbacks)
  render(options: MeshOptions, status?: MeshingStats | MeshingError): void
  renderParts(parts: Part[]): void
  setModelExtents(extents: ModelExtents | null): void
  setSourceKind(kind: "brep" | "mesh"): void
  setBusy(busy: boolean): void
}
```

`render()` syncs every form control to `options` (including the slider position
via `sizeToSlider`; a value outside the slider's range pegs the thumb at an end
while the readout keeps the true number) and updates the status line: blank when
`status` is omitted, `Nodes: N · Elements: M · 3.2 s` for a `MeshingStats`
(time from `elapsedMs`, omitted when absent), or the error string (with an
error CSS class) for a `MeshingError`. When `options.sizeMax` is still the
`SIZE_MAX_SENTINEL`, the Size max field shows an empty `auto` placeholder and
the slider is disabled — the raw `1e+22` is never displayed. The 2D/3D
algorithm dropdowns are populated from small curated, **not exhaustive**, lists
of well-known GMSH algorithm ids (`Mesh.Algorithm`/`Mesh.Algorithm3D`) — e.g.
Frontal-Delaunay (`6`) for 2D and Frontal (`4`, the default) for 3D — rather than
every id GMSH supports.

The slider commits on `change` (release) only; `input` (mid-drag) refreshes the
readout/warning locally so dragging never spams `meshingChanged`. Commits that
would drop `sizeMax` below the current `sizeMin` include `sizeMin: 0` in the
same patch (guarding `validateMeshOptions`' pair rule). `setModelExtents()` is
pushed by `main.ts` on each model load and feeds the readout's element-count
estimate and the presets; `setSourceKind("brep")` disables the STL angle field
(it only feeds the STL reclassification path), mirroring
`editsPanel.setBRepOnly`. `renderParts()` rebuilds the Part sizes rows —
`onPartMeshSize` routes to the same `PartsModel.setMeshSize` the Parts panel
uses, so the two inputs are views of one value.

`setBusy(true)` disables `#meshing-generate` (a slow WASM call can't be
re-triggered mid-flight) and shows the indeterminate `#meshing-progress` bar
(CSS keyframe sweep — GMSH's `generate()` is one opaque blocking call with no
progress hook to report a real percentage from) plus a `"Generating…"` status
line; `setBusy(false)` reverses both. `main.ts`'s `onGenerate` calls
`setBusy(true)` before posting `meshingGenerate`, and the `meshingResult`/
`meshingError` handlers call `setBusy(false)` before rendering the outcome.
Export (`onExport`) is not wired to `setBusy` — its
save-dialog-driven completion surfaces through the generic `status`/`error`
messages (`setStatus()`, the toolbar status bar), not this panel.

In `main.ts`, `onGenerate`/`onExport` each independently call an
async `currentStlIfMeshSource()` helper before posting (returns `undefined` for
B-rep documents, since the host re-exports STEP itself), then post
`meshingGenerate`/`meshingExport` with the current `MeshingModel.get()` snapshot
plus that optional `stl`. `onClear` calls `viewer.setMeshOverlay(null)` directly,
resets the toolbar toggle's `meshingEnabled`/`.active` state (same
toggle-truthfulness rule `meshingResult`/`meshingError` follow), and re-renders
the panel with no status.

---

## `src/webview/meshSizeHeuristics.ts`

The pure math behind the FE Mesh panel's primary size control. Plain numbers
in/out — vscode-free, THREE-free, and (critically) gmsh-free, so rendering the
panel can never trip the lazy-WASM-init invariant — and unit-tested headless
(`meshSizeHeuristics.test.ts`), like `cameraControls.ts`.

```typescript
const DEFAULT_SIZE_DIVISOR = 20   // default target size = bbox diagonal / 20
const COARSE_DIVISOR = 5          // slider t=0 → diagonal / 5 (coarsest)
const FINE_DIVISOR = 200          // slider t=1 → diagonal / 200 (finest)
const PRESET_DIVISORS = { coarse: 10, medium: 20, fine: 50 }
const LARGE_ELEMENT_COUNT = 1_000_000  // estimate above this → panel warning

function defaultTargetSize(diagonal: number): number
function sliderToSize(t: number, diagonal: number): number   // log interp, t clamped [0,1]
function sizeToSlider(size: number, diagonal: number): number // inverse, clamped [0,1]
function estimateElementCount(bboxSize: [number, number, number],
                              targetSize: number, dimension: 1 | 2 | 3): number
function formatCount(n: number): string  // "~850", "~12k", "~1.2M"
function formatSize(n: number): string   // 3 significant digits
```

`estimateElementCount` is an **order-of-magnitude heuristic computed from the
bounding box only** (3D ≈ 6 tets per h-cube of bbox volume; 2D ≈ 2 triangles per
h-square of bbox surface area; 1D ≈ segments along the diagonal) — it knowingly
overestimates non-boxy models and exists to power the readout and the large-mesh
warning, not to predict Gmsh's real output. The bbox comes from
`Viewer.getModelExtents()`, pushed into the panel by `main.ts` on each model load.
