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
  smooth: boolean      // tangent patch-seam continuation, not a real feature edge
}
```

One per **unique edge** (B-rep), discretized to a polyline. Shared edges are de-duplicated host-side; `edgeId` is stable across reopen of an unchanged file. `smooth` (roadmap "Display-edge classification, as a flag", closed) flags a tangent continuation between two faces — e.g. a NURBS-patch seam on what's conceptually one curved surface — via a dihedral-angle test between the two adjacent faces' surface normals at the shared edge (`src/edgeEnumeration.ts`'s `classifyEdgeSmoothness`); it is pure display metadata, never a filter — dropping an edge server-side would renumber every later `edge-N` id. The webview's "Hide smooth edges" toggle (View ▾ menu) is the only consumer.

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

### `Annotation`

```typescript
type MeasureTool = 'distance' | 'edgeLength' | 'angle' | 'radius'

interface Annotation {
  id: string
  tool: MeasureTool
  label?: string
  text: string                              // frozen readout, e.g. "12.5 mm"
  anchorPoint: [number, number, number]     // frozen world-space label position
  linePoints: [number, number, number][]    // frozen world-space overlay line points (0 or 2)
  volumes: string[]
  surfaces: string[]
  lines: string[]
  points: string[]
}
```

A persisted, topology-anchored measurement (roadmap "Persisted, topology-anchored annotations", closed) — a "pinned" result from the interactive Measure tool that survives closing the file, unlike the tool's own session-only overlay. Structurally shaped like `Part` (same four `EntityType`-keyed id buckets) so it can be rebound across topology-changing edits with the identical machinery `Part` already uses — see `src/entityRebind.ts`'s `remapPartEntityIds`. `text`/`anchorPoint`/`linePoints` are a frozen snapshot of the result at pin time, never recomputed on redisplay; only "detached" (none of its anchor ids currently resolve in the loaded model) is computed live, in the webview. Persisted in `<model>.annotations.json` — see [File Formats](./file-formats.md).

### `ViewState`

```typescript
type DisplayMode = 'shaded' | 'wireframe' | 'xray' | 'hiddenLines' | 'flat'
type ClipAxis = 'x' | 'y' | 'z'

