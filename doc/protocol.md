# Host ↔ Webview Protocol

The extension host and the webview communicate through VS Code's `postMessage` / `onDidReceiveMessage` bridge. Messages are plain JavaScript objects — no `Transferable`s, no `SharedArrayBuffer`.

All types are defined in `src/protocol.ts`.

---

## Shared Types

### `TreeNode`

```typescript
interface TreeNode {
  id: string
  label: string
  faceCount?: number      // only on solid nodes (B-rep)
  children?: TreeNode[]
}
```

Represents one node in the component hierarchy. `id` matches the `groupId` in `EncodedMesh` (for B-rep) or `userData.groupId` on a `THREE.Mesh` (for mesh formats).

### `EncodedMesh`

```typescript
interface EncodedMesh {
  positions: string   // base64-encoded Float32Array (XYZ vertex positions)
  indices: string     // base64-encoded Uint32Array (triangle indices, 0-based)
  groupId: string     // parent solid id this face belongs to
  faceId: string      // stable per-face entity id (e.g. "face-3")
}
```

One encoded mesh per **face** (B-rep). Geometry is base64-encoded for safe `postMessage` transport. `groupId` links the face to its solid's `TreeNode.id`; `faceId` is the stable per-face entity id used by part assignments and picking.

### `EncodedEdge`

```typescript
interface EncodedEdge {
  positions: string   // base64-encoded Float32Array — consecutive points form a polyline
  edgeId: string      // stable per-edge entity id (e.g. "edge-12")
}
```

One per **unique edge** (B-rep), discretized to a polyline. Shared edges are de-duplicated host-side; `edgeId` is stable across reopen of an unchanged file.

### `EncodedPoint`

```typescript
interface EncodedPoint {
  position: string   // base64-encoded Float32Array, length 3 (XYZ)
  pointId: string     // stable per-vertex entity id (e.g. "point-5")
}
```

One per **unique vertex** (B-rep) — every vertex in the shape, including the model's own corners as well as any user-added standalone points. Unlike faces and edges, points are never resolved as operands by another op (`addLine`/`addArc` take typed coordinates, not point-id references), so extraction is purely for display/picking.

### `EntityType` and `Part`

```typescript
type EntityType = 'volume' | 'surface' | 'line' | 'point'

interface Part {
  name: string
  color: string       // CSS hex, e.g. "#ff8800"
  volumes: string[]   // solid ids
  surfaces: string[]  // face ids
  lines: string[]     // edge ids
  points: string[]    // point ids
}
```

A `Part` is a user-defined named group (FEM sub-model-part). Entity ids are the stable topological ids above (`solid-*`, `face-*`, `edge-*`, `point-*`), or, for mesh formats, stable per-object ids (`node-*`) for volumes/surfaces (mesh formats have no assignable lines or points). Parts are persisted in the JSON sidecar — see [File Formats](./file-formats.md).

### `EditOp`

```typescript
type Vec3 = [number, number, number]

type EditOp =
  | { op: 'translate'; targets: string[]; vec: Vec3 }
  | { op: 'rotate'; targets: string[]; axisPoint: Vec3; axisDir: Vec3; angleDeg: number }
  | { op: 'scale'; targets: string[]; center: Vec3; factors: Vec3 }   // uniform = [s,s,s]
  | { op: 'mirror'; targets: string[]; planePoint: Vec3; planeNormal: Vec3 }
  | { op: 'boolean'; kind: 'union' | 'subtract' | 'intersect'; a: string[]; b: string[] }
  | { op: 'fillet'; edges: string[]; radius: number }
  | { op: 'chamfer'; edges: string[]; distance: number }
  | { op: 'extrude'; profile: string; dir: Vec3; length: number }
  | { op: 'revolve'; profile: string; axisPoint: Vec3; axisDir: Vec3; angleDeg: number }
  | { op: 'sweep'; profile: string; path: string }
  | { op: 'loft'; profiles: string[] }
  | { op: 'explode'; factor: number }
  | { op: 'mate'; faceA: string; faceB: string }
  | { op: 'shell'; thickness: number; openingFaces: string[] }        // >= 1 face id; negative = walls inward
  | { op: 'splitByPlane'; targets: string[]; planePoint: Vec3; planeNormal: Vec3; keep: 'both' | 'positive' | 'negative' }
  | { op: 'section'; targets: string[]; planePoint: Vec3; planeNormal: Vec3 }
  | { op: 'addBox'; center: Vec3; size: Vec3 }
  | { op: 'addSphere'; center: Vec3; radius: number }
  | { op: 'addCylinder'; center: Vec3; axis: Vec3; radius: number; height: number }
  | { op: 'addCone'; center: Vec3; axis: Vec3; radius1: number; radius2: number; height: number }
  | { op: 'addTorus'; center: Vec3; axis: Vec3; majorRadius: number; minorRadius: number }
  | { op: 'addPrism'; center: Vec3; axis: Vec3; radius: number; sides: number; height: number }
  | { op: 'addWedge'; center: Vec3; axis: Vec3; up: Vec3; dx: number; dy: number; dz: number; ltx: number }
  | { op: 'addHole'; targets: string[]; position: Vec3; axis: Vec3; radius: number; depth: number }
  | { op: 'addCounterboreHole'; targets: string[]; position: Vec3; axis: Vec3; radius: number; depth: number; cbRadius: number; cbDepth: number }
  | { op: 'addCountersinkHole'; targets: string[]; position: Vec3; axis: Vec3; radius: number; depth: number; csRadius: number; csAngleDeg: number }
  | { op: 'addCircleProfile'; center: Vec3; normal: Vec3; radius: number }
  | { op: 'addRectangleProfile'; center: Vec3; normal: Vec3; up: Vec3; width: number; height: number }
  | { op: 'addPolygonProfile'; center: Vec3; normal: Vec3; up: Vec3; radius: number; sides: number }
  | { op: 'addEllipseProfile'; center: Vec3; normal: Vec3; up: Vec3; radiusX: number; radiusY: number }
  | { op: 'addRoundedRectangleProfile'; center: Vec3; normal: Vec3; up: Vec3; width: number; height: number; cornerRadius: number }
  | { op: 'addSlotProfile'; center: Vec3; normal: Vec3; up: Vec3; length: number; width: number }
  | { op: 'addTrapezoidProfile'; center: Vec3; normal: Vec3; up: Vec3; bottomWidth: number; topWidth: number; height: number }
  | { op: 'addPoint'; position: Vec3 }
  | { op: 'addLine'; start: Vec3; end: Vec3 }
  | { op: 'addArc'; center: Vec3; normal: Vec3; radius: number; startAngleDeg: number; endAngleDeg: number }
  | { op: 'addPolyline'; points: Vec3[]; closed: boolean }            // >= 2 points (>= 3 when closed)
  | { op: 'addThreePointArc'; p1: Vec3; p2: Vec3; p3: Vec3 }
  | { op: 'addSpline'; points: Vec3[] }                               // approximating, endpoint-exact fit
  | { op: 'addBezier'; controlPoints: Vec3[] }
  | { op: 'addEllipseArc'; center: Vec3; normal: Vec3; up: Vec3; radiusX: number; radiusY: number; startAngleDeg: number; endAngleDeg: number }
  | { op: 'addHelix'; center: Vec3; axis: Vec3; radius: number; pitch: number; turns: number }
  | { op: 'addSurfaceFromLines'; edges: string[] }   // >= 3 edge ids, must close into a loop
  | { op: 'addVolumeFromSurfaces'; faces: string[] } // >= 4 face ids, must sew into a closed shell
```

