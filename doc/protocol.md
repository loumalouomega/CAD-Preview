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

One encoded mesh per **face** (B-rep). Geometry is base64-encoded for safe
`postMessage` transport. `groupId` links the face to its solid's `TreeNode.id`;
`faceId` is the stable per-face entity id used by part assignments and picking.

### `EncodedEdge`

```typescript
interface EncodedEdge {
  positions: string   // base64-encoded Float32Array — consecutive points form a polyline
  edgeId: string      // stable per-edge entity id (e.g. "edge-12")
}
```

One per **unique edge** (B-rep), discretized to a polyline. Shared edges are
de-duplicated host-side; `edgeId` is stable across reopen of an unchanged file.

### `EncodedPoint`

```typescript
interface EncodedPoint {
  position: string   // base64-encoded Float32Array, length 3 (XYZ)
  pointId: string     // stable per-vertex entity id (e.g. "point-5")
}
```

One per **unique vertex** (B-rep) — every vertex in the shape, including the
model's own corners as well as any user-added standalone points. Unlike faces and
edges, points are never resolved as operands by another op (`addLine`/`addArc`
take typed coordinates, not point-id references), so extraction is purely for
display/picking.

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

A `Part` is a user-defined named group (FEM sub-model-part). Entity ids are the
stable topological ids above (`solid-*`, `face-*`, `edge-*`, `point-*`), or, for
mesh formats, stable per-object ids (`node-*`) for volumes/surfaces (mesh formats
have no assignable lines or points). Parts are persisted in the JSON sidecar — see
[File Formats](./file-formats.md).

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
  | { op: 'addPoint'; position: Vec3 }
  | { op: 'addLine'; start: Vec3; end: Vec3 }
  | { op: 'addArc'; center: Vec3; normal: Vec3; radius: number; startAngleDeg: number; endAngleDeg: number }
  | { op: 'addSurfaceFromLines'; edges: string[] }   // >= 3 edge ids, must close into a loop
  | { op: 'addVolumeFromSurfaces'; faces: string[] } // >= 4 face ids, must sew into a closed shell
```

An `EditOp` is one entry in the ordered, replayable edit op-list. Operands are the
same stable entity ids as parts. `validateEditOp` (`src/editOps.ts`) is the single
tolerance gate — malformed ops are dropped, never thrown. The list is persisted in
the `<model>.edits.json` sidecar — see [File Formats](./file-formats.md). All op
kinds are implemented: transforms, booleans, fillet/chamfer, feature modeling
(extrude/revolve/sweep/loft), assembly (explode/mate), primitive creation
(box/sphere/cylinder/cone/torus/prism), 2D profile sketches (circle/rectangle/
polygon, B-rep only, for use as a later feature-modeling `profile`), and
bottom-up wireframe modeling (addPoint/addLine/addArc/addSurfaceFromLines/
addVolumeFromSurfaces, B-rep only).

### `MeshOptions`

```typescript
interface MeshOptions {
  dimension: 1 | 2 | 3
  sizeMin: number
  sizeMax: number
  algorithm2D: number   // Mesh.Algorithm
  algorithm3D: number   // Mesh.Algorithm3D
  elementOrder: 1 | 2
  optimize: boolean
  stlAngle: number       // classifySurfaces angle, degrees
}
```

The flat options bag for GMSH FE-mesh generation (see
[GMSH Integration](./gmsh-integration.md)). `validateMeshOptions` (`src/meshOptions.ts`)
is the single tolerance gate — an individually invalid field falls back to
`DEFAULT_MESH_OPTIONS` for that field alone, so a hand-edited or partially-corrupt
`<model>.mesh.json` sidecar degrades gracefully rather than blocking meshing. Sent
host → webview in `meshingOptions` (hydration) and webview → host in
`meshingChanged`/`meshingGenerate`/`meshingExport`.

---

## Host → Webview Messages (`HostToWebview`)

```typescript
type HostToWebview =
  | { type: 'geometry'; meshes: EncodedMesh[]; edges: EncodedEdge[]; points: EncodedPoint[] }
  | { type: 'tree';     root: TreeNode }
  | { type: 'loadUrl';  url: string; format: CadFormat }
  | { type: 'parts';    parts: Part[] }
  | { type: 'edits';    ops: EditOp[] }
  | { type: 'status';   text: string }
  | { type: 'error';    message: string }
  | { type: 'editError'; message: string }
  | { type: 'exportMesh'; requestId: string; format: CadFormat }
  | { type: 'meshingOptions'; options: MeshOptions }
  | { type: 'meshingResult'; positions: string; indices: string; nodeCount: number; elementCount: number;
      elementGroups: MeshElementGroup[]; elapsedMs: number }
  | { type: 'meshingError'; message: string }