interface ViewState {
  viewDirection: [number, number, number]   // target → camera, normalized
  cameraUp: [number, number, number]
  orthographic: boolean
  displayMode: DisplayMode
  clip: { axis: ClipAxis; offsetFrac: number } | null   // null = clipping off; offsetFrac is a fraction of the model's bbox, not a raw plane constant
}
```

Persisted camera orientation, display mode, ortho/perspective, and clip plane (roadmap "View-state persistence", closed) — see [File Formats](./file-formats.md) for the `<model>.view.json` sidecar. Deliberately does **not** include explode-preview state (session-only by design) or raw camera position/target/distance: `Viewer.frame(direction)` auto-derives both from the model's current bounding box, so a normalized direction + up vector is enough and survives edits that change the model's extents.

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

interface ComponentHealthReport {   // src/meshHeal.ts — one per connected component
  index: number
  triangleCount: number
  freeEdgeCount: number
  nonManifoldEdgeCount: number
  degenerateFaceCount: number
  rawArea: number
  rawVolume: number
  requiredTolerance: number | null   // the sewing-tolerance-ladder rung that closed it; null if it never closed
  healedArea: number | null          // null unless requiredTolerance is set
  healedVolume: number | null
  areaDeltaPct: number | null
  volumeDeltaPct: number | null
}

interface MeshHealthReport {
  componentCount: number
  components: ComponentHealthReport[]
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
      regionAssignment?: { regionNames: string[]; triangleRegionIndex: string }
    }
  | { type: 'parts';    parts: Part[] }
  | { type: 'annotations'; annotations: Annotation[] }
  | { type: 'edits';    ops: EditOp[]; variables: ParamVariable[] }
  | { type: 'status';   text: string }
  | { type: 'error';    message: string }
  | { type: 'editError'; message: string }
  | { type: 'exportMesh'; requestId: string; format: CadFormat; unit?: DisplayUnit }
  | { type: 'meshingOptions'; options: MeshOptions }
  | { type: 'viewState'; view: ViewState | null }
  | { type: 'meshingResult'; positions: string; indices: string; edges: string; nodeCount: number; elementCount: number;
      elementGroups: MeshElementGroup[]; elapsedMs: number; quality?: QualitySummary; worstElements?: WorstElementsMsg }
  | { type: 'meshingError'; message: string }
  | ({ type: 'viewerDefaults' } & ViewerDefaults)
  | { type: 'screenshotRequest'; requestId: string }
  | { type: 'standardPartsSearchResult'; requestId: string; items: StandardPart[]; page: number; totalPages: number; total: number }
  | { type: 'standardPartsSearchError'; requestId: string; message: string }
  | { type: 'standardPartsInsertResult'; requestId: string; path: string | null }
  | { type: 'standardPartsInsertError'; requestId: string; message: string }
  | { type: 'importSvgResult'; text: string }
  | { type: 'importSvgError'; message: string }
  | { type: 'massPropertiesResult'; requestId: string; properties: MassProperties }
  | { type: 'massPropertiesError'; requestId: string; message: string }
  | { type: 'measureExactResult'; requestId: string; result: ExactMeasureResult }
  | { type: 'measureExactError'; requestId: string; message: string }
  | { type: 'meshHealResult'; requestId: string; report: MeshHealthReport }
  | { type: 'meshHealError'; requestId: string; message: string }
  | { type: 'colorFieldResult'; requestId: string; values: string; min: number; max: number }
  | { type: 'colorFieldError'; requestId: string; message: string }
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
    { "positions": "CCCC...", "edgeId": "edge-0", "smooth": false }
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

An optional `meshioMetadata` carries **read-only visibility** into named regions (gmsh physical groups, Abaqus NSET/ELSET/SURFACE, Exodus blocks/sets, MED families, Kratos SubModelParts) and point/cell/field data array names the source file declares — from `meshioService.ts`'s `readMeshioMetadata()` (a cheap `readMetadata()` call, best-effort and never throwing). Omitted entirely (not an empty object) when the file declares nothing. Point/cell/field *data arrays* are always informational only — none of their values are converted into anything. Region *names*, though, may now be more than informational: see `regionAssignment` below.

An optional `regionAssignment` (`regionNames: string[]` + a base64 `Int32Array` `triangleRegionIndex`, one entry per triangle in `dataBase64`) is present whenever `src/meshioService.ts`'s `convertToStlBoundaryWithRegions()` could correlate the source's `kind: "cell"` regions to the STL boundary triangles above (currently: pure-triangle boundaries only, e.g. a tetrahedral volume mesh — see CLAUDE.md's "meshio++ integration" section for the full gate and mechanism). Sent on **every** open where correlation succeeds, not only the one that first creates Parts from it: the webview's `splitMeshesIntoFacets` needs it every time to reproduce the identical region-aware facet split those `node-0/face-K` ids were computed against (`triangleRegionIndex[t]` is an index into `regionNames`, or `-1` for a triangle not covered by any region), or a reopen's Parts would stop resolving to real facets. `provider.ts`'s `handleMeshio()` also owns the whole `parts` round trip for this route (see the `parts` message below) — when the parts sidecar is still empty on a fresh import, it auto-creates one Part per correlated region (`src/meshioRegionParts.ts`'s `buildPartsFromMeshioRegions`) and persists it immediately, before ever posting anything to the webview.

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
  },
  "regionAssignment": {
    "regionNames": ["MaterialA", "MaterialB"],
    "triangleRegionIndex": "AAAAAA=="
  }
}
```

### `parts`

Sent after geometry, once the host has read the parts sidecar (`<model>.parts.json`). Carries the saved part definitions (empty array when no sidecar exists). The webview loads them into `PartsModel`, recolours the model, and renders the Parts panel.