An `EditOp` is one entry in the ordered, replayable edit op-list. Operands are the same stable entity ids as parts. `validateEditOp` (`src/editOps.ts`) is the single tolerance gate — malformed ops are dropped, never thrown. The list is persisted in the `<model>.edits.json` sidecar — see [File Formats](./file-formats.md).

Every op may additionally carry an optional **parametric annotation** `exprs?: Record<string, string>` mapping a numeric field path (`length`, `size[1]`, `points[2][0]`) to an expression over the document's named variables (`ParamVariable`, below). The addressed numeric fields always hold the last-good evaluated numbers — a cache — so every consumer that ignores `exprs` still sees a fully-resolved op; only `resolveEditOps` (`src/editVariables.ts`) reads it. `validateEditOp` sanitizes `exprs` (bad paths / non-numeric slots / syntax errors dropped per entry).

```typescript
interface ParamVariable {
  name: string    // identifier ([A-Za-z_][A-Za-z0-9_]*, not a function/constant name)
  expr: string    // defining expression; may reference variables defined ABOVE it only
  value: number   // cached last-good evaluation (kept when re-evaluation fails)
}
```

All op kinds are implemented: transforms, booleans, fillet/chamfer, feature modeling (extrude/revolve/sweep/loft), modify ops (shell/split-by-plane/section, B-rep only), assembly (explode/mate), primitive creation (box/sphere/cylinder/cone/ torus/prism/wedge), subtractive holes (plain/counterbore/countersink — cut into the target volumes on both pipelines), 2D profile sketches (circle/rectangle/ polygon/ellipse/rounded-rectangle/slot/trapezoid, B-rep only, for use as a later feature-modeling `profile`), curves (polyline/three-point arc/spline/bezier/ ellipse arc/helix, B-rep only), and bottom-up wireframe modeling (addPoint/addLine/addArc/addSurfaceFromLines/addVolumeFromSurfaces, B-rep only).

### `MeshOptions`

```typescript
interface MeshOptions {
  dimension: 1 | 2 | 3
  sizeMin: number
  sizeMax: number
  algorithm2D: number   // Mesh.Algorithm
  algorithm3D: number   // Mesh.Algorithm3D
  elementOrder: 1 | 2
  elementShape: 'simplex' | 'subdivided'  // triangles/tets vs quads/hexes
  optimize: boolean
  stlAngle: number       // classifySurfaces angle, degrees
}
```

The flat options bag for GMSH FE-mesh generation (see [GMSH Integration](./gmsh-integration.md)). `validateMeshOptions` (`src/meshOptions.ts`) is the single tolerance gate — an individually invalid field falls back to `DEFAULT_MESH_OPTIONS` for that field alone, so a hand-edited or partially-corrupt `<model>.mesh.json` sidecar degrades gracefully rather than blocking meshing. Sent host → webview in `meshingOptions` (hydration) and webview → host in `meshingChanged`/`meshingGenerate`/`meshingExport`.

### `ViewerDefaults` and `MassProperties`

