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
| `src/webview/editsPanel.ts` | Edits panel DOM — transform composer + op list |
| `src/webview/meshEdits.ts` | Webview edit engine for mesh formats (Three.js transforms; unit-tested) |
| `src/webview/meshFacets.ts` | Segment a mesh into coplanar facets → per-face sub-meshes (unit-tested) |

---

## `src/webview/main.ts`

Entry point for the webview bundle. Not exported — all logic runs at module level.

**Startup sequence:**
1. Acquire VS Code API: `const vscode = acquireVsCodeApi()`.
2. Instantiate `Viewer(document.getElementById('canvas'))`.
3. Instantiate `TreePanel(document.getElementById('tree-panel'))`.
4. Call `setupViewControls(viewer)` (in a `try/catch` — a UI wiring failure must not block the ready handshake).
5. Wire toolbar buttons (`#fit`, `#wireframe`, `#grid`, `#export`, `#tree-toggle`). The `#export` button posts `{ type: "exportRequest" }` — it doesn't show any UI itself; the host owns the quick-pick and save dialog.
6. Register `window.addEventListener('message', ...)` for host messages.
7. Post `{ type: 'ready' }` to the host.

**Message handler (host → webview):**

| `type` | Action |
|--------|--------|
| `"geometry"` | `buildGroupFromEncoded(msg.meshes, msg.edges)` → `viewer.setModel(group)`, recolour, enable all pick modes |
| `"tree"` | `TreePanel.render(msg.root)` |
| `"loadUrl"` | `loadMeshFromUrl(msg.url, msg.format)` → `tagMeshEntities(obj)` → `splitMeshesIntoFacets(obj)` → `viewer.setModel(model)`, pick modes `volume` + `surface` |
| `"parts"` | `PartsModel.load(msg.parts)` → recolour model → `PartsPanel.render()` |
| `"status"` | Set `#status-text` content |
| `"error"` | Show `#error-overlay` with message |
| `"exportMesh"` | `exportModel(viewer.getModel(), msg.format)` → posts back `"exportResult"` (with `data`/`binary`) or `"exportError"` on failure, correlated by `msg.requestId` |

The webview also posts `{ type: "partsChanged", parts }` whenever the user edits
parts; the host debounces and writes the sidecar.

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
setModel(object: THREE.Object3D): void
```
Replaces the current model. Calls `clearModel()`, adds the new object to the scene, applies the current wireframe state to all meshes, calls `resetView()` to reframe.

```typescript
clearModel(): void
```
Removes the current model from the scene, disposes all geometries and materials (recursive), and resets the root reference.

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
function buildGroupFromEncoded(encodedMeshes: EncodedMesh[]): THREE.Group
```
Groups `encodedMeshes` by `groupId`. For each group, calls `mergeAndBuild()` to produce a `THREE.Mesh`. Sets `mesh.userData.groupId` so `Viewer.highlightGroup()` can identify it. Returns the root `THREE.Group`.

```typescript
function mergeAndBuild(meshes: { positions: Float32Array; indices: Uint32Array }[]): THREE.Mesh
```
Concatenates positions and remaps indices from multiple buffers into a single `THREE.BufferGeometry`. Calls `geometry.computeVertexNormals()`. Returns a `THREE.Mesh` via `meshFromGeometry()` (imported from `viewer.ts`).

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

## `src/webview/editsPanel.ts`

### `EditsPanel`

Manages the `#edits-panel` DOM: a **transform composer** (a `Move/Rotate/Scale/
Mirror` dropdown with numeric `<input>`s and an **Apply** button), an
Undo/Redo/Clear control row, and the ordered op list with a one-line summary each
(`describeOp`). VS Code webviews block `prompt()`, so all input is via numeric
fields.

```typescript
class EditsPanel {
  constructor(panel: HTMLElement, cb: EditsPanelCallbacks)
  render(ops: EditOp[], canUndo: boolean, canRedo: boolean): void
}
```

`onApplyTransform(draft: TransformDraft)` hands a transform op **without targets**
to `main.ts`, which injects the selected volume ids before pushing it to the
`EditsModel`. The boolean composer uses `onCaptureBooleanA()` (captures the current
selection as operand A, returns its size for display) and `onApplyBoolean(kind)`
(applies captured-A against the live selection as operand B). The fillet/chamfer
composer uses `onApplyFillet(kind, amount)` (applies to the selected edges) and the
feature composer uses `onApplyFeature(draft)` (extrude/revolve/sweep/loft from the
selected profile face(s)/path edge); both are **B-rep-only** sections that
`setBRepOnly(enabled)` disables for mesh sources. The assembly composer uses
`onApplyExplode(factor)` (all formats) and `onApplyMate()` (aligns the two selected
faces, B-rep only). The **primitive composer** uses `onApplyPrimitive(draft:
PrimitiveDraft)` — the only op-creation callback that needs **no selection at all**;
`draft` already carries every parameter (`center`/`axis`/dimensions), so `main.ts`
just validates positivity and pushes the op straight through. This composer is
deliberately never registered in `brepOnlyEls`, since primitives work on both
engines.

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
