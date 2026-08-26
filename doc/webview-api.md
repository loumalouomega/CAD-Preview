# Webview API

The webview runs in a Chromium browser context. These modules are bundled into `media/viewer.js` (IIFE) and have no access to Node.js APIs.

## Module Index

| Module | Responsibility |
| --- | --- |
| `src/webview/main.ts` | Entry point, VS Code API, message routing, UI wiring |
| `src/webview/dropdownMenu.ts` | Shared open/close/outside-click/Escape plumbing for the File ▾ and toolbar dropdown menus |
| `src/webview/viewer.ts` | Three.js scene, camera, rendering, orientation + transform gizmos |
| `src/webview/cameraControls.ts` | Pure camera math utilities (unit-testable) |
| `src/webview/viewerPanes.ts` | Pure split-view pane-layout math: pane rects, pointer→pane mapping, pane-relative NDC, GL-viewport conversion (unit-tested) |
| `src/webview/gizmoTransform.ts` | Pure per-target delta math (translate/rotate-about-pivot/scale-about-pivot, axis-angle decomposition, grid/point snapping) for the Transform Gizmo (unit-tested) |
| `src/webview/orientationCube.ts` | Orientation gizmo (no own renderer) |
| `src/webview/geometryBuilder.ts` | Decode and build per-face meshes + per-edge lines from encoded buffers |
| `src/webview/meshLoaders.ts` | Dispatch to Three.js loaders by format |
| `src/webview/meshExporters.ts` | Dispatch to Three.js exporters by format |
| `src/webview/treePanel.ts` | Component tree panel DOM management |
| `src/webview/picking.ts` | Resolve a raycast hit + selection mode to an entity, plus mode-unfiltered measurement picking (unit-testable). Both collectors walk with `traverseVisible`, not `traverse` — **load-bearing**: three's `Raycaster` tests only `layers` and ignores `.visible` entirely, so plain traversal would let clicks (and measurements, and `collectSnapPoints()`'s gizmo-drag snap candidates) land on geometry the user explicitly hid — a Part hidden by its eye-toggle, anything outside an active Isolate, or the model's faces under an FE-mesh/colour-field overlay. `traverseVisible` prunes such a subtree at the invisible ancestor, exactly the unit of hiding in all four cases. |
| `src/webview/selection.ts` | Transient (not-yet-assigned) entity selection set |
| `src/webview/measurement.ts` | Pure distance/length/angle/radius math over plain tuples (unit-tested) |
| `src/webview/measurementState.ts` | 0–2-pick buffer for the in-progress measurement, DOM-free (unit-tested) |
| `src/webview/measurementOverlay.ts` | Lazily-built marker/dimension-glyph/label Three.js objects for the measurement overlay |
| `src/webview/dimensionGlyph.ts` | Pure dimension-glyph math — arrowheads, witness/extension lines, value formatting (shared with the SVG/DXF export path) |
| `src/webview/annotationsModel.ts` | Persisted, topology-anchored annotations (pinned measurements) data model, DOM-free (unit-tested) |
| `src/webview/massPropertiesPanel.ts` | Mass Properties panel DOM — label/value readout, error/status messages |
| `src/webview/meshHealthPanel.ts` | Mesh Health panel DOM (roadmap "Mesh → B-rep promotion, diagnostic-first", Phase 1 — read-only report, no promotion) |
| `src/webview/units.ts` | Display-unit conversion for Mass Properties/Measurement (mm/cm/m/in/ft), presentation-layer only (vscode/DOM-free, unit-tested) |
| `src/webview/meshMassProperties.ts` | Client-side volume/area/centroid for mesh sources (Three.js triangle math, unit-tested) |
| `src/webview/partsModel.ts` | Parts data model + operations, colour resolution (unit-testable) |
| `src/webview/partsPanel.ts` | Editable Parts panel DOM management |
| `src/webview/standardPartsPanel.ts` | Standard Parts (step.parts) search/insert panel DOM management, no dedicated data model — request/response state is tracked directly in `main.ts` |
| `src/webview/editsModel.ts` | Edit op-stack (push/undo/redo/clear + redo buffer), DOM-free (unit-tested) |
| `src/webview/variablesModel.ts` | Parametric variables store (add/rename/setExpr/remove), DOM-free (unit-tested) |
| `src/webview/variablesPanel.ts` | Variables table DOM inside the Edits panel (inline name/expr inputs, computed values) |
| `src/webview/opCatalog.ts` | Op catalog: GEOMETRY/EDIT tab structure + `describeOp`, DOM-free (unit-tested) |
| `src/webview/opIcons.ts` | Generated per-op SVG icons (`icons/build-op-icons.mjs`) |
| `src/webview/editsPanel.ts` | Edits panel DOM — GEOMETRY (2D/3D) / EDIT tabs, op grids, param forms, op list |
| `src/webview/meshEdits.ts` | Webview edit engine for mesh formats (Three.js transforms; unit-tested) |
| `src/webview/meshFacets.ts` | Segment a mesh into coplanar facets → per-face sub-meshes (unit-tested) |
| `src/webview/meshingModel.ts` | Current FE-mesh `MeshOptions` store, DOM-free (unit-tested) |
| `src/webview/meshingPanel.ts` | FE Mesh panel DOM — size slider/presets, part sizes, Advanced settings, Generate/Export/Clear, quality histogram |
| `src/webview/meshSizeHeuristics.ts` | Pure size-slider math: bbox default, log mapping, element-count estimate (unit-tested) |
| `src/webview/visibilityState.ts` | Transient Parts hide/isolate + Tree per-node hide state, DOM-free (unit-tested) |
| `src/webview/treeFilter.ts` | Pure Components-tree label-substring filter + ancestor inclusion (unit-tested) |
| `src/webview/explodePreview.ts` | Live exploded-view preview math (capture/apply/reset base positions), DOM-free but THREE-typed (unit-tested) |
| `src/webview/clipping.ts` | Pure clip-plane-from-bounding-box math (unit-tested) |
| `src/webview/clipCap.ts` | Stencil-buffer solid cap over a clip plane's cross-section (not unit-tested — THREE-mesh-building code) |

---

## `src/webview/main.ts`

Entry point for the webview bundle. Not exported — all logic runs at module level.

**Startup sequence:**

1. Acquire VS Code API: `const vscode = acquireVsCodeApi()`.
2. Instantiate `Viewer(document.getElementById('canvas'))`.
3. Instantiate `TreePanel(document.getElementById('tree-panel'))`, `PartsPanel`, `EditsPanel`, `MeshingPanel(document.getElementById('meshing-panel'), ...)`, `MassPropertiesPanel(document.getElementById('mass-panel'), ...)`, and `MeshHealthPanel(document.getElementById('mesh-health-panel'), ...)`.
4. Call `setupViewControls(viewer)`, `setupViewMenu()`, `setupSelectionControls()`, `setupMeasureControls()`, `setupFileMenu()`, `setupDragAndDrop()`, `setupAppearanceControls()`, `setupClippingControls()`, `setupMarkupControls()` (in a shared `try/catch` — a UI wiring failure must not block the ready handshake).
5. Wire toolbar buttons. Only `#fit`, `#tree-toggle`, and `#meshing-toggle` sit directly on the strip; everything else lives inside one of four dropdown panels (`#view-dropdown`, `#select-dropdown`, `#measure-dropdown`, `#markup-dropdown`) wired by `dropdownMenu.ts` (see below). `#screenshot` (in **View ▾**) posts `{ type: "screenshotButtonClicked" }` — it shows no UI itself, the host owns the save dialog. `#meshing-toggle` (in its own `try/catch`, same rule as the view controls) only shows/clears the FE-mesh overlay — the panel itself is always visible. The measure mode toggle / `.measure-tool-btn` row / Clear drive `viewer.setMeasureMode()`/`MeasurementState` (see below) — entirely webview-side, no message posted, **except** the `#measure-exact-btn` (⟟ Exact) that appears next to a completed distance/edge-length/radius result, which round-trips a `measureExactRequest` to the host for a true B-rep-precision value (see below), and `#measure-pin-btn` (📌 Pin), which posts `annotationsChanged` to persist the result (see `annotationsModel.ts` below). `#grid`, `#edges`, and `#hide-smooth-edges` are `menuitemcheckbox`es whose `aria-checked` reflects `viewer.toggleGrid()`'s return value and `setupAppearanceControls()`'s `edgesVisible`/`smoothEdgesShown` flags respectively, purely session-side. There is no standalone `#wireframe` toolbar button — Wireframe is one of five mutually exclusive **Display mode** states (`#display-mode-group` in the view-controls Appearance area, `setupAppearanceControls()`) driving `viewer.setDisplayMode()`; see below.
6. Register `window.addEventListener('message', ...)` for host messages.
7. Post `{ type: 'ready' }` to the host.

**Additional setup functions** (same guarded-`try` bank as step 4 above):