```

### `geometry`

Sent after B-rep tessellation. Contains every face as an encoded mesh, every unique
edge as a polyline, and every vertex as a point. The webview calls
`buildGroupFromEncoded(msg.meshes, msg.edges, msg.points)` (one `THREE.Mesh` per
face, one `THREE.Line` per edge, one `THREE.Sprite` per point, parented under
per-solid groups / a top-level `"points"` group) and then `viewer.setModel(group)`.

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

```json
{
  "type": "tree",
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

### `parts`

Sent after geometry, once the host has read the parts sidecar
(`<model>.parts.json`). Carries the saved part definitions (empty array when no
sidecar exists). The webview loads them into `PartsModel`, recolours the model,
and renders the Parts panel.

```json
{
  "type": "parts",
  "parts": [
    { "name": "Inlet", "color": "#e6194b", "volumes": ["solid-0"], "surfaces": ["face-3"], "lines": [], "points": [] }
  ]
}
```

### `edits`

Sent after geometry, once the host has read the edits sidecar
(`<model>.edits.json`). Carries the saved, ordered edit op-list (empty array when
no sidecar exists). The webview hydrates `EditsModel` and renders the Edits panel.
For B-rep the geometry already arrives with these ops applied (the host folds them
in before tessellating); for mesh formats the webview replays them locally.

```json
{
  "type": "edits",
  "ops": [
    { "op": "translate", "targets": ["solid-0"], "vec": [10, 0, 0] }
  ]
}
```

### `editError`

Shown in the status overlay when applying an op fails (e.g. an OCCT operation
throws). Distinct from `error` only by intent; both render the same way.

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

Sent when the user picks a mesh-format export target (STL/OBJ/PLY/glTF) in the
host's quick-pick. Only mesh targets round-trip through the webview — B-rep targets
(STEP/IGES/BREP) are written entirely in the host via OCCT, with no webview
involvement. The webview serializes the currently displayed `THREE.Object3D` with the
matching exporter from `three/examples/jsm/exporters/` and replies with
`exportResult`/`exportError`.

```json
{ "type": "exportMesh", "requestId": "1234-0.56", "format": "stl" }
```

### `meshingOptions`

Sent once, right after `parts`, once the host has read the mesh-options sidecar
(`<model>.mesh.json`). Carries the saved `MeshOptions` (`DEFAULT_MESH_OPTIONS` when no
sidecar exists). The webview calls `MeshingModel.load()` (hydration only — does not
echo back as a `meshingChanged` write) and renders the FE Mesh panel form.

```json
{
  "type": "meshingOptions",
  "options": { "dimension": 3, "sizeMin": 0, "sizeMax": 1e22, "algorithm2D": 6, "algorithm3D": 4, "elementOrder": 1, "optimize": true, "stlAngle": 40 }
}
```

### `meshingResult`

Sent in reply to `meshingGenerate` (and internally by `meshingExport` when the
target is `"msh"`) on a successful GMSH run. `positions`/`indices` are the base64
`Float32Array`/`Uint32Array` boundary triangulation, encoded exactly like
`EncodedMesh`'s buffers — for a 3D mesh these are the tetrahedra's boundary faces
derived host-side, not the tetrahedra themselves. `nodeCount`/`elementCount` are the
full node/element counts (not just the displayed boundary triangle count), and
`elapsedMs` is the wall-clock duration of the generate call. `elementGroups`
partitions `indices` into contiguous per-part runs (`{name, color, indexStart,
indexCount}`, with a trailing `name`/`color` = `null` run for triangles not claimed
by any part) so the overlay can be built multi-material with per-part colours. The
webview calls `viewer.setMeshOverlay(buildFEMesh(msg.positions, msg.indices,
msg.elementGroups))` and renders the stats (counts + time) in the panel's status
line.

```json
{
  "type": "meshingResult", "positions": "AAAA...", "indices": "BBBB...",
  "nodeCount": 421, "elementCount": 1893,
  "elementGroups": [
    { "name": "inlet", "color": "#ff0000", "indexStart": 0, "indexCount": 264 },
    { "name": null, "color": null, "indexStart": 264, "indexCount": 5412 }
  ],
  "elapsedMs": 3217
}
```

### `meshingError`

Sent in reply to `meshingGenerate`/`meshingExport` when GMSH throws or the
document has no mesh geometry available yet (e.g. a mesh-format document before the
webview has produced an STL snapshot). Rendered as an error string in the FE Mesh
panel's status line — it does not use the general `#error-overlay` `error` message.

```json
{ "type": "meshingError", "message": "No mesh geometry available: missing STL data." }
```

---

## Webview → Host Messages (`WebviewToHost`)

```typescript
type WebviewToHost =
  | { type: 'ready' }
  | { type: 'log'; message: string }
  | { type: 'partsChanged'; parts: Part[] }
  | { type: 'editsChanged'; ops: EditOp[] }
  | { type: 'exportRequest' }
  | { type: 'exportResult'; requestId: string; data: string; binary: boolean }
  | { type: 'exportError'; requestId: string; message: string }
  | { type: 'meshingChanged'; options: MeshOptions }
  | { type: 'meshingGenerate'; options: MeshOptions; stl?: string }
  | { type: 'meshingExport'; target: 'msh' | 'geoUnrolled'; options: MeshOptions; stl?: string }
```

### `partsChanged`

Sent whenever the user mutates parts (create / rename / recolour / delete /
assign / remove entity). The host debounces these (~500 ms) and writes the full
part list to the `<model>.parts.json` sidecar via `writeParts()`. The CAD file
itself is never written — only the sidecar.

```json
{ "type": "partsChanged", "parts": [ { "name": "Inlet", "color": "#e6194b", "volumes": ["solid-0"], "surfaces": [], "lines": [], "points": [] } ] }
```

### `editsChanged`

Sent whenever the user mutates the edit op-stack (apply / undo / redo / clear).
Carries the full ordered op-list. The host debounces these (~500 ms, on a separate
timer from `partsChanged`) and writes them to the `<model>.edits.json` sidecar via
`writeEdits()`. For B-rep sources the host also re-tessellates immediately with the
new ops and pushes a fresh `geometry` + `tree`; for mesh sources the webview has
already replayed the ops locally, so the host only persists. The CAD file is never
written — only the sidecar. See [`EditOp`](#editop) for op shapes.

```json
{ "type": "editsChanged", "ops": [ { "op": "translate", "targets": ["solid-0"], "vec": [10, 0, 0] } ] }
```

### `meshingChanged`

Sent whenever the user changes a mesh-options form control in the FE Mesh panel.
Carries the full current `MeshOptions`. The host debounces these (~500 ms, on its
own timer separate from parts/edits) and writes **two** files on the same tick:
`<model>.mesh.json` via `writeMeshOptions()` and the regenerated `<model>.geo`
script via `writeGeoScript()`. Neither generating nor changing options re-runs
GMSH by itself — that only happens on `meshingGenerate`/`meshingExport`. See
[GMSH Integration](./gmsh-integration.md).

```json
{ "type": "meshingChanged", "options": { "dimension": 3, "sizeMin": 0, "sizeMax": 1e22, "algorithm2D": 6, "algorithm3D": 4, "elementOrder": 1, "optimize": true, "stlAngle": 40 } }
```

### `meshingGenerate`

Sent when the user clicks **▶ Generate** in the FE Mesh panel. Carries the current
`MeshOptions` and, for a mesh-format document only, a base64 `stl` field — a
fresh snapshot of the currently displayed `THREE.Object3D`, serialized in the
webview via the same `exportModel(..., "stl")` helper Export already uses (the
host has no B-rep to re-export for a mesh-sourced document, so it has no other way
to obtain triangulated geometry for GMSH). B-rep documents omit `stl`; the host
re-exports the live OCCT shape to STEP itself. The host replies with
`meshingResult` or `meshingError`.

```json
{ "type": "meshingGenerate", "options": { "dimension": 3, "sizeMin": 0, "sizeMax": 1e22, "algorithm2D": 6, "algorithm3D": 4, "elementOrder": 1, "optimize": true, "stlAngle": 40 } }
```

### `meshingExport`

Sent when the user picks a format in the FE Mesh panel's export `<select>` and
clicks **📤 Export**. `target` is a `MeshExportFormatId` (see
`src/meshExportFormats.ts`'s `MESH_EXPORT_FORMATS` registry, the single source
of truth shared by the host and the webview's `<select>` — `"mdpaElements"` is
listed first and is therefore the default-selected format) selecting which
output to write: `"msh"` runs `generateMesh` and saves the raw `.msh` text;
`"geoUnrolled"` calls `exportGeoUnrolled` and saves the `.geo_unrolled` text
(handling its XAO companion, see below); `"mdpaElements"`/`"mdpaGeometries"`
run `exportMdpa`, a hand-written Kratos MDPA serializer with no `gmsh.write()`
involved at all (see `doc/gmsh-integration.md`'s "Kratos MDPA" section); every
other id (`"msh2"`, `"vtk"`, `"unv"`, `"inp"`, `"bdf"`, `"su2"`, `"mesh"`,
`"stl"`, `"diff"`, `"off"`) runs `exportMeshFormat`, a generic
mesh-then-`gmsh.write()` for whatever other Gmsh output formats this WASM
build actually supports (confirmed by probing every format Gmsh's writer table
recognizes — see `doc/gmsh-integration.md`). Same `options`/optional `stl`
payload as `meshingGenerate`. The host prompts a save dialog (reusing the same
`promptSaveAndWrite` helper Export uses) and writes the result directly —
there is no `meshingResult` reply for this message; failures post the general
`error` message instead of `meshingError`.

```json
{ "type": "meshingExport", "target": "geoUnrolled", "options": { "dimension": 3, "sizeMin": 0, "sizeMax": 1e22, "algorithm2D": 6, "algorithm3D": 4, "elementOrder": 1, "optimize": true, "stlAngle": 40 } }
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

### `exportRequest`

Sent when the user clicks the toolbar **Export** button. The host computes the
compatible target formats for the open document (`exportTargetsFor()` in
`src/exportTargets.ts`), shows a quick-pick and a save dialog, then either writes the
file itself (B-rep targets) or follows up with `exportMesh` (mesh targets).

```json
{ "type": "exportRequest" }
```

### `exportResult` / `exportError`

Sent in reply to `exportMesh`. `data` is base64 when `binary` is `true`, plain text
otherwise — the same convention as `EncodedMesh`'s buffers, just generalized to a
whole file. The host correlates the reply to its pending request via `requestId` and
writes the decoded bytes to the path chosen in the save dialog.

```json
{ "type": "exportResult", "requestId": "1234-0.56", "data": "AAAA...", "binary": true }
```

```json
{ "type": "exportError", "requestId": "1234-0.56", "message": "No model loaded" }
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
 │  ◀── { type: "exportRequest" } ────────  │  (Export button clicked)
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

B-rep targets (STEP/IGES/BREP) skip the `exportMesh` round-trip entirely — the host
re-reads the source file and writes the target format directly via
`exportBRep()` in `src/occtService.ts`.

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