Also sent **unprompted, mid-session** (not just during the `ready` handshake) whenever a purely-appended, topology-changing edit triggers a successful entity-id rebind (`provider.ts`'s `rebindPartsOnAppend()` — see CLAUDE.md's "Entity-id drift" section) — the webview's handling is identical either way, since `PartsModel.load()` is a silent full replace with no `onChange` echo.

For a meshio route specifically, `handleMeshio()` sends this message itself (right after `loadMeshBytes`, same synchronous function, so ordering relative to it is guaranteed) instead of the generic sidecar-read path every other route uses — because it may first need to auto-create Parts from `regionAssignment`'s correlation (see `loadMeshBytes` above) before there's anything to send.

```json
{
  "type": "parts",
  "parts": [
    { "name": "Inlet", "color": "#e6194b", "volumes": ["solid-0"], "surfaces": ["face-3"], "lines": [], "points": [] }
  ]
}
```

### `annotations`

Sent after geometry, once the host has read the annotations sidecar (`<model>.annotations.json`) — same timing/role as `parts` (roadmap "Persisted, topology-anchored annotations", closed). Carries the saved pinned measurements (empty array when no sidecar exists). The webview loads them into `AnnotationsModel` (silent `load()`, no `onChange` echo) and renders the "Saved" list in the Measure ▾ panel.