- `setupDragAndDrop()` — `dragover`/`drop` on `#app`; posts `{type:"openPath", path}` when the dropped `File` exposes a real fs path, else falls back to `{type:"openFile"}`.
- `setupViewMenu()` — wires the toolbar's **View ▾** dropdown: `#grid` (calling `viewer.toggleGrid()` and reflecting its returned visibility into the item's `aria-checked` tick — the initial state comes from the `cadPreview.showGridAndAxesOnOpen` setting via `applyDefaults()`, so it can't be assumed on) and dismissing the menu after the one-shot `#screenshot` action.
- `setupAppearanceControls()` — wires `#edges`/`#hide-smooth-edges` (View ▾ menu), `#vc-background`/`#vc-opacity`/`#vc-ortho` (`#view-controls`' "Appearance" group) to `viewer.setEdgesVisible`/`setSmoothEdgesVisible`/`setBackground`/`setOpacity`/`setOrthographic`, and `#vc-unit` to `setDisplayUnit()` (`src/webview/units.ts` — see below); also wires the Display mode button group to `viewer.setDisplayMode()` + `refreshColors()`. Returns an `AppearanceControlsHandle { applyOrtho(enabled), applyDisplayMode(mode) }` — the SAME functions the click handlers call, reused by `applyInitialViewIfNeeded()`/`applyViewState()` (below) to restore persisted ortho/display-mode state through one code path instead of two that could drift. Ortho and display mode are persisted (`ViewState`, roadmap "View-state persistence", closed); Edges/hide-smooth-edges/background/opacity/units stay session-only.
- `setupClippingControls()` — wires `#view-controls`' "Clip" group (`.clip-axis` buttons, `#clip-offset` slider, `#clip-toggle`) to `viewer.setClippingPlane()`, computing a `THREE.Plane` via `clipping.ts`'s `planeForAxis()` from `viewer.getModel()`'s current bounding box on every change. Returns a `ClippingControlsHandle { applyState(clip), getState() }` (`clip: {axis, offsetFrac} | null`) so persisted view state can restore the clip plane and the view-state save can read its current settings — `clipAxis`/`clipEnabled`/the offset slider's value are this function's own closure state, with no other way to read them from outside.

**Message handler (host → webview):**

| `type` | Action |
| --- | --- |
| `"geometry"` | `buildGroupFromEncoded(msg.meshes, msg.edges, msg.points)` → `viewer.setModel(group)`, recolour, enable all pick modes (`volume`/`surface`/`line`/`point`), `MeshingPanel.setSourceKind("brep")`/`setModelExtents(...)` + `syncMeshSizeSeed()` + `applyInitialViewIfNeeded()` (below) |
| `"tree"` | `TreePanel.render(msg.root)` |
| `"loadUrl"` | `loadMeshObjectFromUrl(msg.url, msg.format, msg.format.toUpperCase())` — see below |
| `"loadMeshBytes"` | base64-decode → `Blob` → `blob:` object URL (`URL.createObjectURL`) → decode `msg.regionAssignment` (if present, base64 `Int32Array` → `regionInfo`) → `loadMeshObjectFromUrl(blobUrl, "stl", msg.sourceFormat.toUpperCase(), regionInfo)`, then `URL.revokeObjectURL(blobUrl)`. A meshio++-imported document (`doc/file-formats.md`'s "meshio++ Bridge Formats") — always loaded via the STL loader regardless of the true source format, which only picks the Components tree root's label. `regionInfo` seeds a module-level `importedRegionInfo`, fed into `splitMeshesIntoFacets` **only while the edit-op list is empty** (see `rebuildMeshModel` below) so the webview's own facet split reproduces the same `node-0/face-K` ids the host may have auto-created Parts against. `applyAvailableColorFields(msg.meshioMetadata)` populates (and shows/hides) the "Colour by field" `<select>` from `pointDataNames`/`cellDataNames`. When `msg.meshioMetadata` is present, it's also shown as a `setStatus()` line AFTER the load succeeds, deliberately outside the try/finally that owns the blob URL, so it can't race with `loadMeshObjectFromUrl`'s own status sequence — a region that correlated (has `regionAssignment`) is worded "(see Parts)", uncorrelated regions "not imported as Parts/geometry", point/cell data names `(see "Colour by field")`, and `fieldDataNames` (whole-mesh, not spatially varying — nothing to colour by) "not imported". |
| `"parts"` | `PartsModel.load(msg.parts)` → recolour model → `PartsPanel.render()` + `MeshingPanel.renderParts()` |
| `"annotations"` | `AnnotationsModel.load(msg.annotations)` (silent) → `renderAnnotationsList()` (rebuilds the Saved list under Measure ▾, recomputing each row's "detached" status via `viewer.hasEntity()`) |
| `"edits"` | `EditsModel.load(msg.ops)` → (mesh sources) `rebuildMeshModel()` → `EditsPanel.render()` |
| `"status"` | Set `#status-text` content |
| `"error"` | Show `#error-overlay` with message |
| `"editError"` | Show `#error-overlay` with message (same rendering as `"error"`, distinct only by intent) |
| `"exportMesh"` | `exportModel(viewer.getModel(), msg.format)` → posts back `"exportResult"` (with `data`/`binary`) or `"exportError"` on failure, correlated by `msg.requestId` |
| `"meshingOptions"` | `MeshingModel.load(msg.options)` (hydration only) → `syncMeshSizeSeed()` → `MeshingPanel.render()` |
| `"viewState"` | Stores `msg.view` (`ViewState \| null`) as `pendingViewState`. Applies it (or the default isometric, if `null`) once geometry has ALSO arrived, via `applyInitialViewIfNeeded()` — a no-op after the document's first load. A LATER `"viewState"` (an external `.view.json` change reconciled by the host) applies immediately instead, via the shared `applyViewState()` helper |
| `"meshingResult"` | `viewer.setMeshOverlay(buildFEMesh(msg.positions, msg.indices, msg.edges, msg.elementGroups))`; if `msg.worstElements` is present, `viewer.setWorstElementsOverlay(buildWorstElementsHighlight(msg.positions, msg.worstElements.indices))` and auto-show it (else clear it) → `MeshingPanel.render(..., { nodeCount, elementCount, elapsedMs, quality: msg.quality, worstElements: msg.worstElements })` |
| `"meshingError"` | `MeshingPanel.render(..., { error: msg.message })` |
| `"viewerDefaults"` | `viewer.applyDefaults(msg)` (background/grid-axes apply immediately; up-axis stored for the next `setModel()`) → `meshSizePreset` feeds `syncMeshSizeSeed()`. Order-independent relative to `"geometry"`/`"loadUrl"` — arrives in the `ready` handshake alongside `"parts"`/`"meshingOptions"` |
| `"screenshotRequest"` | `viewer.render()` (force a fresh frame) → `viewer.captureScreenshotBase64()` → posts back `"screenshotResult"`/`"screenshotError"`, correlated by `msg.requestId` |
| `"massPropertiesResult"` | `renderMassProperties(msg.properties)` — caches the raw (mm) result and renders it converted to `currentDisplayUnit` (see `src/webview/units.ts` below); ignored if `msg.requestId` doesn't match the latest request |
| `"massPropertiesError"` | `MassPropertiesPanel.renderMessage(msg.message, true)` (same stale-request guard) |
| `"colorFieldResult"` | `viewer.setColorFieldOverlay(buildColorFieldOverlay(pristineMeshPositions(), msg.values, msg.min, msg.max))`, then updates the legend (`#vc-colorfield-gradient`'s CSS background from `viridisCssGradientStops()`, `#vc-colorfield-min`/`-max` via the plain `formatMeasure` — no length-unit suffix, a scalar field isn't length-dimensioned) and unhides it; ignored if `msg.requestId` doesn't match the latest selection (`colorFieldRequestId`) |
| `"colorFieldError"` | `setStatus(msg.message, true)` + resets the `<select>` to `""`, same stale-request guard |

The webview also posts `{ type: "partsChanged", parts }` whenever the user edits parts, `{ type: "annotationsChanged", annotations }` whenever the user pins/renames/deletes an annotation, `{ type: "editsChanged", ops }` whenever the op-stack mutates, `{ type: "meshingChanged", options }` whenever a mesh-option control changes, and `{ type: "viewChanged", view }` whenever the user changes the view (camera orbit/pan/zoom/fit/reset/gizmo, ortho toggle, display mode, or the clip controls); the host debounces each independently and writes the matching sidecar(s). See `meshingModel.ts`/`meshingPanel.ts` below for the FE-mesh wiring, including `currentStlIfMeshSource()` — the helper that snapshots the displayed model to base64 STL (via `meshExporters.ts`'s `exportModel`) for `meshingGenerate`/ `meshingExport` on mesh-format documents, since the host has no B-rep to re-export for those.

**View-state persistence (roadmap "View-state persistence", closed).** `applyViewState(state: ViewState): void` is the one place that applies a full `ViewState` to the viewer + Appearance/Clip controls (`viewer.setCameraUp` → `AppearanceControlsHandle.applyOrtho`/`applyDisplayMode` → `viewer.frameFromDirection` → `ClippingControlsHandle.applyState`), shared by initial restoration and by a post-initial external-change reconciliation of `.view.json`. `applyInitialViewIfNeeded(): void` applies it (or `viewer.resetView()` if no persisted state exists) exactly once — gated on `pendingViewState !== undefined` (the `"viewState"` message has arrived) AND `viewer.getModel() !== null` (geometry has arrived) — mirroring `syncMeshSizeSeed()`'s "whichever lands last performs the actual application" idiom, since the two have no deterministic arrival order. It's called from the `"geometry"` handler, `rebuildMeshModel()` (covers both the first mesh load and every mesh edit), and the `"viewState"` handler itself; every call after the first is a no-op via a module-level `hasAppliedInitialView` flag, set only AFTER the initial framing completes — `frameFromDirection`/`resetView`/`applyOrtho`/`applyState` all end in `controls.update()`, which synchronously fires `viewer.onViewChanged()`'s callback, so setting the flag afterward (not before) is what keeps merely OPENING a file from immediately creating a `.view.json` it never had. `scheduleViewSave(): void` (debounced ~500 ms) gathers the current state (`viewer.getViewDirection()`/`getCameraUp()`/`isOrthographic()`/`getDisplayMode()` + `ClippingControlsHandle.getState()`) and posts `viewChanged`; it's wired to `viewer.onViewChanged()` plus the ortho/display-mode/clip control click handlers, and no-ops while `hasAppliedInitialView` is still `false`. Deliberately excludes explode-preview state (session-only by design; the committed `explode` op already persists via `.edits.json`).

**`loadMeshObjectFromUrl(url, loaderFormat, treeLabel, regionInfo = null)`** — the shared load path both `"loadUrl"` and `"loadMeshBytes"` funnel through (extracted once `"loadMeshBytes"` needed the exact same post-load sequence from a different URL source): sets the module-level `importedRegionInfo = regionInfo` → `loadMeshFromUrl(url, loaderFormat)` → `tagMeshEntities(obj)` → `extractObjectTree(obj, treeLabel)` (builds the Components tree from the pristine hierarchy, before facet-splitting) → caches `obj` as `pristineMesh` → `rebuildMeshModel()` (applies current edits, facet-splits, `viewer.setModel`) → pick modes `volume`+`surface` → `sourceKind = "mesh"` → `MeshingPanel.setSourceKind("mesh")`/`setModelExtents(...)` + `syncMeshSizeSeed()` → `showTree(root)` if there's more than one node. Also resets the display-unit selector to `"mm"` (`setDisplayUnit("mm")`) and clears any cached raw Mass Properties result, since mesh sources (native or meshio-imported) carry no unit metadata and a stale result would refer to the just-replaced model. `loaderFormat` is always `"stl"` for a `"loadMeshBytes"` call regardless of the document's true source format — only `treeLabel` reflects that (e.g. `"VTK"` for a `.vtk` import, shown as the tree root's label, exactly as `"STL"`/`"OBJ"`/etc. already are for native mesh opens). `regionInfo` is only ever non-null from `"loadMeshBytes"`; `"loadUrl"` always passes the default `null` so a prior meshio import's region data can't leak into an unrelated native file opened later in the same session.

**`rebuildMeshModel()`** — clones `pristineMesh`, applies the current resolved edit-op list via `applyEditsMesh`, then calls `splitMeshesIntoFacets(edited, triangleRegion)` where `triangleRegion` is `importedRegionInfo.triangleRegion` **only when the edit-op list is currently empty**, else `undefined`. The gate exists because `importedRegionInfo` indexes `pristineMesh`'s ORIGINAL triangle order, which a topology-changing mesh edit (boolean/hole/primitive-add) invalidates — reapplying it to a since-edited geometry would silently misassign regions to unrelated triangles. Region-aware splitting resumes automatically once undo brings the op list back to empty, since `pristineMesh` itself is never mutated. See `src/meshFacets.ts`'s `segmentCoplanarFacets` for what "region-aware" changes (a purely restrictive additional merge constraint — every other caller, which omits the parameter, is unaffected). Also calls `resetColorFieldSelection()` — a colour-field view is invalidated by the same "correlated against the pristine triangle order" reasoning `importedRegionInfo` is, so ANY edit resets the "Colour by field" selector/legend/overlay, requiring the user to deliberately re-pick a field afterward rather than silently showing a now-mismatched overlay.

**Helper functions:**

```typescript
function tagMeshEntities(obj: THREE.Object3D): void
```

Assigns **stable** traversal-order ids (`node-N`, not `uuid`) as `userData.groupId` to every object, and additionally tags each `THREE.Mesh` as a pickable whole-object volume entity (`entityType: "surface"`, `entityId: node-N`). Stable ids let mesh-format part assignments round-trip across reopen; the shared id keeps `viewer.highlightGroup()` working for the component tree.

```typescript
function extractObjectTree(obj: THREE.Object3D, rootLabel: string): TreeNode
```

Builds a `TreeNode` hierarchy from a Three.js `Object3D` tree. Uses `obj.name` (or a fallback label) for `label`; the stable `userData.groupId` for `id`.

```typescript
function hasMultipleNodes(root: TreeNode): boolean
```

Returns `true` if the root has more than one child (or any grandchild). The tree panel is shown only when this is true.

---

## `src/webview/dropdownMenu.ts`

Shared plumbing for every dropdown in the webview: the **File ▾** menubar menu and the toolbar's **View ▾** / **Select ▾** / **Measure ▾** / **Markup ▾** menus. The markup contract is a `.tb-menu-wrap` (`position: relative`) containing a `.tb-menu` trigger button (`aria-haspopup`, `aria-expanded`) and a sibling `.tb-dropdown.hidden[role=menu]` panel.

```typescript
interface DropdownHandle {
  readonly trigger: HTMLElement;
  readonly panel: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

function setupDropdown(triggerId: string, panelId: string): DropdownHandle | null
function closeAllDropdowns(): void
```

- **Returns `null`, never throws**, when either element is missing — callers run inside `main.ts`'s shared setup `try` block, where a throw must not block the `ready` handshake.
- **Mutual exclusion**: `open()` closes every other registered handle first.
- **Two global listeners total**, registered lazily on the first `setupDropdown()` call regardless of how many menus exist: a capture-phase `pointerdown` on `window` that closes the open menu when the click landed outside every registered trigger *and* panel, and a `keydown` for `Escape`. The containment test is `trigger.contains(target) || panel.contains(target)` — an identity comparison against the trigger fails, because every trigger wraps its icon in a `<span class="toolbar-icon"><svg>` that becomes the event target.
- The dismissing `pointerdown` calls `preventDefault()` + `stopPropagation()`, so the click that closes a menu does not also reach whatever is underneath. This matters because `#markup-canvas` is `pointer-events: auto` while markup mode is on — without it, clicking away from the Markup menu would draw a stroke.
- **Clicks inside a panel deliberately leave it open** (toggling a mode, picking a tool, and choosing a colour are one visit). One-shot items — the `#menu-*` File actions and `#screenshot` — call `close()` themselves.

Module scope holds only a `Set<DropdownHandle>` and a `boolean`; all DOM access happens inside the exported functions, per this repo's no-DOM-at-import rule (vitest runs without jsdom).

---

## `src/webview/viewer.ts`

### `Viewer`

The main Three.js controller. Owns the scene, renderer, lights, controls, helpers, and gizmos.

```typescript
class Viewer {
  constructor(canvas: HTMLCanvasElement)
}
```

The constructor creates:

- `PerspectiveCamera` (FOV 45, near 0.001, far 10000) **and** a second `OrthographicCamera`, both kept alive the whole session — see `setOrthographic()` below for why there are two.
- `WebGLRenderer` with antialiasing and device pixel ratio
- `OrbitControls` with damping (factor 0.1), initially targeting the perspective camera
- Two lights: `AmbientLight(0xffffff, 0.6)` + `DirectionalLight(0xffffff, 0.8)`
- `GridHelper` and `AxesHelper` (hidden by default)
- `OrientationCube` instance
- **On-demand rendering** (roadmap "Render on demand, not every frame"): no unconditional `requestAnimationFrame` loop. `renderScheduler` (`src/webview/renderScheduler.ts` — pure, injectable timers) coalesces `requestRender()` calls into one scheduled frame; the `tick` callback drains `OrbitControls` damping and draws only when something actually changed. `onViewChanged` (all panes' `"change"`) and `TransformControls` `"change"` both drive `requestRender()`; `onResize`/`dispose()` schedule/cancel through it. `setModel(object, {autoFit})` gates its auto-reframe through `reframePolicy.shouldSkipAutoReframe` (padded sphere containment: `dist + r ≤ R`) — `autoFit: false` (a genuine file load) always reframes, edit-driven rebuilds skip when contained so the camera stops twitching; `framePane` records the padded sphere (`rawRadius * 1.5`) for the next check.

#### Split view (roadmap "Split view", Phases 1+2)

The viewer supports four pane layouts — `"1x1"` (default), `"1x2"` (two side-by-side columns), `"2x1"` (two stacked rows), and `"2x2"` (quad) — over the **single** scene, renderer, and canvas: panes are `setViewport`/`setScissor` regions, never separate WebGL contexts. Each pane owns its own camera pair (perspective + orthographic — projection is per-pane) and its own `OrbitControls`; only camera state (direction/up/ortho) is per-pane — model, overlays, selection, clip plane, and display mode stay global.

```typescript
getPaneLayout(): PaneLayoutId
setPaneLayout(layout: PaneLayoutId): void
setFocusedPane(index: number): void
onFocusChanged(callback: (index: number) => void): void
getPaneViewStates(): PaneViewState[]
applyPaneCameraState(index: number, state: PaneViewState): void
```

- `PaneLayoutId = "1x1" | "1x2" | "2x1" | "2x2"` — see `src/webview/viewerPanes.ts` for the pure, unit-tested layout math.
- `setPaneLayout` creates/disposes panes: the **focused** pane's state survives in both directions — collapsing keeps exactly what the user was looking at; expanding seeds every new pane with a copy of the focused view (all panes start identical, then orbit independently).
- `getPaneViewStates` / `applyPaneCameraState` are the per-pane persistence primitives `main.ts`'s `scheduleViewSave`/`applyViewState` use for `.view.json` — one `PaneViewState` (direction/up/ortho) per pane, row-major.
- **Every no-argument camera API** (`fitView`/`resetView`/`rotateView`/`panView`/`zoomView`/`setViewDirection`/`setOrthographic`/`getViewDirection`/`getCameraUp`/`isOrthographic`/`setCameraUp`/`frameFromDirection`) targets the **focused pane**, so all pre-existing call sites keep their exact semantics.
- Focus moves on a `pointerdown` inside another pane (the capture-phase gate listener, which also enables only that pane's `OrbitControls` so N instances never fight over one drag); `onFocusChanged` lets `main.ts` re-sync UI that mirrors focused-pane state (the Persp/Ortho button label).
- An edit-driven model rebuild (`setModel`) re-frames **every** pane along its own current direction.
- The orientation cube renders into (and is clickable within) the focused pane's corner only; the transform gizmo retargets `TransformControls.camera` and its `viewport` (a native three.js property for sub-viewport pointer math, verified against the installed source) to the focused pane.
- A fresh `Viewer` always starts at `"1x1"` — this is what keeps the headless render harness (`renderService.ts`, which posts no layout message) rendering one full-canvas view.
- The View ▾ **layout picker** (`#layout-group`, four icon buttons `1×1`/`1×2`/`2×1`/`2×2`) replaces the Phase 1 checkbox; `reflectLayoutPicker(layout)` mirrors the current layout, and `setPaneDividersForLayout(layout)` shows the vertical divider for `1×2`/`2×2` and the horizontal one for `2×1`/`2×2`. A layout change calls `scheduleViewSave` so it persists (Phase 2: `layout` + per-pane `panes` as siblings of `view` in `<model>.view.json`, tolerant-parse — see [File Formats](./file-formats.md)).
- OrbitControls has no viewport awareness (its drag sensitivity divides by the full canvas height), so per-pane `rotateSpeed`/`panSpeed` are compensated by `canvasHeight / paneHeight` — exact for `1×1`/`2×2` and for rotation + perspective pan in the `1×2` variants (both divide by `clientHeight`). Stops being exact for **orthographic pan** in non-square pane layouts (ortho's horizontal pan divides by `clientWidth` while the factor only corrects for height: `1×2` leaves ortho horizontal pan ~2× slow; `2×1` leaves it ~2× fast). One `panSpeed` scalar cannot express per-axis factors — the height-based factor stays the best single compromise.
- Interaction with the transform gizmo inside a split view (drag begun in the focused pane) is the one piece verified against the installed three.js source but **not** by an automated probe — see CLAUDE.md's "Verify a change" for the manual F5 steps.
- **Linked cameras (Phase 3):** one View ▾ checkbox `#link-cameras` (`role="menuitemcheckbox"`, `aria-checked`) flips `setCamerasLinked`; `linkedCamera`/`camerasLinked` messages come from the host relay. Receiver applies via `setCameraUp`/`applyOrtho`/`frameFromDirection` from its own bbox; loop-suppressed via `applyingLinkedCamera` + `viewSaveTimer` clear, gated on `hasAppliedInitialView`.

**Model management:**

```typescript
getModel(): THREE.Object3D | null
```

Returns the currently displayed model, or `null` if none has loaded yet. Used by `main.ts`'s `"exportMesh"` handler to hand the model to `exportModel()`.

```typescript
getModelExtents(): { size: [number, number, number]; diagonal: number } | null
```

The current model's world-space bounding-box dimensions and diagonal, or `null` if no model is loaded (or its box is empty). Recomputed on demand with the same `Box3` math `frame()` uses, so it automatically tracks edit-driven model rebuilds. Feeds the FE Mesh panel's bbox-derived default size and element-count estimate (`meshSizeHeuristics.ts`) — display-only, never mutates geometry.

```typescript
setModel(object: THREE.Object3D, opts?: { autoFit?: boolean }): void
```

Replaces the current model. Calls `clearModel()`, adds the new object to the scene, applies the current display mode to all meshes (`applyDisplayMode()`, see below), then frames it: `fitAllPanes()` (preserving every pane's CURRENT view direction) on every call after the document's first — gated through `shouldSkipAutoReframe()` when `opts.autoFit !== false` (the edit path: the rebuild's new bounds are tested against the last padded fit sphere `R = rawRadius * 1.5`; when contained the reframe is skipped so the camera stops twitching on every small edit — roadmap "Render on demand"). `opts.autoFit === false` (a genuine file load / file swap, threaded from `provider.ts`'s `loadModel(!showProgress)` via `HostToWebview.geometry.autoFit` and `main.ts`'s `rebuildMeshModel({autoFit})`) always reframes; the very first call (`hasModelEverLoaded` `false`) still frames nothing at all — tracked via a private `hasModelEverLoaded` flag, `false` until this method's first invocation for the webview's session (a fresh webview page is created per open document tab, so this reliably distinguishes "genuine first load" from an edit-driven re-tessellation/mesh rebuild). On first load, the CALLER (`main.ts`'s `applyInitialViewIfNeeded`) is responsible for framing — either restoring a persisted `ViewState` or falling back to `resetView()`'s default isometric — once the `"viewState"` sidecar message has also arrived (roadmap "View-state persistence", closed; see CLAUDE.md). Before this feature, `setModel()` unconditionally called `resetView()` on EVERY call, resetting the camera on every single edit, not just on reopen — a bigger, more-repeated friction than the roadmap item's literal framing.

```typescript
clearModel(): void
```

Removes the current model from the scene, disposes all geometries and materials (recursive), and resets the root reference.

```typescript
applyDefaults(d: { background: string; showGridAndAxes: boolean; upAxis: 'y' | 'z' }): void
render(): void
captureScreenshotBase64(): string
```

`applyDefaults` handles the `"viewerDefaults"` message: sets `scene.background` and `grid`/`axes.visible` immediately (scene-level, independent of whether a model is loaded), and stores `upAxis` to apply at the *next* `setModel()` call — `setModel()` rotates the loaded model **root** (`object.rotation.x = -π/2` for `upAxis === "z"`), never `THREE.Object3D.DEFAULT_UP` (a static shared by every `Object3D` including the gizmo/helpers). `resetView()`'s isometric direction is defined in the camera's fixed Y-up world frame and is unaffected either way. `render()` forces an immediate `renderer.render()` call and `captureScreenshotBase64()` reads `renderer.domElement.toDataURL("image/png")` (minus the `data:` prefix) — together they back the `"screenshotRequest"` handler, avoiding a persistent `preserveDrawingBuffer: true` renderer flag.

```typescript
setMeshOverlay(obj: THREE.Object3D | null): void
```

Replaces the generated FE-mesh overlay (from `geometryBuilder.buildFEMesh()`). Disposes the previous overlay's geometries/materials and removes it from the scene — the overlay is a **sibling of `model`**, never one of its children, so toggling it off leaves the original geometry completely untouched. Pass `null` to just clear the overlay. `setModel()` calls `this.setMeshOverlay(null)` as its very first line: a previously-generated overlay was computed from the *old* geometry and must not linger looking valid over a newly-loaded model.

`setMeshOverlay()` also toggles the model's shaded faces via the private `refreshModelFacesVisibility()` helper: faces are hidden whenever the mesh overlay OR the colour-field overlay (below) exists and is visible, restored only once neither is. This was refactored from an earlier version that had `setMeshOverlay` unconditionally decide visibility itself (`setModelFacesVisible(this.meshOverlay === null)`) — that stopped composing correctly once a second, independent overlay (`colorFieldOverlay`) also wanted to hide the same faces, since either one's own set/clear/toggle would stomp on the other's state. Two opaque solids/overlays occupying the same space are illegible layered on top of each other; this is display-only (`Object3D.visible`), never touches geometry.

```typescript
setMeshOverlayVisible(visible: boolean): void
```

Shows/hides the *current* overlay in place (`Object3D.visible`) without disposing it, calling `refreshModelFacesVisibility()` the same way `setMeshOverlay` does. This is what the toolbar's FE Mesh toggle calls — switching it off then back on must redisplay the same generated mesh instantly, with no re-run of Generate needed. A no-op when `meshOverlay` is `null` (nothing generated yet). Distinct from `setMeshOverlay(null)`, which actually disposes the overlay and is reserved for a new model loading, the panel's Clear button, or a fresh Generate replacing it with a new one.

```typescript
setWorstElementsOverlay(obj: THREE.Object3D | null): void
setWorstElementsOverlayVisible(visible: boolean): void
```

Same dispose/replace and show/hide-in-place pair as `setMeshOverlay`/ `setMeshOverlayVisible` above, for the worst-quality-elements highlight overlay (from `geometryBuilder.buildWorstElementsHighlight()`) — but deliberately **independent** of `meshOverlay`'s own lifecycle: clearing/ replacing the FE-mesh overlay does NOT implicitly clear this one; `main.ts`'s wiring calls both explicitly at every site that needs to (a fresh `"meshingResult"`, the panel's Clear button), the same way it already keeps `meshingEnabled`'s toggle state in sync alongside `setMeshOverlay` rather than `Viewer` inferring it internally. `setModel()` does clear it unconditionally (alongside `setMeshOverlay(null)`) as part of the "a previous overlay was computed from the old geometry" rule above. Unlike the base FE-mesh overlay, this one does **not** toggle the model's face visibility — it's meant to be seen *through* whatever else is displayed (see `buildWorstElementsHighlight` below), so there's nothing to hide/restore.

```typescript
setColorFieldOverlay(obj: THREE.Object3D | null): void
```

The "colour by scalar field" overlay (roadmap item, closed) — same dispose/replace pattern as `setMeshOverlay`, built from `geometryBuilder.buildColorFieldOverlay()`. Pass `null` to clear it (picking "None" in the field selector, or `setModel()`'s own unconditional clear on every fresh model load/edit rebuild — a colour-field view is only ever meaningful for the exact pristine geometry its values were correlated against, so any model change invalidates it the same way `importedRegionInfo` is invalidated by an edit). Composes with `setMeshOverlay`/`setMeshOverlayVisible` via `refreshModelFacesVisibility()` (see above) rather than hiding/showing faces itself.

**Camera operations:**

```typescript
fitView(): void
```

Computes the bounding sphere of the model and repositions the camera to frame it while keeping the current view direction. Also adjusts `OrbitControls.target` to the sphere center and updates near/far clip planes.

```typescript
frameFromDirection(direction: THREE.Vector3): void
```

Frames the model along an arbitrary view direction — computes distance/target from the model's current bounding box, same math `fitView()`/`resetView()` use, but for a caller-supplied direction rather than the current or hardcoded-isometric one. Used by `main.ts`'s `applyInitialViewIfNeeded()` to restore a persisted `ViewState.viewDirection` on first load.

```typescript
resetView(): void
```

Resets the view direction to the default isometric `(1, 0.8, 1)` (normalized) — a thin wrapper around `frameFromDirection()`. Called by `main.ts`'s `applyInitialViewIfNeeded()` on a document's first load when no persisted `ViewState` exists (see `setModel()` above) — no longer called unconditionally by `setModel()` itself.

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

```typescript
isOrthographic(): boolean
```

Whether `activeCamera` is currently the orthographic camera — `this.activeCamera instanceof THREE.OrthographicCamera`. The single source of truth `main.ts`'s Persp/Ortho toggle and the view-state save/restore both read, rather than each maintaining their own boolean that could drift from the real camera in use.

```typescript
onViewChanged(callback: () => void): void
```

Registers a callback fired on every camera movement — `controls.addEventListener("change", callback)`. Covers orbit/pan/dolly (drag or the stepped toolbar buttons), `fitView`/`resetView`/`frameFromDirection`, `setViewDirection`/`setCameraUp`, and `setOrthographic`'s own re-frame, since every one of those ends in `controls.update()`, which `OrbitControls` only actually dispatches `"change"` for when the camera genuinely moved. `main.ts`'s view-state autosave (roadmap "View-state persistence", closed) is the one caller; it gates on its own `hasAppliedInitialView` flag so a document's initial framing (restored or default-isometric) doesn't itself trigger a save — see the protocol reference's [`viewChanged`](./protocol.md#viewchanged) entry.

```typescript
setOrthographic(enabled: boolean): void
```

Toggles between perspective and orthographic projection. **Not a reconstruction** — swaps which of the two camera objects created in the constructor is `activeCamera` (and `controls.object`; three.js's `OrbitControls` supports retargeting at runtime, and its own dolly/zoom logic already branches on `camera.isPerspectiveCamera`/`isOrthographicCamera`, so mouse-wheel zoom keeps working correctly across the swap with no extra code). Copies position/near/far from the outgoing camera so the view doesn't jump, then calls the private `frame()` along the same view direction to size the newly-active camera correctly — `frame()` already branches per camera type (fov-based distance for perspective; frustum `left/right/top/bottom`/`zoom` for orthographic, `this.orthoHalfHeight` tracking the last-framed half-height so `onResize` can recompute the frustum for a new aspect ratio without a full reframe). `cameraControls.ts`'s `pan`/`dolly` (the two FOV/zoom-dependent functions) also branch per camera type — see that module's section below. `rotateView`/`panView`/`zoomView`/`setViewDirection`/`getViewDirection`/ `getCameraUp` above all operate on `this.activeCamera`, not a hardcoded field, so they work unchanged after a toggle.

**Scene state:**

**Point rendering:** each `frame()` call (via `fitView`/`resetView`/`frameFromDirection`/`setOrthographic`) computes `pointSpriteScale = radius * 0.01` (the model's bounding-sphere radius, same input `pickThreshold` already uses) and applies it to every `THREE.Sprite`'s `.scale` in the model — this keeps point markers a roughly constant fraction of model size regardless of scale. This is a separate mechanism from `raycaster.params.Line.threshold` (Line-only); sprites have their own hit-testing via `THREE.Sprite`'s native raycasting.

```typescript
highlightGroup(groupId: string | null): void
```

If `groupId` is non-null, dims all meshes in the model except the one whose `userData.groupId` matches — opacity set to `baseOpacity * 0.08` for dimmed meshes, `baseOpacity` for the selected one (`transparent` follows whether the result is `< 1`). If `groupId` is null, restores all meshes to `baseOpacity`. **Composes with `setOpacity()` below rather than clobbering it**: `baseOpacity` is read from each material's `userData.baseOpacity` (defaulting to 1) — the same slot `setOpacity` writes — so dragging the Appearance panel's opacity slider to 0.5 and then spotlighting a tree node keeps the rest of the model at 0.5×0.08, not a hardcoded 0.08 that would silently ignore the slider, and the spotlighted group stays at 0.5, not a hardcoded 1.0 that would override it. `highlightedGroupId` remembers the last call so `setOpacity` can re-apply the same spotlight on top of a new baseline.

```typescript
setWireframe(on: boolean): void
```

Sets `material.wireframe` on every mesh in the scene. Memoizes the state so `setModel()` can re-apply it. Also the low-level primitive `setDisplayMode("wireframe")` drives internally, and that `render_snapshot`'s per-call `wireframe` override (`renderService.ts`) calls directly, bypassing display mode entirely — a disposable headless page has no interactive display-mode state to preserve.

```typescript
toggleGrid(): void
```

Toggles the visibility of the `GridHelper` and `AxesHelper`.

```typescript
getDisplayMode(): DisplayMode
setDisplayMode(mode: DisplayMode): void
```

`DisplayMode = "shaded" | "wireframe" | "xray" | "hiddenLines" | "flat"` (`src/webview/displayMode.ts`, DOM/Three.js-free — shared by `viewer.ts` and the `#display-mode-group` button wiring so they can't drift). Session-only, re-applied to every fresh material on `setModel()`. Internally:

- **shaded/wireframe/xray**: the mesh's original `MeshStandardMaterial` (`userData.standardMaterial`, captured once on this method's first run per mesh); wireframe drives `setWireframe(mode === "wireframe")`; xray folds an extra `0.35` multiplier into `highlightGroup()`'s existing `baseOpacity` composition (see `displayOpacityFactor()`) rather than being a separate opacity writer.
- **flat**: swaps `mesh.material` to a lazily-built, cached unlit `MeshBasicMaterial` (`userData.flatMaterial`) — a genuine material-class swap, the one exception to this codebase's "materials built once, only properties mutated" convention. Since `MeshBasicMaterial` has no `.emissive`, `renderSelection()`'s face branch falls back to a direct `.color` swap (the same technique edges/points already use) when `"emissive" in mat` is false. **Callers MUST call `setEntityColors()` + `renderSelection()` (or `main.ts`'s `refreshColors()`, which does both) right after `setDisplayMode()`** — the newly-active material starts at its default colour/no highlight, since colours/selection aren't tracked per-material internally.
- **hiddenLines**: builds/tears down `hiddenLineGhosts`, a `THREE.Group` of dimmed, `depthTest:false`/`depthWrite:false`, `transparent:true` copies of every edge line (sharing geometry with the real edge, never disposing it) — a scene sibling of `model` like `meshOverlay`, so `collectTargets` (which only ever traverses `model`) never picks them. The layering trick needs no per-pixel occlusion logic: `transparent:true` objects always render in a pass strictly after every opaque object (faces + the real, depth-tested edges), so a ghost paints faintly everywhere its line passes regardless of true depth, while the real edge — drawn first, depth-tested — already painted full-strength wherever it's genuinely visible, staying visually dominant there even though the ghost technically also draws a faint tint on top.

**Live operation preview (`setOpPreview`)**:

`setOpPreview(group: THREE.Group | null): void`

Replaces the current model with a live preview of the in-progress edit operation, rendering the preview group as a scene sibling of `model` (never a child). While a preview is active, the model is hidden (`model.visible = false`). The preview group carries an intent tint via material lerp: green for additive ops (fuse/add*), red for subtractive ops (cut/holes/shell/split), blue for wire/reference ops (profiles/curves/section/surface-from-lines), and neutral (no tint) for transforms/fillet/chamfer — per kind, documented below. The preview respects `baseOpacity` composition convention, so it never overrides the existing dimming from `highlightGroup()`. Callers must ensure the preview group is properly disposed when the operation is applied or cancelled — `main.ts` handles this via `cancelGizmoPreview()` before every real op commit and on selection/model rebuild. The preview is **not** persisted across document reloads; it resets on every new model load.

- **green** (additive): fuse, add*, feature modeling, patterns
- **red** (subtractive): cut, hole, shell, split
- **blue** (wire/reference): profile, curve, section, surface-from-lines
- **neutral** (transforms/fillet/chamfer): untinted, per-band deferred per roadmap design question

**Appearance (session-only, never persisted — mirrors `toggleGrid`'s "always wins once set"):**

```typescript
setBackground(hex: string): void
setEdgesVisible(visible: boolean): void
setSmoothEdgesVisible(visible: boolean): void
setOpacity(value: number): void
```

`setBackground` is a live override on top of `applyDefaults`' initial `cadPreview.background` value — same split as `showGridAndAxes` (default) vs. `toggleGrid()` (session toggle). `setEdgesVisible`/`setSmoothEdgesVisible` (roadmap "Display-edge classification, as a flag", closed, for the latter) compose through one shared private `applyEdgeVisibility()` rather than each writing `.visible` directly — `edgesVisible`/`smoothEdgesHidden` are now `Viewer` instance fields (`line.visible = edgesVisible && !(smoothEdgesHidden && line.userData.smooth)`), so the two toggles can't stomp on each other regardless of click order. `setSmoothEdgesVisible(false)` hides only edges tagged `userData.smooth` (set by `geometryBuilder.ts`'s `buildEdgeLine` from `EncodedEdge.smooth`) — tangent patch-seam continuations, not genuine feature edges — leaving everything else alone; the default is `true` (shown), so an existing document looks unchanged until the user opts in via the View ▾ menu's new "Hide smooth edges" item. Like the pre-existing `setEdgesVisible` it extends, neither toggle's effect survives a model rebuild by itself — a fresh `THREE.Object3D` from `setModel()` starts every line visible and `main.ts`'s `refreshColors()` doesn't currently re-apply either; a known, pre-existing limitation carried forward unchanged, not a regression. `setOpacity` writes `value` to every current face material's `userData.baseOpacity` (and to a `modelOpacity` field re-applied to fresh materials on the next `setModel()`, since a model rebuild after an edit creates brand-new materials with no baseline), then re-invokes `highlightGroup()` with whatever spotlight was last active so the two compose correctly (see `highlightGroup` above).

**Clipping (display-only, distinct from the `section` edit op — never touches the model):**

```typescript
setClippingPlane(plane: THREE.Plane | null): void
```

Sets/clears the live clipping plane, toggling `renderer.localClippingEnabled` and assigning `material.clippingPlanes = plane ? [plane] : []` across every material on `model`, `meshOverlay`, `worstElementsOverlay`, and `hiddenLineGhosts` (each needs the same plane — re-applied automatically from `setModel()`/`setMeshOverlay()`/`setWorstElementsOverlay()` too, since fresh materials from any rebuild start with no clipping state). Callers compute `plane` via `clipping.ts`'s `planeForAxis()` from the model's current bounding box.

The cut face is a real solid cap, not see-through — `clipCap.ts`'s stencil-buffer technique (see `CLAUDE.md`'s clipping section for the full write-up). `setClippingPlane` takes one of two paths depending on whether the change is structural: `rebuildClipCap()` (dispose+recreate the stencil-marker meshes) only when clipping just turned on, or `model`/`meshOverlay` changed; `updateClipCapPlane()` (mutate the shared `Plane` instance in place, reposition the cap) for every other call — in particular the `#clip-offset` slider's `input`-per-tick firing, which a full rebuild every tick would make visibly janky.

**Visibility (Parts hide/isolate, Tree per-node hide — display-only, transient, never persisted):**

```typescript
setGroupVisible(groupId: string, visible: boolean): void
applyPartVisibility(hiddenEntities: SelectedEntity[], isolatedEntities: SelectedEntity[] | null): void
```

`setGroupVisible` fully hides/shows every object tagged with `groupId` (a solid — the Components tree's per-node eye-toggle operates at this whole-solid granularity, the only depth the tree currently has). Distinct from `highlightGroup`'s opacity-dimming: `Object3D.visible = false`, gone entirely, not translucent. `applyPartVisibility` applies the Parts panel's hide/isolate state in one pass: `hiddenEntities` are forced invisible; if `isolatedEntities` is non-null, ONLY those entities are visible, overriding `hiddenEntities` for this call. Handles surfaces (matching either the face's own id or its owning solid's `groupId`, same membership check `renderSelection` uses), lines, and points — unlike `highlightGroup`, which only ever touches `THREE.Mesh`. Composition across repeated calls (e.g. "hide part A, then isolate part B, then clear isolate — A is still hidden") is the **caller's** job: `main.ts` recomputes both sets fresh from `VisibilityState` + `PartsModel.entitiesOf()` on every hide/isolate change, so this method itself needs no memory of prior calls.

```typescript
dispose(): void
```

Full cleanup: disposes model, renderer, and removes the resize observer.

**Measurement (display-only, never an edit op, never persisted):**

```typescript
setMeasureMode(on: boolean): void
setOnMeasurePick(onPick: ((pick: MeasurementPick) => void) | null): void
showMeasurementMarker(point: THREE.Vector3): void
showMeasurementOverlay(linePoints: THREE.Vector3[], anchor: THREE.Vector3, text: string, opts?: { tone?: "normal" | "fail" }): void
clearMeasurementOverlay(): void
```

`measureMode` is a **parallel interaction mode**, deliberately independent of `selectionMode`/`SelectionSet` — a click takes measurement priority over the normal Parts/Edits pick when both happen to be active (`onSelectPointerUp`). On a measure-mode hit, `buildMeasurementPick()` (private) assembles a `MeasurementPick` (`src/webview/measurementState.ts`) from the raycast intersection: the world-space hit point (available in the hit loop but normally discarded — the ordinary `onEntityPick` path only forwards the resolved `{entityType, entityId}`), a world-space direction for a `surface`/`line` hit (face normal via the intersection's local `face.normal` + normal matrix, or edge tangent from the two polyline points straddling the hit — used by the "angle" tool), and the picked edge's full world-space polyline (used by "edgeLength"/"radius"). `showMeasurementMarker`/ `showMeasurementOverlay`/`clearMeasurementOverlay` manage a `measurementOverlay` scene-sibling `THREE.Object3D` (same pattern as `meshOverlay`); a 2-point `linePoints` input builds the dimension-glyph group (arrowheads + witness stubs via `buildMeasureDimensionGroup`, sized off `getModelExtents()?.diagonal`) instead of the old bare line. The overlay's label sprite is rescaled every `animate()` frame (`distance-to-camera × 0.06`) to stay a constant on-screen size while zooming — unlike the point-sprite scale in `frame()`, which only updates on fit/reset. `setModel()` clears any measurement overlay, same as it clears the FE-mesh overlay — both refer to geometry that's about to be replaced. `tone: "fail"` recolors the label frame for an out-of-tolerance toleranced pin — a presentation choice derived at render time from the annotation's frozen facts (see [Protocol](./protocol.md)'s `Annotation.tolerance`).

**Transform Gizmo (live drag preview for Move/Rotate/Scale, never itself an edit op):**

```typescript
attachTransformGizmo(pivot: THREE.Vector3, mode: "translate" | "rotate" | "scale"): void
detachTransformGizmo(): void
isGizmoDragging(): boolean
getGizmoDelta(): { positionDelta: THREE.Vector3; quaternionDelta: THREE.Quaternion; scaleDelta: THREE.Vector3; pivot: THREE.Vector3 }
setGizmoHandlers(onChange: () => void, onDraggingChanged: (dragging: boolean) => void): void
```

Wraps three.js's own `TransformControls` (from `three/examples/jsm/controls/TransformControls.js`, already part of the `three` dependency — no new package), attached to a dedicated, permanently-scene-resident, geometry-free proxy `Object3D` (`gizmoProxy`) rather than directly to a real model object — a drag typically needs to move a WHOLE multi-solid selection as one rigid group about their shared bbox centroid, a capability the native single-object `attach()` doesn't have. `attachTransformGizmo(pivot, mode)` resets the proxy to `position = pivot, quaternion = identity, scale = (1,1,1)` on every (re)attach, which is what makes `getGizmoDelta()` trivial — the proxy's CURRENT transform after any drag directly IS the delta (only `positionDelta` needs the pivot subtracted back out). Per-target delta application (`applyTranslateDelta`/`applyRotateDelta`/`applyScaleDelta`/`quaternionToAxisAngle`, `gizmoTransform.ts` below) is pure, DOM-free math the caller (`main.ts`) runs once per selected object on every `onChange` callback. `setGizmoHandlers`' `onDraggingChanged` fires from the underlying `"dragging-changed"` event — genuinely dispatched despite not appearing as a literal string anywhere in the installed three.js source (`TransformControls`' generic `defineProperty` reactive-property setter constructs the event name dynamically) — and is what suspends/resumes `OrbitControls` for the duration of a drag. `onSelectPointerDown`/`onSelectPointerUp` both early-return while `isGizmoDragging()` is true, so a gizmo-handle drag never also triggers entity picking.

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

All functions operate on a `ViewerCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera` union and a `THREE.Vector3` target, mutating `camera.position` and/or `target` in place — `Viewer` keeps both camera types alive and swaps which is active for the ortho/perspective toggle (`Viewer.setOrthographic`). `orbit`/`setDirection`/`viewDirection` are pure position math and work identically on either camera type; `pan`/`dolly` are NOT — perspective's "how far is one pan/dolly unit" derives from FOV (meaningless for an orthographic projection, which has no FOV), so both branch on `camera instanceof THREE.OrthographicCamera`.

```typescript
function orbit(
  camera: ViewerCamera,
  target: THREE.Vector3,
  azimuthDeg: number,
  polarDeg: number
): void
```

Rotates the camera around the target using spherical coordinates. `azimuthDeg` rotates in the horizontal plane; `polarDeg` rotates vertically. Clamps polar angle to `[1°, 179°]` to avoid gimbal lock at the poles.

```typescript
function pan(
  camera: ViewerCamera,
  target: THREE.Vector3,
  dxFrac: number,
  dyFrac: number
): void
```

Translates both camera and target by `dxFrac`/`dyFrac` fractions of the framed extent, in the camera's right/up directions. The "pan unit" (how much world space one fractional unit covers) is `distance-to-target × tan(fov/2)` for a perspective camera; for orthographic, FOV doesn't exist, so it's `(camera.top - camera.bottom) / camera.zoom / 2` instead (the frustum half-height divided by the current zoom). Maintains the camera-to-target distance either way.

```typescript
function dolly(
  camera: ViewerCamera,
  target: THREE.Vector3,
  factor: number
): void
```

Perspective: moves the camera toward (`factor < 1`) or away from (`factor > 1`) the target, scaling the distance by `factor`; does not move the target. Orthographic: moving position has **no** visual zoom effect under a parallel projection, so the equivalent is scaling `camera.zoom` by `1/factor` instead (position untouched) — matches how three.js's own `OrbitControls` dollies an orthographic camera on mouse-wheel.

```typescript
function setDirection(
  camera: ViewerCamera,
  target: THREE.Vector3,
  dir: THREE.Vector3
): void
```

Repositions the camera along the direction `dir` (normalized) from the target, maintaining the current camera-to-target distance.

```typescript
function viewDirection(
  camera: ViewerCamera,
  target: THREE.Vector3
): THREE.Vector3
```

Returns the normalized vector from the target to the camera (`camera.position.clone().sub(target).normalize()`).

---

## `src/webview/viewerPanes.ts`

Pure pane-layout math for split view (roadmap "Split view", Phases 1+2) — DOM-free and unit-tested (`viewerPanes.test.ts`), following the `clipping.ts`/`cameraControls.ts` precedent of keeping the math testable and leaving only the three.js application in `viewer.ts`. All coordinates are CSS pixels (the space `getBoundingClientRect()` reports).

```typescript
type PaneLayoutId = "1x1" | "1x2" | "2x1" | "2x2"
interface PaneRect { x: number; y: number; width: number; height: number } // top-left origin
function paneCount(layout: PaneLayoutId): number
function computePaneRects(layout: PaneLayoutId, cssWidth: number, cssHeight: number): PaneRect[]
function paneAtPoint(rects: PaneRect[], cssX: number, cssY: number): number // -1 if outside
function ndcInPane(rect: PaneRect, cssX: number, cssY: number): { x: number; y: number }
function glViewportForPane(rect: PaneRect, cssHeight: number): { x: number; y: number; width: number; height: number }
```

- `computePaneRects` orders panes row-major (0 = top-left … 3 = bottom-right). The split point rounds and the last row/column absorbs the remainder, so rects always tile the canvas exactly — no gaps, no overlaps, integer edges for odd pixel counts (unit-tested).
- `paneAtPoint` gives boundary points to exactly one pane (right/bottom edges are exclusive), so a click can never pick two panes.
- `ndcInPane` is the pane-relative NDC (`-1..1`, +Y up) that feeds `Raycaster.setFromCamera` when picking inside a scissored viewport.
- `glViewportForPane` converts to the bottom-left-origin rect `renderer.setViewport`/`setScissor` and `TransformControls.viewport` expect.

---

## `src/webview/gizmoTransform.ts`

Pure math — no DOM, no THREE renderer, no `TransformControls` dependency (only `THREE.Vector3`/`THREE.Quaternion`). Unit-tested headlessly via Vitest. Backs the Transform Gizmo (`Viewer.attachTransformGizmo`/`getGizmoDelta`, above) and its grid/entity-point snapping.

```typescript
interface GizmoDelta {
  positionDelta: THREE.Vector3
  quaternionDelta: THREE.Quaternion
  scaleDelta: THREE.Vector3
  pivot: THREE.Vector3
}
interface TransformBase {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  scale: THREE.Vector3
}
```

`GizmoDelta` is what `Viewer.getGizmoDelta()` returns — the gizmo proxy's own transform after a drag, reinterpreted as a delta since the proxy always starts each attach at identity. `TransformBase` is one target object's transform captured fresh at drag START (`main.ts` snapshots one per selected volume when `onDraggingChanged(true)` fires).

```typescript
function applyTranslateDelta(base: TransformBase, delta: GizmoDelta): { position: THREE.Vector3 }
function applyRotateDelta(base: TransformBase, delta: GizmoDelta): { position: THREE.Vector3; quaternion: THREE.Quaternion }
function applyScaleDelta(base: TransformBase, delta: GizmoDelta): { position: THREE.Vector3; scale: THREE.Vector3 }
```

All three apply `delta` to `base` **about `delta.pivot`, not about the target's own position** — `applyRotateDelta`/`applyScaleDelta` move an off-centre target's position too, not just its orientation/size (verified in `gizmoTransform.test.ts` with a target exactly AT the pivot, where the position term correctly reduces to zero). `applyScaleDelta`'s formula (`pivot + scaleDelta·(basePosition − pivot)`, applied component-wise) is the identical affine transform `occtOperations.ts`'s non-uniform-scale edit op already computes server-side via `gp_GTrsf`, so the live gizmo preview and the eventual real B-rep replay agree on what "scale about a centre" means.

```typescript
function quaternionToAxisAngle(q: THREE.Quaternion): { axis: THREE.Vector3; angleRad: number }
```

Decomposes a rotation delta into the `axisDir`/`angleDeg` fields the `rotate` edit op actually needs (no THREE built-in does this) — handles both a single-axis ring drag and the free/screen-facing ring uniformly. Degenerates to the +Z axis at zero rotation (an arbitrary but stable choice, never NaN).

```typescript
function snapTranslateDelta(positionDelta: THREE.Vector3, gridSize: number): THREE.Vector3
function nearestSnapPoint(position: THREE.Vector3, candidates: THREE.Vector3[], tolerance: number): THREE.Vector3 | null
```

Grid and entity-point snapping (`main.ts`'s wiring for **View ▾ → Snap to grid / Snap to points**), applied only during a Translate drag. `snapTranslateDelta` rounds the SHARED drag delta to the nearest multiple of `gridSize` **once**, before any per-target loop, so a multi-target drag still moves as one rigid group with relative spacing exactly preserved (`gridSize <= 0` is a no-op passthrough, i.e. disabled). `nearestSnapPoint` instead runs **per target**, against each target's own candidate resulting position, against a plain array of `point-N` sprite world positions (`main.ts`'s `collectSnapPoints()`) — returns the closest candidate within `tolerance`, or `null`. Because it's per-target rather than shared, different targets in the same multi-selection drag may legitimately snap to different nearby points; when both toggles are on, point-snap wins for whichever target found a candidate within tolerance, grid-snap still applies to any target that didn't.

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
| ---------- | ----- | ------------- |
| 0          | +X    | Right         |
| 1          | -X    | Left          |
| 2          | +Y    | Top           |
| 3          | -Y    | Bottom        |
| 4          | +Z    | Front         |
| 5          | -Z    | Back          |

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

Builds a `THREE.Sprite` at the decoded position, tagged `userData = { entityType: "point", entityId: ep.pointId }`. Uses a single shared, lazily-built canvas dot texture (`dotTexture()` — memoized on first call, **not** built eagerly at module load: an earlier eager version broke `viewer.test.ts`, which imports this module transitively in a plain-Node vitest environment with no `document` available). `THREE.Sprite` was chosen over `THREE.Points`/`PointsMaterial` (which would raycast to a shared-buffer index, not a distinct `Object3D`, breaking the "one entity, one tagged object" invariant every other picking/colouring path relies on) and over per-vertex mesh geometry (real triangle cost × N, doesn't stay constant screen-size).

```typescript
function mergeAndBuild(meshes: { positions: Float32Array; indices: Uint32Array }[]): THREE.Mesh
```

Concatenates positions and remaps indices from multiple buffers into a single `THREE.BufferGeometry`. Calls `geometry.computeVertexNormals()`. Returns a `THREE.Mesh` via `meshFromGeometry()` (imported from `viewer.ts`).

```typescript
function buildFEMesh(positionsB64: string, indicesB64: string, edgesB64: string, elementGroups: MeshElementGroup[]): THREE.Group
```

Builds the display group for a generated FE-mesh surface (a `meshingResult` message's boundary triangulation), shown via `Viewer.setMeshOverlay()` — distinct from the model's own B-rep/native faces. Decodes the buffers, builds a `THREE.BufferGeometry`, and returns a `"feMesh"`-named `THREE.Group` containing: a shaded `THREE.Mesh` plus a `THREE.LineSegments` wireframe (built from the host's true element-edge `edges` buffer + `LineBasicMaterial`, color `0x1a3d66` — quad perimeters for hexes, triangle edges for tets, never the triangulated fill's diagonals). Both are tagged `userData.entityType = "mesh"` — deliberately **not** `"surface"`/`"line"`, so the existing picking/parts-colouring code (which only recognizes `"volume"|"surface"|"line"|"point"`) never tries to pick or colour the overlay. `elementGroups` partitions the triangle buffer into per-part colour ranges (`geometry.addGroup` per group) each with its own `MeshBasicMaterial` (color `g.color`, or `0x4ea1ff` for the trailing ungrouped/no-parts range — a distinct hue from the default face color so the overlay reads as separate from the model), so the shaded mesh renders multi-material. The shaded mesh uses an unlit `MeshBasicMaterial` (not `MeshStandardMaterial` like other face materials) — a tet-mesh boundary's many small, irregularly oriented triangles shade unevenly under scene lighting, which looks like scattered holes even on a complete, watertight mesh; flat color avoids that. It also sets `polygonOffset: true` (`polygonOffsetFactor`/`polygonOffsetUnits: 1`) because its wireframe is built from that exact same geometry — perfectly coincident triangles/lines z-fight without it.

```typescript
function buildWorstElementsHighlight(positionsB64: string, indicesB64: string): THREE.Object3D | null
```

Builds the worst-quality-elements highlight overlay (a `meshingResult` message's `worstElements.indices`, shown via `Viewer.setWorstElementsOverlay()`) — closes the roadmap gap where bad tets are frequently *interior* and invisible in `buildFEMesh`'s boundary-only overlay above. `indicesB64` is already the selected elements' own full boundary (computed host-side via `boundaryTriangles()`, see `src/gmshService.ts`'s `computeQualityAndWorstElements`), indexing into the SAME decoded `positionsB64` buffer `buildFEMesh` uses, so no extra geometry work happens here — only styling. Returns `null` for an empty index buffer (nothing scored below threshold), so `Viewer.setWorstElementsOverlay(null)` cleanly clears any prior overlay. The styling IS the actual fix for "invisible when interior": a single `THREE.Mesh` (tagged `userData.entityType = "mesh"`, same exclusion-from-picking rule as `buildFEMesh`) with a bright, distinct-hue (`0xff3b30`) `MeshBasicMaterial` set `transparent: true, depthTest: false, depthWrite: false` — mirroring `Viewer`'s Hidden Lines display mode's ghost-line technique (see above) — so it paints through occluding faces regardless of true 3D depth, with no clip plane or cutaway needed to see a bad element buried deep inside the model.

```typescript
function buildColorFieldOverlay(basePositions: Float32Array, valuesB64: string, min: number, max: number): THREE.Object3D
```

Builds the "colour by scalar field" overlay (roadmap item, closed; `colorFieldResult`, shown via `Viewer.setColorFieldOverlay()`) — a `"colorFieldOverlay"`-named `THREE.Group` wrapping one vertex-coloured `THREE.Mesh`. Deliberately built from `basePositions` (the caller's **unsplit** `pristineMesh` geometry, passed as a live `Float32Array` already in the browser — not base64, only the smaller per-corner `valuesB64` travels over postMessage) rather than recolouring the model's own per-facet split sub-meshes: `splitMeshesIntoFacets` regroups triangles by coplanarity into new geometries whose vertex order bears no relation to the original file's triangle order the host's `values` are correlated against (see `src/meshioService.ts`'s `readMeshioFieldValues`), so painting the field onto those directly would need re-deriving that mapping — building straight from the untouched triangle soup sidesteps it entirely. Decodes `valuesB64` (one value per triangle corner) and maps each through `colorMap.ts`'s `valueToColor(value, min, max)` into a `color` `BufferAttribute` alongside a **copy** of `basePositions` (`.slice()` — never mutates the caller's live geometry attribute). Material is an unlit `MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })`, same triangle-soup-shading-artifact reasoning as `buildFEMesh`; no `polygonOffset` needed since this overlay always fully replaces the model's own faces (`Viewer` hides them while it's shown), unlike `buildFEMesh`'s coincident wireframe case. The mesh is tagged `userData.entityType = "mesh"` (excluded from picking/parts-colouring, same convention as every other overlay here). Tolerates `values.length` being shorter than the position count (defensive — never throws), only colouring as many corners as it has values for.

```typescript
function viridis(t: number): [number, number, number]
function viridisHex(t: number): string
function valueToColor(value: number, min: number, max: number): [number, number, number]
function viridisCssGradientStops(steps?: number): string
```

`src/webview/colorMap.ts` — pure, DOM-free (unit-tested without jsdom). A small viridis-like ramp: 5 well-known control-point colours (`#440154`/`#3b528b`/`#21908d`/`#5dc963`/`#fde725`, the standard approximation used across many dataviz tools), linearly interpolated — no colour-science library dependency. `viridis(t)` clamps `t` to `[0, 1]` and returns `[r, g, b]` in `0–1` (for a `THREE.BufferAttribute`); `viridisHex(t)` is the same as a CSS `#rrggbb` string. `valueToColor(value, min, max)` maps a raw field value into `[0, 1]` via `(value - min) / (max - min)` before calling `viridis()` — degenerates to the ramp's exact midpoint (`t = 0.5`) for a constant field (`min === max`) rather than dividing by zero. `viridisCssGradientStops(steps = 8)` returns a comma-joined `"#hex N%"` list for a CSS `linear-gradient(to right, ...)` background — used by the "Colour by field" legend's gradient bar (`#vc-colorfield-gradient`).

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

| `format` | Loader       | Post-processing                          |
| -------- | ------------ | ---------------------------------------- |
| `"stl"`  | `STLLoader`  | Wraps `BufferGeometry` in a `THREE.Mesh` |
| `"obj"`  | `OBJLoader`  | Calls `applyDefaultMaterial(group)`      |
| `"ply"`  | `PLYLoader`  | Calls `geometry.computeVertexNormals()`  |
| `"gltf"` | `GLTFLoader` | Returns `gltf.scene`                     |

Every other `CadFormat` member (the meshio++-only formats — VTK/VTU/MED/CGNS/Exodus/XDMF/MDPA/OpenFOAM) throws via the `default` case — this function is never called with one of those. A meshio-imported document is converted to STL **host-side** first (`src/meshioService.ts`), so `loadMeshFromUrl` only ever sees `"stl"` for it (see `main.ts`'s `loadMeshObjectFromUrl` below).

```typescript
function applyDefaultMaterial(group: THREE.Group): void
```

Walks all `THREE.Mesh` children. For each mesh that has no material or has a `MeshBasicMaterial` (the OBJLoader default), replaces it with a `MeshStandardMaterial` (color `0x888888`).

---

## `src/webview/meshExporters.ts`

Dispatches to Three.js's bundled exporters (`three/examples/jsm/exporters/`) by format. Works on any loaded `THREE.Object3D`, regardless of whether it arrived via a native mesh loader or OCCT tessellation in the host — both end up as ordinary Three.js geometry in the scene.

```typescript
interface ExportedMesh { data: string; binary: boolean }

async function exportModel(model: THREE.Object3D, format: CadFormat, unit?: DisplayUnit): Promise<ExportedMesh>
```

| `format` | Exporter | Result |
| --- | --- | --- |
| `"stl"` | `STLExporter` (`{ binary: true }`) | `DataView` → base64 |
| `"obj"` | `OBJExporter` | text (OBJ has no binary form) |
| `"ply"` | `PLYExporter` (`{ binary: false }`, callback-based — wrapped in a `Promise`) | text |
| `"gltf"` | `GLTFExporter.parseAsync(model, { binary: true })` | `ArrayBuffer` (`.glb`) → base64 |

`unit` (optional, `DisplayUnit` from `../lengthUnits.ts`; `undefined`/`"mm"` is a no-op) is unit-conversion-on-export's mesh-target half — a REAL geometric scale, distinct from `units.ts`'s presentation-only display rescale. Implemented by a private `applyExportScale(model, unit)`: for a non-`"mm"` unit, `model.clone(true)` (children cloned too, but geometries/materials stay shared references — cheap, and the live displayed model is never mutated) has its root `.scale` multiplied by `unitScaleFactor(unit)`, then `updateMatrixWorld(true)` is force-called (the render loop never ticks for a parentless, off-scene clone, and every exporter above bakes `matrixWorld` into its output) before being handed to the exporter instead of `model`. Set on `provider.ts`'s `exportMesh` message field of the same name, which `main.ts`'s handler passes straight through.

```typescript
function arrayBufferToBase64(buf: ArrayBufferLike): string
```

Browser-side `btoa` counterpart to the `atob`-based decode in `geometryBuilder.ts`.

**Browser-only dependencies:** `GLTFExporter`'s binary path uses `FileReader`/`Blob`, and `PLYExporter.parse()` uses `requestAnimationFrame` — neither exists in plain Node, so they only run for real inside the webview. `meshExporters.test.ts` polyfills `requestAnimationFrame` to unit-test the PLY path and skips the glTF binary path entirely (covered by the manual F5 verification instead).

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

The in-webview **op-stack** for the replayable edit list. Pure data (no DOM), mirroring `PartsModel`. Owns both the applied list and a redo buffer; the host stays dumb and just persists / re-tessellates whatever list this produces.

```typescript
class EditsModel {
  constructor(onChange: () => void)
  load(ops: EditOp[]): void   // hydrate from sidecar — does NOT fire onChange
  list(): EditOp[]            // deep copies, in order
  redoList(): EditOp[]        // the redo buffer in CHRONOLOGICAL order (deep copies) — the order pending ops re-apply
  push(op: EditOp): void      // append; clears the redo buffer
  undo(): void                // pop last → redo buffer
  redo(): void                // re-apply most recently undone
  clear(): void               // empty both stacks
  remove(index: number): void // splice out a single op from anywhere in the list; clears the redo buffer
  jumpTo(index: number): void // op-history scrubbing: move the stack boundary straight to timeline position `index` in ONE splice, firing one onChange (a no-change jump fires none)
  get size(): number
  get canUndo(): boolean
  get canRedo(): boolean
}
```

`jumpTo` addresses the full chronological timeline — applied ops at `0..size-1`, then `redoList()`'s pending ops after them. Clicking timeline position k makes the state "after op k applied": an applied row rolls back past itself; a pending row re-applies through itself. Redo-buffer ORDER is preserved across any jump (demoted ops are prepended reversed so ↷ reapplies them in original order; promoted ops come off the buffer's end in exactly `redo()`'s order) — both orderings are pinned by worked-example tests in `editsModel.test.ts`. Known perf caveat: `loadBRepCached` only reuses its cached replay for a pure append of `previous.ops`, so a backward jump pays a full `applyEditsBRep` replay from the still-cached base shape — fine for click-to-jump; do not build a continuous-drag scrubber on top without revisiting that.

Every mutation fires `onChange`, wired in `main.ts` to the shared `syncEdits()`: resolve the ops against the current variables, post `editsChanged` (resolved ops and variables), render the panels, and (for mesh files) rebuild the displayed model. `load` does **not** fire — it is the initial sidecar load and must not echo back as a write.

**Resolve-on-read:** `EditsModel` itself is deliberately not variables-aware. `main.ts`'s `currentResolvedOps()` re-runs `resolveEditOps` (`src/editVariables.ts`) over `list()` at every consumption point, so ops sitting in the redo buffer can never resurface with stale numbers — no eager patch pass could reach them.

## `src/webview/selectFilters.ts`

A registry-driven geometric filter vocabulary for **Select ▾** (roadmap item — closed Tier 2, Phase 1, client-side). Pure, THREE-yes/DOM-no, unit-tested in `selectFilters.test.ts`.

- `FilterOption {id, label, argKind: "none"|"value"|"count"}` — `FACE_FILTERS`/`LINE_FILTERS` drive both the dropdown contents and the arg-field enable/disable. Volume/point modes show no options (the form is greyed — volume-level predicates need the group-dedupe asymmetry deferred with Phase 2).
- Face predicates: `Normal ±X/±Y/±Z` (area-weighted mean normal within `DIRECTION_TOLERANCE_DEG = 5°`), `Planar` (every triangle normal within the tolerance of the mean), `Area ≥/≤`, `Largest/Smallest N`.
- Line predicates: `Along X/Y/Z` (chord direction, sign-insensitive), `Length ≥/≤`, `Longest/Shortest N`, plus a `No seams` toggle (`userData.smooth === true` lines dropped before any other test).
- `faceArea`, `faceNormal`, `faceIsPlanar`, `edgeLength`, `edgeDirection` helpers; `applyFaceFilter(targets, id, arg)` / `applyLineFilter(targets, id, arg, excludeSmooth)` return `SelectedEntity[]` ready for bulk injection into `SelectionSet`. `collectTargets` already `traverseVisible`s hidden-subtree exclusion, so a filter never matches a hidden part. Deliberately the curated vocabulary future items must reuse — item 3's context-menu entry point and Tier 4's selector-synthesis predicate AST are both specified to reuse this vocabulary rather than invent a second.

## `src/webview/variablesModel.ts`, `src/webview/variablesPanel.ts`

`VariablesModel` mirrors `PartsModel`/`EditsModel` (pure data, `onChange` on every mutation, `load()` silent): `add()` (auto-names `L1, L2, …`, expr `"0"`), `rename(i, name)` (returns `false` for an invalid/duplicate name so the panel restores the input), `setExpr(i, expr)`, `remove(i)`, `list()` (clones). Variable mutations are **not** undoable ops — they live outside the `EditsModel` stack; undone/redone ops re-resolve against the current values.

`VariablesPanel` renders the `#variables-section` table (static markup from `provider.ts` `getHtml`, above the op composer): one row per variable with inline name/expression `<input>`s (webviews block `prompt()`), a computed `= value` span (or an ⚠ with the evaluation error and the retained last-good value in its tooltip), and a delete button whose tooltip warns when any op expression references the variable (usage computed by the wiring via `extractIdentifiers`). Stateless — the wiring re-calls `render(vars, values, errors, usage)` after every change.

## `src/webview/opCatalog.ts`

The **op catalog** — the single source of truth for the Edits panel's tab structure. Pure and DOM-free (unit-tested in `opCatalog.test.ts`).

```typescript
type PanelOpId = "translate" | "booleanUnion" | ... | "buildVolume"  // one id per op BUTTON
interface CatalogEntry { id: PanelOpId; label: string; brepOnly: boolean; kinds: EditOpKind[] }
interface CatalogCategory { title: string; ops: CatalogEntry[] }
const OP_CATALOG: { geometry2d: CatalogCategory[]; geometry3d: CatalogCategory[]; edit: CatalogCategory[] }
function allCatalogEntries(): CatalogEntry[]
function describeOp(op: EditOp): string   // moved here from editsPanel.ts (re-exported there);
                                          // parametric ops get a "[field = expr, …]" suffix
```

A `PanelOpId` is one op **button** — usually 1:1 with an `EditOpKind`, but the three booleans are separate buttons over the single `boolean` op kind, and the two Build buttons emit `addSurfaceFromLines`/`addVolumeFromSurfaces`. Each entry's `kinds` lists the EditOp kind(s) the button can emit; `brepOnly` is derived from `BREP_ONLY_OPS` over `kinds` and the agreement is locked by a test, as are icon completeness (every id keyed in `OP_ICONS`) and full `EditOpKind` reachability.

## `src/webview/opIcons.ts`

**GENERATED — never hand-edit.** `OP_ICONS: Record<PanelOpId, string>`, one inline-SVG value per Edits-panel op button, produced by `icons/build-op-icons.mjs` from `icons/tikz/*.tex` (`cd icons && make ops-ts`) — the same `currentColor`-based pipeline `src/toolbarIcons.ts` uses (see `icons/README.md`). `editsPanel.ts`'s `buildTabContent()` sets each value via `innerHTML` on the button's `<span class="op-icon">`, not `textContent`.

## `src/webview/editsPanel.ts`

### `EditsPanel`

Manages the `#edits-panel` DOM: two top-level tabs — **GEOMETRY** (creation ops, split into **2D**/**3D** subtabs) and **EDIT** (modification ops, one categorized list) — each rendered from `OP_CATALOG` as grids of icon op-buttons (`.op-grid`/`.op-btn`), a single shared parameter-form area (`#edits-params`) under the grids, the Undo/Redo/Clear control row, and the ordered op-history list with a one-line summary each (`describeOp`). Clicking an op button renders its parameter form; clicking it again collapses it. There is only one op stack regardless of which tab an op came from. VS Code webviews block `prompt()`, so all input is via inline fields.

```typescript
class EditsPanel {
  constructor(panel: HTMLElement, cb: EditsPanelCallbacks)
  render(ops: EditOp[], canUndo: boolean, canRedo: boolean, opOutcomes?: OpOutcome[] | null): void
  setBRepOnly(enabled: boolean): void
  setVariables(values: Record<string, number>): void  // evaluated values for expression fields
}
```

**Replay-outcome markers:** the optional `opOutcomes` (the most recent replay's per-op results — the B-rep path's arrive on the `"geometry"` message, the mesh path's are computed locally in `rebuildMeshModel()`; both feed `main.ts`'s shared `lastOpOutcomes` state) marks an op whose replay gracefully skipped: its history row gets a dimmed style plus a ⚠ marker whose tooltip carries the diagnostic and hint (`roadmap "A failed edit op is indistinguishable from one that did nothing", closed`). Rows with no matching outcome render unmarked.

**Expression fields:** every numeric input is `type="text"` (`inputmode= decimal`) and accepts either a plain number or an expression over the document's variables (`L*2`). The field readers (`readNum`/`readVec`/`rowVec`) evaluate non-numeric text against `setVariables`' values and side-collect the raw strings (keyed by op field path — `length`, `size[1]`, `points[2][0]`) into a pending `ExprMap`; the callbacks are **wrapped once in the constructor** so every apply transparently attaches the collected map to the outgoing draft as `draft.exprs` — or aborts with an inline `.expr-error-msg` when an expression failed — leaving the ~40 per-op apply closures untouched. `main.ts` copies `draft.exprs` onto the pushed op (remapping fillet/chamfer's shared `amount` field to the op's real `radius`/`distance` key).

**Callback-draft architecture:** each form's Apply handler builds a params-only draft and hands it to a callback; `main.ts` merges the live selection (target volumes, edges, faces) into it, applies a light client-side guard mirroring the matching `validateEditOp` rule (with a human status message), and pushes the `EditOp` into `EditsModel`. The callbacks:

- `onApplyTransform(TransformDraft)` — Move/Rotate/Scale/Mirror; targets = selected volumes.
- `onCaptureBooleanA()` / `onApplyBoolean(kind)` — the boolean two-step: **Set A** captures the selection (count echoed in the form; the panel mirrors it in `booleanACount` so it survives form re-renders), **Apply** uses the live selection as operand B. Three buttons (Unite/Subtract/Intersect) share one form.
- `onApplyFillet(kind, amount, exprs?)` — selected edges (B-rep only).
- `onApplyFeature(FeatureDraft)` — Extrude/Revolve/Sweep/Loft from the selected profile face(s)/path edge (B-rep only).
- `onApplyModify(ModifyDraft)` — Shell (opening faces = selected surfaces; the host derives each face's owning solid), Split-by-plane and Section (targets = selected volumes). B-rep only.
- `onApplyExplode(factor, exprs?)` / `onApplyMate()` — assembly ops.
- `onApplyPrimitive(PrimitiveDraft)` — Box/Sphere/Cylinder/Cone/Torus/Prism/Wedge; self-contained placement, **no selection needed**. All-formats except Wedge (B-rep only).
- `onApplyHole(HoleDraft)` — Hole/Counterbore/Countersink; subtractive, cut into the selected volumes (all formats — the mesh engine cuts via CSG).
- `onApplyProfile(ProfileDraft)` — Circle/Rectangle/Polygon/Ellipse/Rounded rect/Slot/Trapezoid sketches; no selection needed, B-rep only. The rectangle-family drafts carry an explicit `up: Vec3` so in-plane orientation is user-controlled. A sketch is created to be picked afterward (Surf mode) and fed into a feature op's `profile`.
- `onApplyWireframe(WireframeDraft)` — Point/Line/Arc plus the curve family (Polyline/3-Pt Arc/Spline/Bezier/Ellipse Arc/Helix); typed coordinates, B-rep only. Polyline/Spline/Bezier use the panel's **dynamic point-list widget** (`pointListField`): `.point-row`s of vec triples with per-row `−` remove buttons (disabled at the minimum count) and a trailing `+ Add point`; `readPoints()` walks rows in DOM order at emit time.
- `onBuildSurfaceFromLines()` / `onBuildVolumeFromSurfaces()` — the Build buttons; no capture step — `main.ts` reads the live Line/Surf selection at click time and guards the minimum count (≥3 lines, ≥4 faces).
- `onRemoveOp(index)` — a small ✕ button on each history row (revealed on row hover), wired straight to `EditsModel.remove(index)`. Unlike **↶ Undo**, which only pops the last op, this splices a single op out of anywhere in the list — the only way to drop one specific op without discarding everything applied after it. Clears the redo buffer, same as `push`; topology-changing ops after the removed one carry the same accepted "entity-id drift" risk as undo/redo (see [File Formats](./file-formats.md#edits-sidecar-modeleditsjson)).
- `onJumpTo(index)` — clicking ANY history row (applied, or a dimmed pending-redo one; roadmap "Op-history scrubbing", closed) scrubs the stack straight to that timeline position via `EditsModel.jumpTo` in one splice. The ✕ `stopPropagation()`s so removing never also jumps.

**B-rep gating:** every `CatalogEntry.brepOnly` button is pushed into `brepOnlyEls`, plus the whole **2D subtab** (every 2D op is B-rep-only — locked by a catalog test) with a tooltip. `setBRepOnly(false)` also collapses an open B-rep-only form and auto-switches an active 2D subtab to 3D. Elements are held by reference, so the tab re-parenting is transparent to the mechanism.

## `src/webview/meshEdits.ts`

The webview edit engine for **mesh formats** (no OCCT in the host). Folds the op-list over a pristine `THREE.Object3D` clone so ops replay cleanly on every change.

```typescript
function applyEditsMesh(root: THREE.Object3D, ops: EditOp[], outcomes?: OpOutcome[]): THREE.Object3D
function transformMatrixForOp(op: EditOp): THREE.Matrix4 | null   // pure, unit-tested
function resolveMeshTargets(root: THREE.Object3D, ids: string[]): THREE.Object3D[]
```

When `outcomes` is given, one `OpOutcome` is pushed per op — the webview-side half of the applied/not-applied reporting (the host's `applyEditsBRep` is the other half; there is no shared shape handle to identity-compare against here, so each dispatch site reports explicitly). A skipped op (B-rep-only kind, unresolved boolean/hole/transform targets, a pattern whose count adds no copies, an align that moves nothing) reports `applied: false` with a diagnostic and hint.

`transformMatrixForOp` builds the world-space matrix for translate/rotate/scale/ mirror (rotation/scale/mirror conjugated about their point via `T(p)·M·T(−p)`; mirror is a Householder reflection). **Booleans** go through `applyMeshBoolean`, which resolves operand A/B to their first mesh, evaluates a CSG via **`three-bvh-csg`** (`Evaluator`/`Brush` with `ADDITION`/`SUBTRACTION`/`INTERSECTION`), and replaces both operands in the tree with the single result mesh (tagged with A's node id). Feature-modeling ops (`BREP_ONLY_OPS`) are skipped — meshes have no sketch/exact topology. `main.ts` caches the pristine tagged object and calls `applyEditsMesh` on a clone inside `rebuildMeshModel()`.

**Primitives** (`addBox`/`addSphere`/`addCylinder`/`addCone`/`addTorus`/`addPrism`) go through `buildPrimitiveMesh(op)`, which constructs a fresh `THREE.BufferGeometry` (`BoxGeometry`/`SphereGeometry`/`CylinderGeometry`/`TorusGeometry` — `CylinderGeometry (radius, radius, height, sides)` doubles as the N-gon prism) and attaches it under `root`. Because `applyEditsMesh` always folds over a **fresh clone** of the pristine object (primitives never pre-exist in it), this construction happens on every replay — tagged `userData.groupId = "prim-{K}"`, where `K` counts only `addX` ops seen so far in that fold pass (reset per call), so ids are deterministic by op-list position and never collide with the loaded file's `node-N` ids. `baseAlignedMatrix`/ `centerAlignedMatrix` rotate Three's canonical primitive orientation (cylinder/cone: +Y-centred; torus: XY-plane ring, +Z normal — verified from the Three.js source) onto the op's `axis` via `Quaternion.setFromUnitVectors`, then translate; get the rotate-then-translate order wrong and non-canonical-axis primitives land off-centre (regression-tested with a tilted-axis cylinder in `meshEdits.test.ts`).

**Holes** (`addHole`/`addCounterboreHole`/`addCountersinkHole`) go through `applyMeshHole`, which subtracts a cylinder tool brush — plus a second wider cylinder (counterbore) or cone (countersink) as a sequential second `SUBTRACTION` — from the first mesh of the resolved targets, then replaces the target with the result (tagged with the target's node id, mirroring `applyMeshBoolean`). Tool placement reuses `baseAlignedMatrix` (mouth at `position`, drilled along `axis`). **Dispatch-order invariant:** hole op names start with `add`, so `applyEditsMesh` must handle them *before* the generic `op.op.startsWith("add")` primitive branch, and they never increment the `prim-{K}` counter (they don't create a body) — both locked by regression tests in `meshEdits.test.ts`.

**Align and pattern** (`align`/`patternLinear`/`patternCircular`, neither B-rep only) go through `applyMeshAlign`/`applyMeshPattern`. `applyMeshAlign` moves each target's `THREE.Box3` extent onto the absolute `to` coordinate, independently per target — the same "no whole-shape fast path" rule `alignSolids()` follows host-side. `applyMeshPattern` clones each target (`Object3D.clone(true)` — geometry/materials shared by reference, transform independent) `count - 1` times and `applyMatrix4`s each copy into place, tagging every new object `userData.groupId = "pattern-{K}"` — a **separate** counter (`patternCount`) from primitives' `prim-{K}`, since one pattern OP can produce multiple new tagged objects where one `addX` op produces exactly one.

## `src/webview/meshingModel.ts`

### `MeshingModel`

The in-webview store for the current FE-mesh generation options. Pure data (no DOM), mirroring `EditsModel`/`PartsModel`'s pattern but simpler: since options are a single flat bag rather than a list, there is no undo/redo/redo-buffer — just a current value that `update()` patches in place.

```typescript
class MeshingModel {
  constructor(onChange: () => void)
  load(options: MeshOptions): void        // hydrate from host — does NOT fire onChange
  get(): MeshOptions                       // a copy; mutating it does not affect internal state
  update(patch: Partial<MeshOptions>): void // merge + fire onChange
}
```

Every `update()` fires `onChange`, wired in `main.ts` to post `meshingChanged` (persisting the sidecar host-side) and re-render the panel — clearing any stale stats/error readout, since changing options doesn't itself produce a new result until the next **Generate**. `load()` does **not** fire — it is the initial host→webview hydration (from the sidecar or `DEFAULT_MESH_OPTIONS`) and must not echo back as a write.

## `src/webview/meshingPanel.ts`

### `MeshingPanel`

Manages the `#meshing-panel` DOM, top to bottom: a large-mesh warning strip (`#meshing-warning`, its icon from `TOOLBAR_ICONS.warning` — see `doc/extension-host-api.md`'s `src/toolbarIcons.ts` section — set via `innerHTML` since it's mixed with formatted text, not `textContent`); the primary size control (Coarse/Medium/Fine preset buttons, a coarser→finer log-scale slider driving `sizeMax`, and a `Size: X · ~N elements` readout); a "Part sizes" section mirroring the Parts panel's per-part `meshSize` inputs (hidden while no parts exist); a collapsed-by-default "Advanced settings" section with the raw options form (dimension, size min/max, 2D/3D algorithm dropdowns, element shape, element order, optimize checkbox, STL angle) — plus a Generate button, an export-format `<select>` (populated from `MESH_EXPORT_FORMATS` in `src/meshExportFormats.ts` — one shared registry instead of one button per format), an export-**unit** `<select>` (`#meshing-export-unit`, populated from `DISPLAY_UNITS` in `src/lengthUnits.ts`, defaulting to `"mm"`) + Export button, a Clear button, and a status line. Pure DOM, no business logic (size math delegates to `meshSizeHeuristics.ts`), no `prompt()`/`alert()` (VS Code webviews block those — same constraint as the Parts/Edits panels).

```typescript
interface ModelExtents { size: [number, number, number]; diagonal: number }
interface MeshingStats {
  nodeCount: number
  elementCount: number
  elapsedMs?: number
  quality?: QualitySummary
  worstElements?: { threshold: number; shownCount: number; belowThresholdCount: number }
}
interface MeshingError { error: string }

interface MeshingPanelCallbacks {
  onOptionsChange: (patch: Partial<MeshOptions>) => void
  onPartMeshSize: (index: number, size: number | undefined) => void  // undefined = inherit global
  onGenerate: () => void
  onExport: (format: MeshExportFormatId, unit: DisplayUnit) => void  // format + unit currently picked in the two `<select>`s
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

`render()` syncs every form control to `options` (including the slider position via `sizeToSlider`; a value outside the slider's range pegs the thumb at an end while the readout keeps the true number) and updates the status line: blank when `status` is omitted, `Nodes: N · Elements: M · 3.2 s` for a `MeshingStats` (time from `elapsedMs`, omitted when absent), or the error string (with an error CSS class) for a `MeshingError`. A `MeshingStats.quality` also renders a `min: … · mean: …` line plus a bar histogram below the status line (cleared, no row, when `quality` is `undefined`); a `MeshingStats.worstElements` (only ever alongside `quality`, for a 3D generate with something below threshold) adds one more line, e.g. `⚠ 42 elements below quality 0.20 (42)` or `(showing worst 2000 of 5300)` when the highlight overlay was capped — this is a readout only, rebuilt fresh on every `render()`; the actual on/off toggle for the highlight overlay itself lives outside this panel, in `main.ts`'s `#meshing-worst-toggle` wiring (see below), since a host-driven on/off state needs to survive across `render()` calls the same way `#meshing-toggle` does. When `options.sizeMax` is still the `SIZE_MAX_SENTINEL`, the Size max field shows an empty `auto` placeholder and the slider is disabled — the raw `1e+22` is never displayed. The 2D/3D algorithm dropdowns are populated from small curated, **not exhaustive**, lists of well-known GMSH algorithm ids (`Mesh.Algorithm`/`Mesh.Algorithm3D`) — e.g. Frontal-Delaunay (`6`) for 2D and Frontal (`4`, the default) for 3D — rather than every id GMSH supports.

The slider commits on `change` (release) only; `input` (mid-drag) refreshes the readout/warning locally so dragging never spams `meshingChanged`. Commits that would drop `sizeMax` below the current `sizeMin` include `sizeMin: 0` in the same patch (guarding `validateMeshOptions`' pair rule). `setModelExtents()` is pushed by `main.ts` on each model load and feeds the readout's element-count estimate and the presets; `setSourceKind("brep")` disables the STL angle field (it only feeds the STL reclassification path), mirroring `editsPanel.setBRepOnly`. `renderParts()` rebuilds the Part sizes rows — `onPartMeshSize` routes to the same `PartsModel.setMeshSize` the Parts panel uses, so the two inputs are views of one value.

`setBusy(true)` disables `#meshing-generate` (a slow WASM call can't be re-triggered mid-flight) and shows the indeterminate `#meshing-progress` bar (CSS keyframe sweep — GMSH's `generate()` is one opaque blocking call with no progress hook to report a real percentage from) plus a `"Generating…"` status line; `setBusy(false)` reverses both. `main.ts`'s `onGenerate` calls `setBusy(true)` before posting `meshingGenerate`, and the `meshingResult`/ `meshingError` handlers call `setBusy(false)` before rendering the outcome. Export (`onExport`) is not wired to `setBusy` — its save-dialog-driven completion surfaces through the generic `status`/`error` messages (`setStatus()`, the toolbar status bar), not this panel.

In `main.ts`, `onGenerate`/`onExport` each independently call an async `currentStlIfMeshSource()` helper before posting (returns `undefined` for B-rep documents, since the host re-exports STEP itself), then post `meshingGenerate`/`meshingExport` with the current `MeshingModel.get()` snapshot plus that optional `stl`; `onExport` additionally forwards its `unit` argument straight onto the outgoing `meshingExport` message's own `unit` field (a real geometric scale applied host-side before Gmsh sees the geometry — `unit` is `"mm"`-default and has no bearing on `meshingGenerate`, which always meshes at native mm; see CLAUDE.md's Meshing section for the full mechanism). `onClear` calls `viewer.setMeshOverlay(null)` AND `viewer.setWorstElementsOverlay(null)` directly, resets both the toolbar toggle's `meshingEnabled`/`.active` state and `#meshing-worst-toggle`'s `worstElementsShown`/`.active`/`hidden` state (same toggle-truthfulness rule `meshingResult`/`meshingError` follow), and re-renders the panel with no status. `#meshing-worst-toggle` itself mirrors `#meshing-toggle`'s wiring pattern exactly (own `let worstElementsShown`/`worstToggle` pair, a click listener calling `viewer.setWorstElementsOverlayVisible()`), but with one difference in the `"meshingResult"` handler: rather than only ever reflecting reality like the base toggle does, it's also auto-shown whenever `msg.worstElements` is present (and auto-hidden — `hidden = true` — otherwise) on every fresh generate, the same "surface a warning by default" framing the large-mesh warning banner already uses; the user can still turn it back off via the toggle.

---

## `src/webview/meshSizeHeuristics.ts`

The pure math behind the FE Mesh panel's primary size control. Plain numbers in/out — vscode-free, THREE-free, and (critically) gmsh-free, so rendering the panel can never trip the lazy-WASM-init invariant — and unit-tested headless (`meshSizeHeuristics.test.ts`), like `cameraControls.ts`.

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

`estimateElementCount` is an **order-of-magnitude heuristic computed from the bounding box only** (3D ≈ 6 tets per h-cube of bbox volume; 2D ≈ 2 triangles per h-square of bbox surface area; 1D ≈ segments along the diagonal) — it knowingly overestimates non-boxy models and exists to power the readout and the large-mesh warning, not to predict Gmsh's real output. The bbox comes from `Viewer.getModelExtents()`, pushed into the panel by `main.ts` on each model load.

Also exports `targetSizeForPreset(diagonal, preset: keyof typeof PRESET_DIVISORS): number` — like `defaultTargetSize` but scaled by the `cadPreview.defaultMeshSizePreset` setting's divisor instead of the fixed `DEFAULT_SIZE_DIVISOR`; `"medium"` reproduces `defaultTargetSize` exactly since `PRESET_DIVISORS.medium === DEFAULT_SIZE_DIVISOR`. Used by `main.ts`'s `syncMeshSizeSeed()` to seed a model with no saved `.mesh.json` sidecar.

---

## `src/webview/massPropertiesPanel.ts`

The Mass Properties panel — a small bespoke DOM class following `MeshingPanel`'s status-line-readout convention, just with more than one line.

```typescript
interface MassPropertiesDisplay {
  volume: number | null
  area: number | null
  length: number | null
  centerOfMass: [number, number, number] | null
  momentsOfInertia: { ixx: number; iyy: number; izz: number } | null  // diagonal only; null for mesh sources
}

class MassPropertiesPanel {
  constructor(panel: HTMLElement, cb: { onRefresh: () => void })
  renderMessage(text: string, isError?: boolean): void
  render(props: MassPropertiesDisplay, unitLabel?: string): void
}
```

`main.ts`'s `onRefresh` reads the current `SelectionSet`: 0 entries → whole model (`entityId: null`), exactly 1 → that entity, 2+ → `renderMessage`s a "select exactly one, or none" guidance line without sending any request. For a B-rep source it posts `massPropertiesRequest` and awaits `massPropertiesResult`/ `massPropertiesError` (guarded by a `massPropertiesRequestId` so a stale reply from a superseded refresh is ignored); for a mesh source it calls `computeAndRenderMeshMassProperties()` (below) with **no host round trip at all**. `momentsOfInertia` only shows its diagonal terms (`ixx`/`iyy`/`izz`) — the off-diagonal products of inertia are near-zero for most axis-aligned bodies and not worth the panel's space; mesh sources never populate this field (client-side inertia isn't computed, out of scope for the first cut) — and, per `units.ts` below, moments of inertia are also the one field `render()` never rescales regardless of `unitLabel`.

Both call sites go through `main.ts`'s `renderMassProperties(raw)` wrapper, never `massPropertiesPanel.render()` directly: it caches `raw` (always millimetres) in a module-level `lastRawMassProperties`, then calls `massPropertiesPanel.render(convertLengthBasedProperties(raw, currentDisplayUnit), currentDisplayUnit)`. Caching the *raw* value (not the already-converted one) is what lets `setDisplayUnit()` (below) live-rescale an already-displayed result when the user changes the unit selector, without re-requesting anything from the host or recomputing the mesh-source case.

---

## `src/webview/meshHealthPanel.ts`

"Mesh → B-rep promotion" (roadmap item, closed — both phases). Same bespoke-DOM-class shape as `massPropertiesPanel.ts` above, no unit test (this codebase's established convention for DOM panel classes).

```typescript
interface ComponentHealthDisplay {
  index: number
  triangleCount: number
  freeEdgeCount: number
  nonManifoldEdgeCount: number
  degenerateFaceCount: number
  requiredTolerance: number | null
  areaDeltaPct: number | null
  volumeDeltaPct: number | null
}
interface MeshHealthDisplay {
  componentCount: number
  components: ComponentHealthDisplay[]
}

class MeshHealthPanel {
  constructor(panel: HTMLElement, cb: { onCheck: () => void; onPromote: () => void })
  setEligible(eligible: boolean): void   // shows/hides the whole panel, disables Promote
  renderMessage(text: string, isError?: boolean): void
  render(report: MeshHealthDisplay): void
}
```

`setEligible()` toggles `panel.hidden` and, when turning eligible, resets the body to a neutral "Click Check Healability…" prompt — the panel is visible ONLY for a genuinely native `.stl`/`.obj`/`.ply` file on disk, the same `COMPARABLE_MESH_FORMATS` gate the MCP tools' `check_mesh_health`/`promote_mesh_to_brep` apply to a real file path. `main.ts` tracks this via a module-level `meshHealthEligibleFormat: "stl" | "obj" | "ply" | null`, set from `case "loadUrl"`'s `msg.format` (a native mesh open) and reset to `null` on `case "geometry"` (B-rep — nothing to heal) and `case "loadMeshBytes"` (a meshio-converted document is not itself a real stl/obj/ply file, even though its bytes happen to be STL-shaped). `render()` renders one row-group per component — free/non-manifold edge counts, degenerate face count, the required sewing tolerance (or "did not close" for `null`), and area/volume delta percentages (blank when the component never closed).

**Promote to B-rep… (Phase 2)** — the `#mesh-health-promote` button, enabled only when `render()`'s report shows at least one component with `requiredTolerance !== null` (both `render()` and `renderMessage()` otherwise force it back to `disabled`). Clicking it fires `cb.onPromote()`, which posts a single parameter-free `{type: "promoteToBrepButtonClicked"}` message — deliberately NOT a request/response round trip (mirrors `screenshotButtonClicked`'s precedent): the host owns the entire format/unit-quick-pick + save-dialog + write flow (`provider.ts`'s `handlePromoteToBrep`, mirroring `handleExport`'s structure) and reports outcome via the plain `"status"`/`"error"` messages, so the panel needs no new message-handler case at all, just the button wiring. Promoting does NOT change anything about the currently-open document — it writes an independent new file the user opens separately (see CLAUDE.md's "Mesh → B-rep promotion" section for why this is a one-shot export, not an in-place reclassification).

`onCheck` posts a `meshHealRequest` (guarded by a `meshHealRequestId`, the same stale-response-guard idiom `massPropertiesRequestId`/`measureExactRequestId` already use) and awaits `meshHealResult`/`meshHealError` — a genuine host round trip through `checkMeshHealth` (extension-host-api.md), since the sewing-tolerance-ladder check needs live OCCT, unlike Mass Properties' mesh-source path which computes entirely client-side.

---

## `src/lengthUnits.ts`

The shared, pure (vscode/DOM/THREE-free) length-unit table BOTH `src/webview/units.ts` (display conversion, below) and unit-conversion-on-export (`occtOperations.ts`'s `scaleShapeForExport`, this file's `meshExporters.ts` section above) build on, so the factor table can't drift between the two features. `mm: 1` is the identity/no-op case both default to.

```typescript
type DisplayUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft'
const DISPLAY_UNITS: readonly DisplayUnit[]

function unitScaleFactor(unit: DisplayUnit): number   // multiply a millimetre value by this
const UNIT_LABELS: Record<DisplayUnit, string>          // e.g. "Inches (in)" — for a unit picker
function displayUnitFromUnitName(name: string | undefined): DisplayUnit | undefined
```

## `src/webview/units.ts`

Display-unit conversion for Mass Properties and Measurement — pure, DOM-free (mirrors `measurement.ts`'s convention), built on `../lengthUnits.ts` above (re-exports `DisplayUnit`/`DISPLAY_UNITS`/`displayUnitFromUnitName` for backward-compatible imports). Presentation-layer only: every number this module touches is already in the model's one internal length unit (millimetres — OCCT's STEP/IGES readers auto-convert every shape to their cascade unit at read time; see `src/stepUnits.ts`'s doc comment for the live-WASM verification). Nothing stored — edit-op params, sidecars, mesh-size options — is ever rescaled; this only changes what a number *looks like*. Unit conversion on EXPORT (a real geometric transform) is a separate feature — see `meshExporters.ts`'s `exportModel` above and `occtOperations.ts`'s `scaleShapeForExport` (extension-host-api.md).

```typescript
function convertLength(mmValue: number, unit: DisplayUnit): number
function convertArea(mm2Value: number, unit: DisplayUnit): number
function convertVolume(mm3Value: number, unit: DisplayUnit): number

interface LengthBasedProperties {
  volume: number | null
  area: number | null
  length: number | null
  centerOfMass: [number, number, number] | null
}
function convertLengthBasedProperties<T extends LengthBasedProperties>(props: T, unit: DisplayUnit): T
```

`main.ts` holds the session-only `currentDisplayUnit` state (module-level, default `"mm"`, never persisted — same tier as every other Stage-2 Appearance control) and a `setDisplayUnit(unit)` helper that updates it, syncs the `#vc-unit` `<select>`'s value, and — if a Mass Properties result is currently shown — re-renders it converted to the new unit via the cached raw value (see `massPropertiesPanel.ts` above). `displayUnitFromUnitName(msg.sourceUnit)` (or `"mm"` if `undefined`) seeds the initial selection on every `"tree"` message (B-rep — `sourceUnit` is populated for both STEP and IGES sources now, via `src/stepUnits.ts`/`src/igesUnits.ts` respectively) and resets to `"mm"` unconditionally on every `"loadUrl"` message (mesh sources carry no unit metadata) — both are per-model-load resets, same spirit as `explodePreviewBases = null` on a new model. Measurement results (`computeMeasurementResult`'s `formatMeasureLength()` helper) rescale distance/edge-length/radius the same way, appending the unit as a suffix (`"12.700 mm"`); angle is degrees and is never touched by this module. The FE Mesh panel's size readout is a deliberate exception — it always shows a literal `"mm"` suffix, never `currentDisplayUnit`, since Gmsh's mesh-size options stay in the cascade unit regardless of the display-unit selector (see `meshingPanel.ts`'s `refreshSizeReadout()` comment).

---

## `src/webview/meshMassProperties.ts`

Client-side volume/area/centroid for mesh-format sources (STL/OBJ/PLY/glTF) — pure Three.js triangle math, no host round trip (no OCCT shape to query). Promotes the signed-tetrahedra volume algorithm already proven in `meshEdits.test.ts`'s test-only `volumeOf()` helper to production code.

```typescript
interface MeshMassProperties {
  volume: number                              // meaningful only if `meshes` is closed/watertight
  area: number
  volumeCentroid: [number, number, number]    // volume-weighted — the physically correct centroid for a closed body
  areaCentroid: [number, number, number]      // area-weighted — correct for a single open facet ("surface" pick)
}

function computeMeshMassProperties(meshes: THREE.Mesh[]): MeshMassProperties
```

Decomposes each triangle into a tetrahedron with an apex at the origin: signed volume `a·(b×c)/6`, tetra centroid `(a+b+c)/4` (apex contributes 0); summing `Σ(vᵢ·cᵢ)/Σvᵢ` across every mesh's every triangle gives the volume-weighted center of mass, independent of coordinate origin — the same standard result `BRepGProp.VolumeProperties` computes for a B-rep solid. Passing multiple meshes (e.g. every facet of one "volume" pick, via `buildMeshFacetGroup`'s `userData.groupId`) sums their triangles together, so per-entity results fall out of the same function with no special-casing — `main.ts`'s `computeAndRenderMeshMassProperties()` resolves the target `THREE.Mesh[]` by traversing `viewer.getModel()` for `entityType === "surface"` objects matching the selection's `groupId` (a "volume" pick) or `entityId` (a "surface" pick), or every such object for the whole-model case, then picks `volumeCentroid` (closed target: whole model or a "volume" pick) vs. `areaCentroid` (an open single-facet "surface" pick, where a signed volume has no physical meaning).

---

## `src/webview/measurement.ts`, `src/webview/measurementState.ts`, `src/webview/measurementOverlay.ts`

Measurement tools (distance, edge length, angle, circle/arc radius) — entirely webview-side, display-only overlay, never an edit op. Session-only by default (no protocol messages, no persistence) unless the user pins a result, which turns it into an `Annotation` — see `annotationsModel.ts` below. Client-side triangulated-approximation precision is a deliberate scope boundary (tied to the existing 0.1 tessellation deflection tolerance, `meshExtract.ts`) — exact BRep `BRepExtrema_DistShapeShape` entity-to-entity distance is out of scope for this cut (though available on demand via **⟟ Exact**, see below).

**`measurement.ts`** — pure math over plain `[x,y,z]` tuples, no DOM/THREE (unit-tested headless, same convention as `picking.ts`/`selection.ts`):

```typescript
type Vec3 = [number, number, number]
function pointDistance(a: Vec3, b: Vec3): number
function polylineLength(points: ArrayLike<number>): number       // flat [x0,y0,z0, x1,y1,z1, …]
function angleBetweenVectors(a: Vec3, b: Vec3): number            // degrees
function circleRadiusFromArcPoints(p0: Vec3, p1: Vec3, p2: Vec3): number | null  // 3-point circumradius
```

`polylineLength` operates directly on an edge's already-transmitted polyline (`EncodedEdge.positions`, world-transformed by `Viewer`) — no new host work for edge length. `circleRadiusFromArcPoints` samples the first/middle/last points of a picked edge's polyline for the "radius" tool.

**`measurementState.ts`** — a dedicated 0–2-pick buffer, deliberately **not** `SelectionSet` (measurement clicks must never pollute the Parts/Edits working selection):

```typescript
// MeasureTool now lives in src/protocol.ts (shared with the persisted
// Annotation.tool field) — measurementState.ts re-exports it.
type MeasureTool = 'distance' | 'edgeLength' | 'angle' | 'radius'

interface MeasurementPick {
  point: [number, number, number]
  entityType: EntityType | null
  entityId: string | null
  direction: [number, number, number] | null   // face normal / edge tangent — "angle" tool only
  polyline: Float32Array | null                // full world-space edge polyline — "edgeLength"/"radius" only
}

class MeasurementState {
  getTool(): MeasureTool
  setTool(tool: MeasureTool): void       // discards any in-progress pick
  getPicks(): MeasurementPick[]
  addPick(pick: MeasurementPick): { done: boolean; picks: MeasurementPick[] }  // done → picks reset for the next measurement
  clear(): void
}
```

Required pick counts: `distance`/`angle` need 2, `edgeLength`/`radius` need 1 (single-click tools resolve immediately).

**`measurementOverlay.ts`** — lazily-built Three.js objects:

```typescript
function makeMeasureLabelSprite(text: string, accent?: number): THREE.Sprite   // accent recolors the frame (out-of-tolerance pins pass MEASURE_FAIL_COLOR)
function makeMeasureMarkerSprite(): THREE.Sprite
function buildMeasureDimensionGroup(p0: THREE.Vector3, p1: THREE.Vector3, scale: number): THREE.Group
function disposeMeasureObject(obj: THREE.Object3D): void
```

Follows `geometryBuilder.ts`'s `dotTexture()` lazy-build discipline exactly — canvases are built on first *call*, never at module load, since this module is reachable from pure-function tests with zero DOM/jsdom available (a module-scope `document.createElement("canvas")` already broke tests once in this codebase, per the Points feature's history). Only one measurement overlay is ever live at a time (a new pick or mode toggle disposes the previous one first), so repainting the single shared label canvas and wrapping it in a fresh `CanvasTexture` per call is safe.

`buildMeasureDimensionGroup` renders a 2-point measurement as an actual **dimension glyph** (roadmap "Dimension-style rendering for pinned measurements", Phase 1): the measured line plus outward-pointing arrowhead cones and short perpendicular witness stubs, all geometry from the pure `dimensionGlyph.ts` math below. Arrowheads are oriented via `Quaternion.setFromUnitVectors(+Y → axis)` (the same alignment precedent `meshEdits.ts`'s primitive placement established) with tips exactly at the measured endpoints; everything uses `depthTest: false` + high `renderOrder`, matching the overlay's always-on-top convention. Deliberately **view-independent** (on-segment style): a pinned annotation's glyph must stay put while the camera orbits, so no screen-facing offset is computed — the classic offset-dimension drafting look belongs to the fixed-view SVG/DXF export path, which runs the SAME math with an offset direction.

**`dimensionGlyph.ts`** — pure dimension-glyph math (no DOM/THREE; unit-tested headless):

```typescript
interface ArrowheadSpec { tip: Vec3; axis: Vec3; length: number; halfWidth: number }
interface DimensionGlyph { line: [Vec3, Vec3]; extensionLines: Array<[Vec3, Vec3]>; witnesses: Array<[Vec3, Vec3]>; arrowheads: ArrowheadSpec[] }
function computeDistanceGlyph(p0: Vec3, p1: Vec3, options: { scale: number; offsetDir?: Vec3; upHint?: Vec3 }): DimensionGlyph
function formatMeasureValue(value: number): string
```

All sizes derive from `options.scale` (the model bbox diagonal) capped against the measured segment's own length, so two opposing arrowheads can never overlap on a short measurement. Degenerate input (coincident points, non-finite coordinates) yields a valid empty-bodied glyph — never NaN geometry. Passing `offsetDir` switches to the offset style (displaced dimension line + perpendicular extension lines overshooting it, per drafting convention) that the SVG/DXF export path uses. The same function also powers `svgSilhouette.ts`'s `dimensionDrawings()`, which projects pinned annotations into the export view basis and computes their glyphs IN PROJECTED 2D — one implementation shared by both renderers, so they cannot drift.

`main.ts`'s `setupMeasureControls()` wires the `#measure-dropdown` toolbar (toggle/tool `<select>`/Clear/readout span), dispatches completed picks to `measurement.ts`'s functions via `computeMeasurementResult()`, and calls `Viewer.showMeasurementMarker`/`showMeasurementOverlay`/`clearMeasurementOverlay` to display the result.

**Exact-precision measurement (`#measure-exact-btn`, ⟟).** The triangulated webview computation above is always approximate (tied to the 0.1 tessellation deflection tolerance) — for a B-rep source, a true OCCT-precision value is one click away. `main.ts` tracks the last completed measurement in module state (`lastMeasurement: { tool: MeasureTool; picks: MeasurementPick[]; result: MeasurementResult } | null` — `result` was added for the Pin button below; it was previously just `{tool, picks}`), set by the same `viewer.setOnMeasurePick()` callback that renders the approximate result, and cleared on Clear/tool-switch/mode-toggle/a pick that fails to resolve, and on every new model load (both the B-rep `geometry` handler and the mesh `loadUrl`/`loadMeshBytes` path — the latter also hides `#measure-exact-btn`, since mesh sources have no host-side B-rep to re-derive an exact value from). `refreshExactButton()` shows/enables the button only when `sourceKind === "brep"`, `exactMeasureKindFor(tool)` (which maps every `MeasureTool` straight through except `"angle"` → `null` — no OCCT call this codebase uses computes an exact face/edge angle, so the button never appears after an angle measurement) returns non-null, and the pick(s) resolved to real `entityId`s (both, for `"distance"`). Clicking it posts `{ type: "measureExactRequest", requestId, kind, entityIdA, entityIdB? }` (a fresh `measureExactRequestId`, same stale-response-guard pattern as `massPropertiesRequest`), disables the button, and appends "· computing exact…" to the current readout text. The host resolves the *live* entities (through the current edit-op stack, exactly like `inspect`/`measure`) via `BRepExtrema_DistShapeShape` (distance), `BRepGProp.LinearProperties` (edge length), or the edge's own `BRepAdaptor_Curve_2`/`Circle()` (radius — throws a clear, surfaced error for a non-circular edge) and replies with `measureExactResult`/`measureExactError` (see [Protocol](./protocol.md)). A successful result **replaces** the readout with `D_exact`/`L_exact`/`R_exact = <value>` (`formatMeasureLength()`, so it still tracks the Units dropdown); an error replaces it with the message instead, same as any other measurement error path. See [Extension Host API](./extension-host-api.md) for the host-side `measureExact()` implementation this now depends on.

---

## `src/webview/annotationsModel.ts`

Persisted, topology-anchored measurements (roadmap "Persisted, topology-anchored annotations", closed) — a "📌 Pin" action on a completed measurement result that survives closing the file, unlike the session-only overlay above. Pure data, no DOM, mirroring `PartsModel`'s push/rename/remove/`load()`(silent)/`onChange` contract:

```typescript
class AnnotationsModel {
  constructor(onChange: () => void)
  load(annotations: Annotation[]): void   // silent — no onChange echo, same as PartsModel.load
  list(): Annotation[]                    // deep clones
  push(annotation: Annotation): void
  rename(id: string, label: string): void // trims; empty label clears it
  remove(id: string): void
  static entitiesOf(a: Annotation): { entityType: EntityType; entityId: string }[]  // flattens the 4 id buckets
}
```

`main.ts` wires it: `#measure-pin-btn` (`#measure-readout-row`, beside `#measure-exact-btn`) is shown/enabled by `refreshPinButton()` whenever `lastMeasurement` has at least one resolved `entityId` — **on any `sourceKind`**, unlike `#measure-exact-btn` which is B-rep only (pinning only needs an entity id to anchor to, not exact OCCT geometry). Clicking it calls `annotationFromLastMeasurement()` (buckets `lastMeasurement.picks` by `entityType` into `volumes`/`surfaces`/`lines`/`points`, exactly like `PartsModel.assign`'s bucketing, and carries `lastMeasurement.result.text`/`.anchor`/`.linePoints` as the frozen `text`/`anchorPoint`/`linePoints`) and pushes it. `renderAnnotationsList()` rebuilds `#annotations-list` (the "Saved" section at the bottom of the `#measure-dropdown` panel) on every `AnnotationsModel` change and after every model rebuild (the `"geometry"` handler's B-rep branch and `rebuildMeshModel()`'s single choke point for mesh rebuilds) — each row shows the frozen `text`, a **Show** button (`viewer.showMeasurementOverlay(a.linePoints, a.anchorPoint, a.text)` — redisplays the frozen snapshot, no recompute, no host round trip), and a delete (✕, `TOOLBAR_ICONS.close`) button.

**"Detached" is computed reactively, not stored.** `Viewer.hasEntity(entityType, entityId): boolean` (a plain `model.traverse()` match against `userData.entityType`/`entityId`, mirroring `renderSelection`'s existing lookup) checks whether an annotation's anchor ids currently resolve in the loaded model. A row whose entities are empty, or where NONE resolve, renders with the `detached` CSS class (struck-through text) and a disabled **Show** button. This is what still reports honestly for a **mesh-format** source, which has no host-side rebind engine at all (same accepted limitation `Part` ids already have there) — a topology-changing mesh edit can leave stale ids with nothing to proactively correct them, so the webview's own live check is the only thing standing between the user and a silently-wrong overlay.

See [Extension Host API](./extension-host-api.md) for the sidecar (`annotationsStore.ts`/`annotationsSidecar.ts`) and the host-side rebinding this model's `load()` calls are ultimately driven by.

---

## `src/webview/visibilityState.ts`, `src/webview/treeFilter.ts`

Transient, session-only state for the Parts panel's eye-toggle/Isolate action and the Components tree's per-node eye-toggle/filter — display-only, **never** written to any sidecar (mirrors `SelectionSet`'s "transient, not persisted" precedent) and deliberately kept separate from `PartsModel`'s persisted `Part[]` list.

```typescript
class VisibilityState {
  toggleHiddenPart(index: number): void
  isPartHidden(index: number): boolean
  hiddenPartIndices(): number[]
  setIsolatedPart(index: number | null): void
  toggleIsolatedPart(index: number): void   // clicking the already-isolated part clears isolation
  isolatedPartIndex(): number | null
  isPartIsolated(index: number): boolean
  onPartCountChanged(count: number): void   // drops stale indices after a part delete
  toggleTreeGroupHidden(groupId: string): void
  isTreeGroupHidden(groupId: string): boolean
  hiddenTreeGroupIds(): string[]
}
```

Isolating a part clears no other state — hidden parts stay hidden once isolate is cleared, and vice versa; both compose because `main.ts`'s `applyVisibilityState()` recomputes the full `Viewer.applyPartVisibility()` input fresh from this state + `PartsModel.entitiesOf()` on every change (including after every model rebuild, via `refreshColors()`, since a fresh model's `THREE.Object3D`s start fully visible with no memory of prior hide/isolate calls).

```typescript
function filterTree(nodes: TreeNode[], query: string): Set<string>
```

Returns the ids of every node whose `label` case-insensitively contains `query`, plus every ancestor id needed to keep a match reachable when the tree renders filtered (auto-expand, not persisted-collapse-state — the simplest correct option, since `TreePanel.render()` already rebuilds `innerHTML` from scratch on every call with no collapse state to preserve). An empty/blank `query` matches everything.

`TreePanel`'s constructor now takes an `onToggleVisible: (id: string) => void` callback (alongside the existing `onSelect`) and a `VisibilityState` for read-only querying (rendering the eye icon's state); `filter(query: string)` re-runs the row builder against `filterTree()`'s result; `refreshVisibility()` re-renders eye icons without touching selection/filter state (called after a visibility change). `PartsPanel` similarly gains `onToggleVisible`/`onToggleIsolate` callbacks and a `VisibilityState` constructor param — a per-row eye button plus one panel-level "⊙ Isolate" button in `#parts-header` acting on the currently-selected part.

---

## `src/webview/explodePreview.ts`

Live exploded-view preview — lifts `meshEdits.ts`'s `applyMeshExplode()` math (already proven correct for the *committed* mesh-format explode op) into a format-agnostic, display-only preview usable on `viewer.getModel()`'s root directly, for **both** B-rep and mesh sources — genuinely new capability, since the authoritative `explode` op still requires a full OCCT host round-trip for B-rep, but the live preview needs none at all.

```typescript
interface ExplodeBase {
  object: THREE.Object3D
  basePosition: THREE.Vector3
  offsetFromCentre: THREE.Vector3   // groupCentre - modelCentre at capture time
}

function captureExplodeBase(root: THREE.Object3D): ExplodeBase[]
function applyExplodePreview(bases: ExplodeBase[], factor: number): void
function resetExplodePreview(bases: ExplodeBase[]): void
```

`captureExplodeBase` snapshots every `userData.groupId`-tagged top-level child's pristine position (deliberately excluding a B-rep root's untagged top-level "edges"/"points" groups — they stay in place during the live preview, a known limitation; the *committed* op still repositions everything correctly since OCCT re-tessellates the whole shape). `applyExplodePreview` computes every group's new position from the **cached** base every call — never compounding onto the previous frame's already-offset position, the correctness trap a dedicated test (`explodePreview.test.ts`) verifies directly. `resetExplodePreview` restores pristine positions.

`editsPanel.ts`'s Explode form gets a slider (`explodeSliderField()`, reusing `meshingPanel.ts`'s `.meshing-slider` CSS) alongside the existing `factor` number field: slider focus/mousedown → `captureExplodeBase`; every `input` event → `applyExplodePreview` (live, no gating — unlike the meshing slider, there's nothing to persist here) plus syncing the number field's value; Apply click → `resetExplodePreview` **then** the existing `editsModel.push({op:"explode", factor})` commit, so the preview transform is never left stacked on top of the authoritative replay. `editsPanel.ts`'s `selectOp()` (switching/collapsing op forms) also calls a new `onExplodePreviewCancel` callback unconditionally, so leaving the Explode form without applying always discards any in-progress preview.

---

## `src/webview/clipping.ts`

```typescript
type ClipAxis = 'x' | 'y' | 'z'
function planeForAxis(axis: ClipAxis, offsetFrac: number, box: THREE.Box3): THREE.Plane
```

Pure `THREE.Plane`/`THREE.Box3` math, no scene needed. Builds a world-space plane perpendicular to `axis` at a fractional offset across `box`'s extent along that axis (`-1` = min face, `0` = centre, `1` = max face, clamped). The plane's normal points in the **positive** `axis` direction — three.js clipping keeps geometry on the side the normal faces (`plane.distanceToPoint(point) >= 0`) and clips away the opposite side, so sweeping `offsetFrac` from `-1` toward `1` moves the cut plane from the box's min face toward its max face, progressively clipping away more of the model from the max-axis end.

`main.ts`'s `setupClippingControls()` recomputes the plane from `viewer.getModel()`'s current `THREE.Box3` on every axis-button click or slider `input` event and calls `viewer.setClippingPlane()` — see [`Viewer.setClippingPlane`](#src-webview-viewer-ts) for the solid-cap and FE-mesh-overlay-needs-the-same-plane behavior.

```typescript
function capCenterAndSize(plane: THREE.Plane, box: THREE.Box3): { center: THREE.Vector3; size: number }
```

Also pure. Where to centre the clip cap and how large to make it: projects `box`'s own centre onto `plane` (not the plane's closest point to the world origin, which could sit far from a model that isn't near the origin), sized to `box`'s full 3D diagonal so it safely covers any 2D cross-section through it. `Viewer.rebuildClipCap()`/`updateClipCapPlane()` are the only callers.

## `src/webview/clipCap.ts`

```typescript
function buildClipCap(targets: THREE.Mesh[], plane: THREE.Plane, center: THREE.Vector3, size: number, color: number): THREE.Group
function repositionClipCap(cap: THREE.Mesh, plane: THREE.Plane, center: THREE.Vector3, size: number): void
function disposeClipCap(group: THREE.Group): void
```

The stencil-buffer clip-cap technique (see `CLAUDE.md`'s clipping section for the full write-up of how/why it works and the structural-rebuild-vs-cheap- move split). `buildClipCap` creates one back/front stencil-marking mesh pair per target (reusing each target's geometry, positioned via a frozen `matrix` copy of its `matrixWorld` rather than parenting) plus one cap quad, stashing `capMesh`/`capGeometry` in the returned group's `userData` so `repositionClipCap`/`disposeClipCap` can find them without a `traverse()`. `disposeClipCap` disposes every material plus the cap's own `PlaneGeometry` — never the marker meshes' geometry, which belongs to `model`/`meshOverlay` and is disposed there. Not unit-tested (THREE-mesh-building code with no realistic headless test, same class as `geometryBuilder.ts`'s builders) — verified via manual F5 and a throwaway Playwright script against the real `media/viewer.js` bundle.

## `src/webview/displayMode.ts`

Pure data: `DisplayMode = "shaded" | "wireframe" | "xray" | "hiddenLines" | "flat"`, `DISPLAY_MODES` (the array, in UI order), `DISPLAY_MODE_LABELS` (button label text), `isDisplayMode(value): value is DisplayMode` (a type guard used to validate `.dataset.mode` off `#display-mode-group`'s buttons). No DOM/Three.js — imported by both `viewer.ts` (behavior, see `Viewer.setDisplayMode`) and `main.ts` (the button-group wiring) so the two can't drift.

## `src/webview/labelOverlay.ts`

```typescript
function drawLabel(source: HTMLCanvasElement, label: string): HTMLCanvasElement
```

Draws a small dark-background/white-text label box in the top-left corner of a **copy** of `source`, returning the new canvas (`source` itself is untouched). Plain Canvas2D, only ever called at runtime from `Viewer.captureLabeledScreenshotBase64()` — used by the headless `render_snapshot` MCP tool's `renderViewRequest` handler so each of the packet's same-shaped images is self-identifying ("TOP", "ISO-A", ...).

## `src/webview/canvasComposite.ts`

```typescript
function compositeCanvas(base: HTMLCanvasElement, overlay: HTMLCanvasElement | null): HTMLCanvasElement
```

Draws `overlay` on top of a **copy** of `base` and returns the merged canvas (returns `base` itself, unmodified, if `overlay` is `null`). Used by `Viewer.captureScreenshotBase64()`/`captureLabeledScreenshotBase64()` to bake the Markup annotation layer into Screenshot exports. `overlay`'s backing resolution need not match `base`'s — `drawImage`'s destination-size form stretch-fits it, so no devicePixelRatio bookkeeping is needed.

## `src/webview/markupModel.ts`, `src/webview/markupCanvas.ts`

The Markup annotation overlay's data/rendering split (mirrors `partsSidecar.ts`/`partsStore.ts`'s pure-vs-DOM convention).

```typescript
type Point = { x: number; y: number }                       // CSS-pixel canvas coordinates
type DrawTool = "freehand" | "line" | "arrow" | "rectangle" | "circle"
type MarkupTool = DrawTool | "eraser"
interface MarkupStroke { tool: DrawTool; color: string; points: Point[] }

class MarkupModel {
  push(stroke: MarkupStroke): void
  undo(): void
  redo(): void
  clear(): void
  list(): readonly MarkupStroke[]
  canUndo(): boolean
  canRedo(): boolean
  eraseAt(pt: Point): boolean        // true if anything was removed
}
```

`markupModel.ts` is pure/DOM-free (unit-tested in `markupModel.test.ts`). **The eraser is deliberately NOT part of the undo/redo history** — `eraseAt()` removes any stroke with a point within a fixed pixel radius of `pt` immediately and permanently for the session, rather than trying to make an arbitrary (not necessarily most-recent) removal compose with a linear undo/redo stack the way `EditsModel`'s op stack does.

```typescript
function drawStroke(ctx: CanvasRenderingContext2D, stroke: MarkupStroke): void
function redrawAll(canvas: HTMLCanvasElement, strokes: readonly MarkupStroke[], preview?: MarkupStroke): void
```

`markupCanvas.ts` is the DOM-touching half — `redrawAll` clears then redraws every committed stroke plus an optional in-progress `preview` stroke on top (used for the live freehand/shape preview while the pointer is still down). Not realistically unit-testable under this repo's vitest setup (no jsdom/ canvas polyfill) — verified only via manual F5, same caveat as `labelOverlay.ts`.

`main.ts`'s `setupMarkupControls()` owns the `#markup-canvas` element (`viewerDom.ts`) and all pointer-event wiring: `pointerdown` starts a stroke (or, in eraser mode, calls `eraseAt` immediately); `pointermove` extends a freehand stroke or updates a shape stroke's second point, redrawing a live preview each time; `pointerup` commits the finished stroke via `model.push()`. The canvas is `pointer-events:none` by default (see `viewer.css`) so it never intercepts orbit/pick input — toggling **✎ Markup** flips it to `"auto"` for the duration markup mode is active. `viewer. setMarkupCanvas(canvas)` registers it once at setup so `captureScreenshotBase64()`/`captureLabeledScreenshotBase64()` can composite it into every future screenshot.
