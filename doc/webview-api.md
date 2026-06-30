# Webview API

The webview runs in a Chromium browser context. These modules are bundled into `media/viewer.js` (IIFE) and have no access to Node.js APIs.

## Module Index

| Module | Responsibility |
|--------|---------------|
| `src/webview/main.ts` | Entry point, VS Code API, message routing, UI wiring |
| `src/webview/viewer.ts` | Three.js scene, camera, rendering, gizmo |
| `src/webview/cameraControls.ts` | Pure camera math utilities (unit-testable) |
| `src/webview/orientationCube.ts` | Orientation gizmo (no own renderer) |
| `src/webview/geometryBuilder.ts` | Decode and build Three.js geometry from encoded buffers |
| `src/webview/meshLoaders.ts` | Dispatch to Three.js loaders by format |
| `src/webview/meshExporters.ts` | Dispatch to Three.js exporters by format |
| `src/webview/treePanel.ts` | Component tree panel DOM management |

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
| `"geometry"` | `buildGroupFromEncoded(msg.meshes)` → `viewer.setModel(group)` + `TreePanel.render(root)` |
| `"tree"` | `TreePanel.render(msg.root)` |
| `"loadUrl"` | `loadMeshFromUrl(msg.url, msg.format)` → `tagGroupIds(obj)` → `viewer.setModel(obj)` + `TreePanel.render(extractObjectTree(obj, label))` |
| `"status"` | Set `#status-text` content |
| `"error"` | Show `#error-overlay` with message |
| `"exportMesh"` | `exportModel(viewer.getModel(), msg.format)` → posts back `"exportResult"` (with `data`/`binary`) or `"exportError"` on failure, correlated by `msg.requestId` |

**Helper functions:**

```typescript
function tagGroupIds(obj: THREE.Object3D): void
```
Recursively assigns `userData.groupId = obj.uuid` to every `THREE.Mesh` in the hierarchy. This enables `viewer.highlightGroup()` to identify meshes by group.

```typescript
function extractObjectTree(obj: THREE.Object3D, rootLabel: string): TreeNode
```
Builds a `TreeNode` hierarchy from a Three.js `Object3D` tree. Uses `obj.name` (or a fallback label) for `label`; `obj.uuid` for `id`.

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