Also sent **unprompted, mid-session** whenever a topology-changing edit triggers a successful entity-id rebind of an existing annotation — the same `rebindPartsOnChange()` that resends `parts` for this reason now resends `annotations` too, reusing the identical shape-diff pass (`src/entityFacts.ts`'s `rebindPartsAcrossOps`).

```json
{
  "type": "annotations",
  "annotations": [
    {
      "id": "ann-1234567890-1",
      "tool": "distance",
      "text": "12.5 mm",
      "anchorPoint": [5, 0, 0],
      "linePoints": [[0, 0, 0], [10, 0, 0]],
      "volumes": [], "surfaces": ["face-1", "face-4"], "lines": [], "points": []
    }
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

### `viewState`

Sent once during the `ready` handshake, right after `meshingOptions`, once the host has read the view-state sidecar (`<model>.view.json`) — `view` is `null` when no sidecar exists yet for this document (a genuinely new document, or one never manually reoriented). Also re-sent by the external-change watcher on `.view.json` when another process (an MCP agent, a second tab on the same file) writes it. The webview applies it once BOTH this message and the model geometry (`geometry`/mesh load) have arrived — no deterministic order between the two, same non-deterministic-arrival-order discipline as `viewerDefaults`/`meshingOptions` vs. `geometry` — via `main.ts`'s `applyInitialViewIfNeeded()`, which mirrors `syncMeshSizeSeed()`'s "whichever lands last performs the actual application" idiom. `view: null` applies the default hardcoded isometric (`Viewer.resetView()`) instead. Applied only ONCE per document session: every subsequent model reload (an edit re-tessellating a B-rep source, a mesh edit rebuilding the displayed model) preserves the CURRENT camera direction (`Viewer.fitView()`) rather than re-snapping to the persisted state — camera position used to unconditionally reset on every one of those too, a bigger, more-repeated friction than "resets on reopen" alone.

```json
{ "type": "viewState", "view": { "viewDirection": [1, 0.8, 1], "cameraUp": [0, 1, 0], "orthographic": false, "displayMode": "shaded", "clip": null } }
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

### `meshHealResult` / `meshHealError`

Sent in reply to `meshHealRequest` (webview → host, below) — roadmap "Mesh → B-rep promotion, diagnostic-first", Phase 1 (read-only report, no promotion). `report` is a `MeshHealthReport` (`src/meshHeal.ts`): one `ComponentHealthReport` per connected component, each carrying free/non-manifold edge counts, degenerate face count, the sewing-tolerance-ladder rung actually required to close (`null` if it never closed), and the healed area/volume delta if it did. **STL/OBJ/PLY sources only** — a B-rep source has nothing to heal and a meshio-converted/glTF source has no matching host-side parser; the panel hides itself rather than ever sending this request in either case (see `src/webview/meshHealthPanel.ts`).

```json
{ "type": "meshHealResult", "requestId": "1234-0.56", "report": { "componentCount": 1, "components": [{ "index": 0, "triangleCount": 12, "freeEdgeCount": 0, "nonManifoldEdgeCount": 0, "degenerateFaceCount": 0, "rawArea": 600, "rawVolume": 1000, "requiredTolerance": 0.000001, "healedArea": 600, "healedVolume": 1000, "areaDeltaPct": 0, "volumeDeltaPct": 0 }] } }
```

```json
{ "type": "meshHealError", "requestId": "1234-0.56", "message": "Mesh healability check requires an STL/OBJ/PLY source." }
```

### `colorFieldResult` / `colorFieldError`

Sent in reply to `colorFieldRequest` (webview → host, below) — **meshio++-imported sources only** (`src/meshioService.ts`'s `readMeshioFieldValues`, called from `provider.ts`'s new `colorFieldRequest` handler). `values` is a base64 `Float32Array`, one entry per triangle CORNER in the SAME order as the currently-loaded model's own triangle soup (i.e. `pristineMesh`'s position attribute) — the webview builds a vertex-coloured overlay directly from it with no further reordering (`src/webview/geometryBuilder.ts`'s `buildColorFieldOverlay`). `min`/`max` seed the legend's gradient bar and are NOT length-dimensioned (no unit conversion/suffix — unlike `measureExactResult`, a scalar field like temperature or stress has no length unit to convert).

```json
{ "type": "colorFieldResult", "requestId": "1234-0.56", "values": "AACAPwAAAEA...", "min": 1, "max": 5 }
```

```json
{ "type": "colorFieldError", "requestId": "1234-0.56", "message": "Field \"Pressure\" not found, not a plain scalar, or the boundary isn't pure triangles." }
```

### `standardPartsSearchResult` / `standardPartsSearchError`

Sent in reply to `standardPartsSearchRequest` (webview → host, below). `items` is the raw `StandardPart[]` page returned by the hosted [step.parts](https://www.step.parts) REST API (`src/stepPartsService.ts`'s `searchStandardParts` — this extension's only external network dependency); `page`/`totalPages`/`total` mirror the API's own pagination fields. A network/API failure (unreachable host, non-2xx response, timeout) is reported through `standardPartsSearchError`, never a thrown exception — the same `{available: false, reason}` semantics `search_standard_parts`'s MCP tool already uses, just routed through postMessage instead of a JSON-RPC response.

```json
{ "type": "standardPartsSearchResult", "requestId": "1234-0.56", "items": [{ "id": "iso-4762-m6x20", "name": "ISO 4762 Hex Socket Head Cap Screw M6x20", "description": "...", "category": "Fasteners", "standard": { "body": "ISO", "number": "4762", "designation": "ISO 4762" }, "stepUrl": "https://media.githubusercontent.com/...", "sha256": "..." }], "page": 1, "totalPages": 3, "total": 27 }
```

```json
{ "type": "standardPartsSearchError", "requestId": "1234-0.56", "message": "step.parts is unreachable (timed out after 10s)." }
```

### `standardPartsInsertResult` / `standardPartsInsertError`

Sent in reply to `standardPartsInsertRequest` (webview → host, below), after `provider.ts` downloads the chosen part's STEP file (`downloadStandardPart`, verifying its checksum when the catalog records one), shows a Save dialog defaulting to `<part-id>.step`/`.stp` next to the currently open document, writes the bytes, and opens the result as a new tab via `vscode.openWith`. `path: null` means the user dismissed the Save dialog — a quiet no-op the webview treats as "re-enable the Insert button", not an error (this case never goes through `standardPartsInsertError`).

```json
{ "type": "standardPartsInsertResult", "requestId": "1234-0.56", "path": "/home/user/project/iso-4762-m6x20.step" }
```

```json
{ "type": "standardPartsInsertError", "requestId": "1234-0.56", "message": "Download failed: checksum mismatch — the downloaded bytes do NOT match the catalog's recorded sha256." }
```

### `importSvgResult` / `importSvgError`

Sent in reply to `importSvgRequest` (webview → host, below) — no `requestId`, unlike every other request/response pair on this page: `vscode.window.showOpenDialog` is modal, so at most one import can plausibly be in flight, leaving nothing to disambiguate. `text` is the picked `.svg` file's raw UTF-8 contents, read host-side with no parsing — parsing (`src/svgImport.ts`'s `parseSvgPaths`) happens in the webview, since the resulting `addPolyline` ops need to be pushed onto `EditsModel` there anyway. A dismissed file-picker dialog is a quiet no-op (posts neither message), mirroring every other file-picker cancellation in this codebase.

```json
{ "type": "importSvgResult", "text": "<svg><path d=\"M0 0 L10 0 L10 10 Z\"/></svg>" }
```

```json
{ "type": "importSvgError", "message": "Could not read the selected file." }
```

---

## Webview → Host Messages (`WebviewToHost`)

```typescript
type WebviewToHost =
  | { type: 'ready' }
  | { type: 'log'; message: string }
  | { type: 'partsChanged'; parts: Part[] }
  | { type: 'annotationsChanged'; annotations: Annotation[] }
  | { type: 'editsChanged'; ops: EditOp[]; variables: ParamVariable[] }
  | { type: 'viewChanged'; view: ViewState }
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
  | { type: 'promoteToBrepButtonClicked' }
  | { type: 'screenshotResult'; requestId: string; data: string }
  | { type: 'screenshotError'; requestId: string; message: string }
  | { type: 'massPropertiesRequest'; requestId: string; entityId: string | null }
  | { type: 'measureExactRequest'; requestId: string; kind: ExactMeasureKind; entityIdA: string; entityIdB?: string }
  | { type: 'meshHealRequest'; requestId: string }
  | { type: 'colorFieldRequest'; requestId: string; field: string; kind: 'point' | 'cell' }
  | { type: 'standardPartsSearchRequest'; requestId: string; q: string; page?: number }
  | { type: 'standardPartsInsertRequest'; requestId: string; id: string; suggestedName: string }
  | { type: 'importSvgRequest' }
```

### `partsChanged`

Sent whenever the user mutates parts (create / rename / recolour / delete / assign / remove entity). The host debounces these (~500 ms) and writes the full part list to the `<model>.parts.json` sidecar via `writeParts()`. The CAD file itself is never written — only the sidecar.

```json
{ "type": "partsChanged", "parts": [ { "name": "Inlet", "color": "#e6194b", "volumes": ["solid-0"], "surfaces": [], "lines": [], "points": [] } ] }
```

### `annotationsChanged`

Sent whenever the user pins a new measurement (📌) or deletes/renames one from the "Saved" list. Same debounce (~500 ms, its own timer) and same never-writes-the-CAD-file rule as `partsChanged` — the host writes the full annotation list to `<model>.annotations.json` via `writeAnnotations()`.

```json
{ "type": "annotationsChanged", "annotations": [ { "id": "ann-1234567890-1", "tool": "radius", "text": "R = 4 mm", "anchorPoint": [4, 0, 0], "linePoints": [], "volumes": [], "surfaces": [], "lines": ["edge-3"], "points": [] } ] }
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

### `viewChanged`

Sent whenever the user changes the view — camera orbit/pan/zoom/dolly (drag or the stepped toolbar buttons), Fit/Reset, the orientation gizmo, the Ortho/Persp toggle, a Display mode button, or the clip axis/offset/toggle. Carries the full current `ViewState`, gathered fresh at save time (`viewer.getViewDirection()`/`getCameraUp()`/`isOrthographic()`/`getDisplayMode()` plus the clip controls' own closure state). The host debounces these (~500 ms, on its own timer separate from parts/edits/mesh) and writes `<model>.view.json` via `writeViewState()`. **Not** sent merely from opening a document, including the initial default-isometric framing or a persisted-state restoration — `main.ts` gates on its own `hasAppliedInitialView` flag, becoming true only after that one-time initial application completes, mirroring `syncMeshSizeSeed()`'s `load()`-not-`update()` "opening ≠ a user change" convention for mesh options. The CAD file is never written — only the sidecar. See [`ViewState`](#viewstate).

```json
{ "type": "viewChanged", "view": { "viewDirection": [0, 0, 1], "cameraUp": [0, 1, 0], "orthographic": true, "displayMode": "xray", "clip": { "axis": "z", "offsetFrac": -0.1 } } }
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

Sent when the user picks **File ▸ Save** in the top menu bar. The CAD file is read-only and never written; this forces an immediate flush of the `<model>.parts.json` / `<model>.annotations.json` / `<model>.edits.json` / `<model>.mesh.json` (+ `.geo`) sidecars, bypassing the ~500 ms autosave debounce, and replies with a `status` message (`"Saved"`) on success or `error` on failure. The same action backs the `cad-preview.save` command (Ctrl+S).

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

### `promoteToBrepButtonClicked`

Sent when the Mesh Health panel's **Promote to B-rep…** button is clicked ("Mesh → B-rep promotion" Phase 2) — only reachable once a report shows at least one component that closed. Unlike `screenshotButtonClicked`, there is no follow-up request message: the host runs the ENTIRE flow itself (a format quick-pick over STEP/IGES/BREP, the existing export-unit quick-pick, a save dialog, then `promoteMeshToBrep`) and reports success/failure through the plain, already-existing generic `"status"`/`"error"` messages — no new result type was needed.

```json
{ "type": "promoteToBrepButtonClicked" }
```

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

### `meshHealRequest`

Sent when the Mesh Health panel's **Check Healability** button is clicked — only reachable for a native `.stl`/`.obj`/`.ply` file on disk (a meshio-converted document or glTF hides the panel entirely, mirroring `check_mesh_health`'s own MCP-tool gate; see `meshHealResult`/`meshHealError` above). No parameters beyond `requestId` — the host re-reads the currently-open document's own bytes.