```typescript
interface ViewerDefaults {
  background: string                              // CSS hex color
  meshSizePreset: 'coarse' | 'medium' | 'fine'
  showGridAndAxes: boolean
  upAxis: 'y' | 'z'
}

interface MassProperties {
  volume: number | null            // whole model or a solid-N only (never face-N/edge-N)
  area: number | null              // whole model, a solid-N (boundary area), or a face-N
  length: number | null            // a single edge-N only
  centerOfMass: [number, number, number] | null
  momentsOfInertia: { ixx: number; iyy: number; izz: number; ixy: number; ixz: number; iyz: number } | null  // about the centroid
}

interface QualitySummary {
  min: number
  mean: number
  histogram: number[]   // bucket i covers [i/N, (i+1)/N) of the quality range; see meshingResult below
}

type DisplayUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft'   // src/lengthUnits.ts — shared by the webview's display-unit selector AND unit-conversion-on-export

interface WorstElementsMsg {
  indices: string        // base64 Uint32Array — triangle indices into meshingResult.positions
  threshold: number       // the minSICN cutoff used to select "worst" elements
  shownCount: number       // elements actually included in `indices` (capped)
  belowThresholdCount: number  // total elements below `threshold` found (>= shownCount if capped)
}

type ExactMeasureKind = 'distance' | 'edgeLength' | 'radius'   // src/entityFacts.ts — no "angle" (BRepExtrema_DistShapeShape has no such analogue)

interface ExactMeasureResult {
  kind: ExactMeasureKind
  value: number
  fromPoint?: [number, number, number]   // kind: "distance" only — the actual nearest points OCCT found
  toPoint?: [number, number, number]
}
```

`ViewerDefaults` mirrors the `cadPreview.*` VS Code settings (`src/viewerDefaults.ts`) — cross-document defaults only; a per-document sidecar value or a runtime toggle (the toolbar Grid button) always wins once set. `MassProperties` is computed via OCCT `BRepGProp` for B-rep sources (`src/massProperties.ts`); mesh sources compute the equivalent client-side and never send it over this protocol at all (no host round trip) — see [Extension Host API](./extension-host-api.md) and [Webview API](./webview-api.md).

---

## Host → Webview Messages (`HostToWebview`)

```typescript
type HostToWebview =
  | { type: 'geometry'; meshes: EncodedMesh[]; edges: EncodedEdge[]; points: EncodedPoint[] }
  | { type: 'tree';     root: TreeNode; sourceUnit?: string }
  | { type: 'loadUrl';  url: string; format: CadFormat }
  | {
      type: 'loadMeshBytes'; sourceFormat: CadFormat; dataBase64: string
      meshioMetadata?: {
        regions: Array<{ name: string; kind: string; numEntries: number }>
        pointDataNames: string[]; cellDataNames: string[]; fieldDataNames: string[]
      }
    }
  | { type: 'parts';    parts: Part[] }
  | { type: 'edits';    ops: EditOp[]; variables: ParamVariable[] }
  | { type: 'status';   text: string }
  | { type: 'error';    message: string }
  | { type: 'editError'; message: string }
  | { type: 'exportMesh'; requestId: string; format: CadFormat; unit?: DisplayUnit }
  | { type: 'meshingOptions'; options: MeshOptions }
  | { type: 'meshingResult'; positions: string; indices: string; edges: string; nodeCount: number; elementCount: number;
      elementGroups: MeshElementGroup[]; elapsedMs: number; quality?: QualitySummary; worstElements?: WorstElementsMsg }
  | { type: 'meshingError'; message: string }
  | ({ type: 'viewerDefaults' } & ViewerDefaults)
  | { type: 'screenshotRequest'; requestId: string }
  | { type: 'massPropertiesResult'; requestId: string; properties: MassProperties }
  | { type: 'massPropertiesError'; requestId: string; message: string }
  | { type: 'measureExactResult'; requestId: string; result: ExactMeasureResult }
  | { type: 'measureExactError'; requestId: string; message: string }
```

### `geometry`

Sent after B-rep tessellation. Contains every face as an encoded mesh, every unique edge as a polyline, and every vertex as a point. The webview calls `buildGroupFromEncoded(msg.meshes, msg.edges, msg.points)` (one `THREE.Mesh` per face, one `THREE.Line` per edge, one `THREE.Sprite` per point, parented under per-solid groups / a top-level `"points"` group) and then `viewer.setModel(group)`.

```json
{
  "type": "geometry",
  "meshes": [
    { "positions": "AAAA...", "indices": "AAAA...", "groupId": "solid-0", "faceId": "face-0" },
    { "positions": "BBBB...", "indices": "BBBB...", "groupId": "solid-0", "faceId": "face-1" }
  ],
  "edges": [
    { "positions": "CCCC...", "edgeId": "edge-0" }
  ],
  "points": [
    { "position": "DDDD...", "pointId": "point-0" }
  ]
}
```

### `tree`

Sent alongside (or shortly after) `geometry` for B-rep files. Also sent for Three.js mesh files after the model is loaded and the Object3D hierarchy is walked.

`sourceUnit` is the source file's declared length unit (e.g. `"INCH"`, `"MILLIMETRE"`), detected by a plain-text scan: `src/stepUnits.ts`'s `detectStepLengthUnit` for a STEP file's `DATA` section, `src/igesUnits.ts`'s `detectIgesLengthUnit` for an IGES file's fixed-width Global-section unit flag (both return the same canonical name vocabulary) — `undefined` for BREP (no unit metadata in the format at all) or a STEP/IGES file with no unit declaration, or one whose value isn't among the five units this UI offers. It is purely informational: OCCT's STEP/IGES readers already auto-convert every shape to one internal cascade unit (millimetres) regardless of this value, so geometry numbers are always already consistent. The webview uses it only to seed the view-controls "Units" display-unit selector (`src/webview/units.ts`) — switching that selector never changes any stored value, only how Mass Properties/Measurement numbers are formatted.

```json
{
  "type": "tree",
  "sourceUnit": "INCH",
  "root": {
    "id": "root",
    "label": "STEP Assembly",
    "children": [
      { "id": "solid-0", "label": "Solid 1", "faceCount": 12 },
      { "id": "solid-1", "label": "Solid 2", "faceCount": 8 }
    ]
  }
}
```

### `loadUrl`

Sent for mesh-format files (STL/OBJ/PLY/glTF). The `url` is a `vscode-webview://` URI produced by `webview.asWebviewUri(uri)`. The webview calls `loadMeshFromUrl(url, format)`.

