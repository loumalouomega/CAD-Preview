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
  groupId: string     // solid / mesh group identifier
}
```

Geometry is base64-encoded for safe `postMessage` transport. `groupId` links the mesh to the corresponding `TreeNode.id` in the component tree.

---

## Host → Webview Messages (`HostToWebview`)

```typescript
type HostToWebview =
  | { type: 'geometry'; meshes: EncodedMesh[] }
  | { type: 'tree';     root: TreeNode }
  | { type: 'loadUrl';  url: string; format: CadFormat }
  | { type: 'status';   text: string }
  | { type: 'error';    message: string }
  | { type: 'exportMesh'; requestId: string; format: CadFormat }
```

### `geometry`

Sent after B-rep tessellation. Contains all solid groups as encoded meshes. The webview calls `buildGroupFromEncoded(msg.meshes)` and then `viewer.setModel(group)`.

```json
{
  "type": "geometry",
  "meshes": [
    {
      "positions": "AAAA...",
      "indices": "AAAA...",
      "groupId": "solid-0"
    },
    {
      "positions": "BBBB...",
      "indices": "BBBB...",
      "groupId": "solid-1"
    }
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

---

## Webview → Host Messages (`WebviewToHost`)

```typescript
type WebviewToHost =
  | { type: 'ready' }
  | { type: 'log'; message: string }
  | { type: 'exportRequest' }
  | { type: 'exportResult'; requestId: string; data: string; binary: boolean }
  | { type: 'exportError'; requestId: string; message: string }
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