```json
{ "type": "meshHealRequest", "requestId": "1234-0.56" }
```

### `colorFieldRequest`

Sent when the view-controls "Colour by field" `<select>` changes to a non-"None" value, for a meshio++-imported source only (the group stays hidden for every other source — see `webview-api.md`). `field` is the raw array name the source file declares; `kind` is `"point"` or `"cell"` depending on which of `meshioMetadata`'s `pointDataNames`/`cellDataNames` it came from (encoded together as `"point:<name>"`/`"cell:<name>"` in the `<option>` value, split back apart client-side by a fixed-length prefix — not "split on the first colon", since a field name could itself contain one).

```json
{ "type": "colorFieldRequest", "requestId": "1234-0.56", "field": "Temperature", "kind": "point" }
```

### `standardPartsSearchRequest`

Sent when the Standard Parts panel's **Search** button is clicked (or Enter is pressed in the query field). `q` is the raw search text; `page` is omitted for a fresh search (page 1).

```json
{ "type": "standardPartsSearchRequest", "requestId": "1234-0.56", "q": "M6 hex bolt" }
```

### `standardPartsInsertRequest`

Sent when a search result's **Insert…** button is clicked. `id` is the part's catalog id (used to re-fetch its detail/`stepUrl` and download the STEP bytes host-side); `suggestedName` seeds the Save dialog's default filename.

```json
{ "type": "standardPartsInsertRequest", "requestId": "1234-0.56", "id": "iso-4762-m6x20", "suggestedName": "iso-4762-m6x20.step" }
```

### `importSvgRequest`

Sent when **File ▾ → Import SVG…** is clicked. No parameters — the host shows its own `showOpenDialog` filtered to `.svg`; see `importSvgResult`/`importSvgError` above.

```json
{ "type": "importSvgRequest" }
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