```json
{
  "type": "loadUrl",
  "url": "vscode-webview://.../.../examples/STL/cube.stl",
  "format": "stl"
}
```

### `loadMeshBytes`

Sent for meshio++-only source files (VTK/VTU/MED/CGNS/Exodus/XDMF/MDPA — see [File Formats](./file-formats.md#meshio-bridge-formats-vtk-med-cgns-exodus-xdmf-kratos-mdpa)). Unlike `loadUrl`, the webview has no native loader for these formats at all, so the host converts the file host-side first (`src/meshioService.ts`'s `convertToStlBoundary()`, via meshio++'s `convertSurface`) and sends the resulting **STL bytes** directly over postMessage as base64 — the same transport pattern `geometry` already uses for large buffers, deliberately not a `data:` URL (sidesteps any webview CSP/size-limit uncertainty around those). `sourceFormat` is the document's *actual* source format (e.g. `"vtk"`), used only for the Components tree root's label — the bytes themselves are always `"stl"` and are fed through the exact same `loadMeshFromUrl(url, "stl")` call `loadUrl` uses, via a `blob:` object URL (`URL.createObjectURL`) instead of a `vscode-webview://` fetch. From this point on, a meshio-imported document is indistinguishable from a native `.stl` open to every other feature.

An optional `meshioMetadata` carries **read-only visibility** into named regions (gmsh physical groups, Abaqus NSET/ELSET/SURFACE, Exodus blocks/sets, MED families, Kratos SubModelParts) and point/cell/field data array names the source file declares — from `meshioService.ts`'s `readMeshioMetadata()` (a cheap `readMetadata()` call, computed alongside `convertToStlBoundary()` via `Promise.all`, best-effort and never throwing). Omitted entirely (not an empty object) when the file declares nothing. **This is informational only — none of it is converted into Parts or any other geometry**; the webview's `case "loadMeshBytes"` handler shows it as a one-line `status` summary, posted AFTER the STL load completes so it can't race with and get clobbered by `loadMeshObjectFromUrl`'s own internal loading-status sequence. See CLAUDE.md's "meshio++ integration" section for why full auto-conversion into Parts is real, larger future work (a de-risked mechanism is documented there for whoever picks it up next).

```json
{
  "type": "loadMeshBytes",
  "sourceFormat": "vtk",
  "dataBase64": "c29saWQgeA0K...",
  "meshioMetadata": {
    "regions": [{ "name": "MaterialA", "kind": "cell", "numEntries": 1 }],
    "pointDataNames": ["Temperature"],
    "cellDataNames": [],
    "fieldDataNames": []
  }
}
```

### `parts`

Sent after geometry, once the host has read the parts sidecar (`<model>.parts.json`). Carries the saved part definitions (empty array when no sidecar exists). The webview loads them into `PartsModel`, recolours the model, and renders the Parts panel.

Also sent **unprompted, mid-session** (not just during the `ready` handshake) whenever a purely-appended, topology-changing edit triggers a successful entity-id rebind (`provider.ts`'s `rebindPartsOnAppend()` — see CLAUDE.md's "Entity-id drift" section) — the webview's handling is identical either way, since `PartsModel.load()` is a silent full replace with no `onChange` echo.

```json
{
  "type": "parts",
  "parts": [
    { "name": "Inlet", "color": "#e6194b", "volumes": ["solid-0"], "surfaces": ["face-3"], "lines": [], "points": [] }
  ]
}
```

### `edits`

Sent after geometry, once the host has read the edits sidecar (`<model>.edits.json`). Carries the saved, ordered edit op-list plus the named parametric variables (both empty arrays when no sidecar exists). The webview hydrates `EditsModel` + `VariablesModel` and renders the Edits panel. For B-rep the geometry already arrives with these ops applied (the host folds them in before tessellating); for mesh formats the webview replays them locally.

An op may carry an optional `exprs` annotation (field path → expression string, e.g. `{ "length": "L*2" }`); its numeric fields always hold the last-good evaluated numbers, so consumers that ignore `exprs` still see a fully-resolved op. See [File Formats](./file-formats.md#edits-sidecar-modeleditsjson).

```json
{
  "type": "edits",
  "ops": [
    { "op": "translate", "targets": ["solid-0"], "vec": [10, 0, 0], "exprs": { "vec[0]": "L/2" } }
  ],
  "variables": [
    { "name": "L", "expr": "20", "value": 20 }
  ]
}
```

### `editError`

Shown in the status overlay when applying an op fails (e.g. an OCCT operation throws). Distinct from `error` only by intent; both render the same way.

```json
{ "type": "editError", "message": "Boolean failed: …" }
```

### `status`

Progress text shown in the status overlay (`#status-text`). Sent at key points during B-rep loading:

- `"Loading kernel…"` — before WASM initialization
- `"Tessellating…"` — after kernel is ready, before tessellation completes

```json
{ "type": "status", "text": "Tessellating…" }
```

### `error`

Shown in the error overlay (`#error-overlay`). Sent if tessellation throws or if the file cannot be read.

```json
{ "type": "error", "message": "Failed to parse STEP file: …" }
```

### `exportMesh`

Sent when the user picks a mesh-format export target (STL/OBJ/PLY/glTF) in the host's quick-pick. Only mesh targets round-trip through the webview — B-rep targets (STEP/IGES/BREP) are written entirely in the host via OCCT, with no webview involvement. The webview serializes the currently displayed `THREE.Object3D` with the matching exporter from `three/examples/jsm/exporters/` and replies with `exportResult`/`exportError`. `unit` (optional, `DisplayUnit = 'mm'|'cm'|'m'|'in'|'ft'` from `src/lengthUnits.ts`, `undefined`/`'mm'` = no-op) is the export-unit quick-pick's answer — a REAL geometric scale (`meshExporters.ts`'s `exportModel` clones the model root, scales it, and force-updates its world matrix before serializing), distinct from the display-unit selector (`src/webview/units.ts`), which only ever rescales what a number looks like and never reaches this message at all.

```json
{ "type": "exportMesh", "requestId": "1234-0.56", "format": "stl", "unit": "in" }
```

### `meshingOptions`

Sent once, right after `parts`, once the host has read the mesh-options sidecar (`<model>.mesh.json`). Carries the saved `MeshOptions` (`DEFAULT_MESH_OPTIONS` when no sidecar exists). The webview calls `MeshingModel.load()` (hydration only — does not echo back as a `meshingChanged` write) and renders the FE Mesh panel form.

```json
{
  "type": "meshingOptions",
  "options": { "dimension": 3, "sizeMin": 0, "sizeMax": 1e22, "algorithm2D": 6, "algorithm3D": 1, "elementOrder": 1, "elementShape": "simplex", "optimize": true, "stlAngle": 40 }
}
```

### `meshingResult`

Sent in reply to `meshingGenerate` (and internally by `meshingExport` when the target is `"msh"`) on a successful GMSH run. `positions`/`indices`/`edges` are the base64 `Float32Array`/`Uint32Array` boundary triangulation + true element-edge line buffer, encoded exactly like `EncodedMesh`'s buffers — for a 3D mesh `indices` is the tetrahedra's boundary faces derived host-side, not the tetrahedra themselves. `nodeCount`/`elementCount` are the full node/element counts (not just the displayed boundary triangle count), and `elapsedMs` is the wall-clock duration of the generate call. `elementGroups` partitions `indices` into contiguous per-part runs (`{name, color, indexStart, indexCount}`, with a trailing `name`/`color` = `null` run for triangles not claimed by any part) so the overlay can be built multi-material with per-part colours. The webview calls `viewer.setMeshOverlay(buildFEMesh(msg.positions, msg.indices, msg.edges, msg.elementGroups))` and renders the stats (counts + time) in the panel's status line. `quality` (optional — omitted if it couldn't be computed, e.g. a 1D mesh) is a `{min, mean, histogram}` summary over the mesh's top-dimension elements' `minSICN` quality (via Gmsh's own `getElementQualities` — see `src/gmshService.ts`'s `computeQualityAndWorstElements` for the verified call shape), rendered as a small min/mean line + bar histogram below the FE Mesh panel's status line.

`worstElements` (optional — only ever present for a **3D** generate with at least one element below `threshold`) is a highlight overlay of the mesh's worst-quality elements: `indices` is those elements' own full boundary, ready to index into the SAME `positions` buffer `meshingResult.indices` uses. The webview calls `viewer.setWorstElementsOverlay(buildWorstElementsHighlight(msg.positions, msg.worstElements.indices))`, rendered with a depth-test-disabled "ghost" material (mirroring the Hidden Lines display mode's ghost-line technique) so it stays visible through occluding geometry regardless of true 3D depth — closing the roadmap gap where bad tets are frequently interior and invisible in the boundary-only overlay above. `shownCount`/`belowThresholdCount` differ only when the highlight was capped (`MAX_WORST_ELEMENTS`, prioritizing the lowest-quality elements first); the panel reports both, e.g. "showing worst 2000 of 5300".

```json
{
  "type": "meshingResult", "positions": "AAAA...", "indices": "BBBB...", "edges": "CCCC...",
  "nodeCount": 421, "elementCount": 1893,
  "elementGroups": [
    { "name": "inlet", "color": "#ff0000", "indexStart": 0, "indexCount": 264 },
    { "name": null, "color": null, "indexStart": 264, "indexCount": 5412 }
  ],
  "elapsedMs": 3217,
  "quality": { "min": 0.043, "mean": 0.71, "histogram": [1, 3, 8, 20, 45, 90, 210, 340, 180, 62] },
  "worstElements": { "indices": "DDDD...", "threshold": 0.2, "shownCount": 42, "belowThresholdCount": 42 }
}
```

### `meshingError`

Sent in reply to `meshingGenerate`/`meshingExport` when GMSH throws or the document has no mesh geometry available yet (e.g. a mesh-format document before the webview has produced an STL snapshot). Rendered as an error string in the FE Mesh panel's status line — it does not use the general `#error-overlay` `error` message.

```json
{ "type": "meshingError", "message": "No mesh geometry available: missing STL data." }
```

### `viewerDefaults`

Sent once, alongside `parts`/`meshingOptions` in the `ready` handshake, reading `workspace.getConfiguration("cadPreview")` (`src/viewerDefaults.ts`'s `normalizeViewerDefaults` is the tolerance gate — same clamp-per-field style as `validateMeshOptions`). Arrives in no deterministic order relative to `geometry`/`loadUrl` (B-rep tessellation is async), so the webview's handler must tolerate either order — `background`/`showGridAndAxes` apply immediately (scene-level), `upAxis` is stored and applied at the next `Viewer.setModel()` call, and `meshSizePreset` feeds the same bbox-derived seed `syncMeshSizeSeed()` already computes. These are cross-document **defaults only** — a persisted per-document `.mesh.json` value or the toolbar Grid toggle always wins once set.

```json
{ "type": "viewerDefaults", "background": "#1e1e1e", "meshSizePreset": "medium", "showGridAndAxes": true, "upAxis": "y" }
```

### `screenshotRequest`

Sent in reply to `screenshotButtonClicked` or the `cad-preview.screenshot` command, mirroring `exportMesh`'s request/response shape exactly (same `pending` map, same `requestId` correlation) — just with the format fixed to PNG, so there's no `format` field. The webview force-renders a fresh frame (`Viewer.render()`, avoiding a persistent `preserveDrawingBuffer`) then reads `renderer.domElement.toDataURL("image/png")`, replying with `screenshotResult`/`screenshotError`.

```json
{ "type": "screenshotRequest", "requestId": "1234-0.56" }
```

### `massPropertiesResult` / `massPropertiesError`

Sent in reply to `massPropertiesRequest` — **B-rep sources only**; mesh sources compute `MassProperties` entirely client-side and never send this request at all (no host round trip, since there's no OCCT shape to query). `properties.volume` is only ever non-`null` for the whole model or a `solid-N`; a `face-N` gets `area` only, an `edge-N` gets `length` only. See [Extension Host API](./extension-host-api.md#src-massproperties-ts)'s verified `BRepGProp` call sequence.

```json
{ "type": "massPropertiesResult", "requestId": "1234-0.56", "properties": { "volume": 24, "area": 52, "length": null, "centerOfMass": [1, 1.5, 2], "momentsOfInertia": { "ixx": 50, "iyy": 40, "izz": 26, "ixy": 0, "ixz": 0, "iyz": 0 } } }
```

```json
{ "type": "massPropertiesError", "requestId": "1234-0.56", "message": "Unknown entity id: solid-9" }
```

### `measureExactResult` / `measureExactError`

Sent in reply to `measureExactRequest` — **B-rep sources only**, same gate as `massPropertiesResult`. A genuine host round trip via live OCCT geometry (`BRepExtrema_DistShapeShape` for `kind: "distance"`, `BRepGProp` for `"edgeLength"`, the edge's own curve for `"radius"`), distinct from both the interactive Measure tool's default instant triangulated-approximation result and `measure`'s bbox-centre-to-bbox-centre convention. See [Extension Host API](./extension-host-api.md#src-entityfacts-ts)'s verified call sequence for each `kind`.

```json
{ "type": "measureExactResult", "requestId": "1234-0.56", "result": { "kind": "distance", "value": 83.305, "fromPoint": [0.5, 0.5, 0.5], "toPoint": [47.88, 47.88, 50] } }
```

```json
{ "type": "measureExactError", "requestId": "1234-0.56", "message": "This edge is not a circular arc — radius is only defined for circular edges" }
```

---

## Webview → Host Messages (`WebviewToHost`)

```typescript
type WebviewToHost =
  | { type: 'ready' }
  | { type: 'log'; message: string }
  | { type: 'partsChanged'; parts: Part[] }
  | { type: 'editsChanged'; ops: EditOp[]; variables: ParamVariable[] }
  | { type: 'openFile' }
  | { type: 'openPath'; path: string }
  | { type: 'saveSidecars' }
  | { type: 'exportRequest' }
  | { type: 'exportResult'; requestId: string; data: string; binary: boolean }
  | { type: 'exportError'; requestId: string; message: string }
  | { type: 'meshingChanged'; options: MeshOptions }
  | { type: 'meshingGenerate'; options: MeshOptions; stl?: string }
  | { type: 'meshingExport'; target: MeshExportFormatId; options: MeshOptions; stl?: string; unit?: DisplayUnit }
  | { type: 'screenshotButtonClicked' }
  | { type: 'screenshotResult'; requestId: string; data: string }
  | { type: 'screenshotError'; requestId: string; message: string }
  | { type: 'massPropertiesRequest'; requestId: string; entityId: string | null }
  | { type: 'measureExactRequest'; requestId: string; kind: ExactMeasureKind; entityIdA: string; entityIdB?: string }
```

### `partsChanged`

Sent whenever the user mutates parts (create / rename / recolour / delete / assign / remove entity). The host debounces these (~500 ms) and writes the full part list to the `<model>.parts.json` sidecar via `writeParts()`. The CAD file itself is never written — only the sidecar.

```json
{ "type": "partsChanged", "parts": [ { "name": "Inlet", "color": "#e6194b", "volumes": ["solid-0"], "surfaces": [], "lines": [], "points": [] } ] }
```

### `editsChanged`

Sent whenever the user mutates the edit op-stack (apply / undo / redo / clear) **or the parametric variables** (add / rename / change expression / delete — which re-resolves every op's `exprs` and so changes the displayed geometry). Carries the full ordered op-list plus the full variables list. The ops arrive **already resolved** against the variables (the webview resolves on read — see `src/editVariables.ts` `resolveEditOps`), so the host never evaluates expressions at runtime; the numeric fields are the current values and `exprs` rides along for persistence. The host debounces these (~500 ms, on a separate timer from `partsChanged`) and writes both to the `<model>.edits.json` sidecar via `writeEdits()`. For B-rep sources the host also re-tessellates immediately with the new ops and pushes a fresh `geometry` + `tree`; for mesh sources the webview has already replayed the ops locally, so the host only persists. The CAD file is never written — only the sidecar. See [`EditOp`](#editop) for op shapes.

```json
{
  "type": "editsChanged",
  "ops": [ { "op": "translate", "targets": ["solid-0"], "vec": [10, 0, 0], "exprs": { "vec[0]": "L/2" } } ],
  "variables": [ { "name": "L", "expr": "20", "value": 20 } ]
}
```

### `meshingChanged`

Sent whenever the user changes a mesh-options form control in the FE Mesh panel. Carries the full current `MeshOptions`. The host debounces these (~500 ms, on its own timer separate from parts/edits) and writes **two** files on the same tick: `<model>.mesh.json` via `writeMeshOptions()` and the regenerated `<model>.geo` script via `writeGeoScript()`. Neither generating nor changing options re-runs GMSH by itself — that only happens on `meshingGenerate`/`meshingExport`. See [GMSH Integration](./gmsh-integration.md).

```json
{ "type": "meshingChanged", "options": { "dimension": 3, "sizeMin": 0, "sizeMax": 1e22, "algorithm2D": 6, "algorithm3D": 1, "elementOrder": 1, "optimize": true, "stlAngle": 40 } }
```

### `meshingGenerate`

Sent when the user clicks **▶ Generate** in the FE Mesh panel. Carries the current `MeshOptions` and, for a mesh-format document only, a base64 `stl` field — a fresh snapshot of the currently displayed `THREE.Object3D`, serialized in the webview via the same `exportModel(..., "stl")` helper Export already uses (the host has no B-rep to re-export for a mesh-sourced document, so it has no other way to obtain triangulated geometry for GMSH). B-rep documents omit `stl`; the host re-exports the live OCCT shape to STEP itself. The host replies with `meshingResult` or `meshingError`.

```json
{ "type": "meshingGenerate", "options": { "dimension": 3, "sizeMin": 0, "sizeMax": 1e22, "algorithm2D": 6, "algorithm3D": 1, "elementOrder": 1, "optimize": true, "stlAngle": 40 } }
```

### `meshingExport`

Sent when the user picks a format in the FE Mesh panel's export `<select>` and clicks **📤 Export**. `target` is a `MeshExportFormatId` (see `src/meshExportFormats.ts`'s `MESH_EXPORT_FORMATS` registry, the single source of truth shared by the host and the webview's `<select>` — `"mdpaElements"` is listed first and is therefore the default-selected format) selecting which output to write: `"msh"` runs `generateMesh` and saves the raw `.msh` text; `"geoUnrolled"` calls `exportGeoUnrolled` and saves the `.geo_unrolled` text (handling its XAO companion, see below); `"mdpaElements"`/`"mdpaGeometries"` run `exportMdpa`, a hand-written Kratos MDPA serializer with no `gmsh.write()` involved at all (see `doc/gmsh-integration.md`'s "Kratos MDPA" section); every other id (`"msh2"`, `"vtk"`, `"unv"`, `"inp"`, `"bdf"`, `"su2"`, `"mesh"`, `"stl"`, `"diff"`, `"off"`) runs `exportMeshFormat`, a generic mesh-then-`gmsh.write()` for whatever other Gmsh output formats this WASM build actually supports (confirmed by probing every format Gmsh's writer table recognizes — see `doc/gmsh-integration.md`). Same `options`/optional `stl` payload as `meshingGenerate`, plus an optional `unit` (`DisplayUnit`, default `"mm"`) from the panel's `#meshing-export-unit` `<select>` — a REAL geometric scale applied to the geometry before Gmsh ever sees it (B-rep sources via `exportBRep`'s `scaleFactor`, mesh-format sources via the new `scaleStlBytes`), with `MeshOptions.sizeMin`/`sizeMax` and any per-part `meshSize` proportionally rescaled to match (`scaleMeshOptionsForUnit`/ `scalePartsMeshSizeForUnit`, `src/meshOptions.ts`) — see CLAUDE.md's Meshing section for the full write-up. `unit` is scoped to this message only: `meshingGenerate` always meshes at native mm, since its overlay is display-only with no exported file whose numbers need to mean anything externally. The host prompts a save dialog (reusing the same `promptSaveAndWrite` helper Export uses) and writes the result directly — there is no `meshingResult` reply for this message; failures post the general `error` message instead of `meshingError`.

```json
{ "type": "meshingExport", "target": "geoUnrolled", "options": { "dimension": 3, "sizeMin": 0, "sizeMax": 1e22, "algorithm2D": 6, "algorithm3D": 1, "elementOrder": 1, "optimize": true, "stlAngle": 40 }, "unit": "in" }
```

### `ready`

Sent by the webview when its JavaScript has fully initialized (at the end of `main.ts`). The host waits for this before sending any geometry or URL. This handshake ensures the message listener is registered before messages arrive.

```json
{ "type": "ready" }
```

### `log`

Sent by the webview for diagnostic messages. The host writes them to the VS Code output channel (if one is wired up).

```json
{ "type": "log", "message": "Model loaded: 3 solids, 47,000 triangles" }
```

### `openFile`

Sent when the user picks **File ▸ Open…** in the top menu bar. The host shows an open dialog (filtered to the supported CAD/mesh extensions) and hands the chosen file to this custom editor via `vscode.openWith`. The same action backs the `cad-preview.open` command (Ctrl+O). Nothing is sent back to the webview.

```json
{ "type": "openFile" }
```

### `openPath`

Sent when a file is dropped onto the viewer canvas AND the browser `File` object exposed a real filesystem path (`file.path` — a legacy Electron extension to the standard `File` object, not guaranteed present in every VS Code/Electron version). The host opens it the same way `openFile` does (`vscode.openWith`), just from an already-known path instead of a fresh dialog. **Fallback**: when no path is exposed on drop, the webview posts the plain `openFile` message instead (opens the normal dialog) — drag-and-drop degrades to "just opens a dialog" rather than silently failing.

```json
{ "type": "openPath", "path": "/home/user/models/bull.stp" }
```

### `saveSidecars`

Sent when the user picks **File ▸ Save** in the top menu bar. The CAD file is read-only and never written; this forces an immediate flush of the `<model>.parts.json` / `<model>.edits.json` / `<model>.mesh.json` (+ `.geo`) sidecars, bypassing the ~500 ms autosave debounce, and replies with a `status` message (`"Saved"`) on success or `error` on failure. The same action backs the `cad-preview.save` command (Ctrl+S).

```json
{ "type": "saveSidecars" }
```

### `exportRequest`

Sent when the user picks **File ▸ Save As… / Export…** in the top menu bar (or triggers the `cad-preview.saveAs` / `cad-preview.export` command / Ctrl+Shift+S / Ctrl+E). The host computes the compatible target formats for the open document (`exportTargetsFor()` in `src/exportTargets.ts`), shows a quick-pick and a save dialog, then either writes the file itself (B-rep targets) or follows up with `exportMesh` (mesh targets).

```json
{ "type": "exportRequest" }
```

### `exportResult` / `exportError`

Sent in reply to `exportMesh`. `data` is base64 when `binary` is `true`, plain text otherwise — the same convention as `EncodedMesh`'s buffers, just generalized to a whole file. The host correlates the reply to its pending request via `requestId` and writes the decoded bytes to the path chosen in the save dialog.

```json
{ "type": "exportResult", "requestId": "1234-0.56", "data": "AAAA...", "binary": true }
```

```json
{ "type": "exportError", "requestId": "1234-0.56", "message": "No model loaded" }
```

### `screenshotButtonClicked`

Sent when the toolbar's **📷 Screenshot** button is clicked — the webview-initiated trigger for the same `handleScreenshot` flow the `cad-preview.screenshot` command drives, so there is exactly one code path regardless of trigger surface. The host prompts a save dialog and follows up with `screenshotRequest`.

```json
{ "type": "screenshotButtonClicked" }
```

### `screenshotResult` / `screenshotError`

Sent in reply to `screenshotRequest`. `data` is always base64 PNG bytes (no `binary` field — unlike `exportResult`, the format is never anything else). Correlated to the pending save via `requestId`, same as `exportResult`.

```json
{ "type": "screenshotResult", "requestId": "1234-0.56", "data": "iVBORw0KGgo..." }
```

```json
{ "type": "screenshotError", "requestId": "1234-0.56", "message": "No model loaded" }
```

### `massPropertiesRequest`

Sent when the Mass Properties panel's **Compute** button is clicked, for a B-rep source only (mesh sources never send this — see `massPropertiesResult` above). `entityId` is `null` for the whole model, or the current selection's single entity id (`solid-N` / `face-N` / `edge-N`) — the panel refuses to guess when 2+ entities are selected, showing a guidance message instead of sending a request.

```json
{ "type": "massPropertiesRequest", "requestId": "1234-0.56", "entityId": "solid-0" }
```

### `measureExactRequest`

Sent when the Measure panel's **⟳ Exact** button is clicked, for a B-rep source only (mesh sources never send this — the button never appears; see `measureExactResult` above). `kind` mirrors the current measurement tool (`"distance"`/`"edgeLength"`/`"radius"` — never `"angle"`, which has no button at all); `entityIdA`/`entityIdB` are the completed measurement's picked entity ids (`entityIdB` only for `kind: "distance"`).

```json
{ "type": "measureExactRequest", "requestId": "1234-0.56", "kind": "distance", "entityIdA": "solid-0", "entityIdB": "solid-1" }
```

---

## Timing Diagram

### B-rep File (STEP/IGES/BREP)

```
Host                                    Webview
 │                                         │
 │  sets webview.html                      │
 │  ────────────────────────────────────▶  │  (JS evaluates, Viewer/TreePanel init)
 │                                         │
 │  ◀── { type: "ready" } ────────────────  │
 │                                         │
 │  post { type: "status", "Loading…" }    │
 │  ────────────────────────────────────▶  │  (show spinner)
 │                                         │
 │  [WASM init + file parse + tessellate]  │
 │                                         │
 │  post { type: "status", "Tessellating…"}│
 │  ────────────────────────────────────▶  │
 │                                         │
 │  post { type: "geometry", meshes: […] } │
 │  ────────────────────────────────────▶  │  buildGroupFromEncoded() → setModel()
 │                                         │
 │  post { type: "tree", root: {…} }       │
 │  ────────────────────────────────────▶  │  TreePanel.render()
```

### Mesh File (STL/OBJ/PLY/glTF)

```
Host                                    Webview
 │                                         │
 │  sets webview.html                      │
 │  ────────────────────────────────────▶  │
 │                                         │
 │  ◀── { type: "ready" } ────────────────  │
 │                                         │
 │  post { type: "loadUrl", url, format }  │
 │  ────────────────────────────────────▶  │  loadMeshFromUrl() → setModel()
 │                                         │  extractObjectTree() → TreePanel.render()
```

### Export (mesh target, e.g. STL/OBJ/PLY/glTF)

```
Host                                    Webview
 │                                         │
 │  ◀── { type: "exportRequest" } ────────  │  (File ▸ Export / Save As chosen)
 │                                         │
 │  [showQuickPick + showSaveDialog]       │
 │                                         │
 │  post { type: "exportMesh", … }         │
 │  ────────────────────────────────────▶  │  exportModel() via Three.js exporter
 │                                         │
 │  ◀── { type: "exportResult", … } ──────  │
 │                                         │
 │  [decode + workspace.fs.writeFile]      │
```

B-rep targets (STEP/IGES/BREP) skip the `exportMesh` round-trip entirely — the host re-reads the source file and writes the target format directly via `exportBRep()` in `src/occtService.ts`.

---

## Buffer Encoding

### Host side (`src/protocol.ts`)

```typescript
export function encodeBuffer(arr: Float32Array | Uint32Array): string {
  return Buffer.from(arr.buffer).toString('base64')
}
```

Uses Node.js `Buffer` (not available in the webview).

### Webview side (`src/webview/geometryBuilder.ts`)

```typescript
function decodeF32(b64: string): Float32Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Float32Array(bytes.buffer)
}

function decodeU32(b64: string): Uint32Array {
  // same pattern, Uint32Array view
}
```

Uses browser `atob` (not available in Node.js).
