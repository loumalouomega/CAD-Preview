# Extension Host API

The extension host is a Node.js process. These modules run there — never in the webview.

## Module Index

| Module | Responsibility |
|--------|---------------|
| `src/extension.ts` | VS Code extension entry point |
| `src/provider.ts` | Custom editor provider, webview lifecycle |
| `src/fileRouter.ts` | Map file extensions to render strategy |
| `src/exportTargets.ts` | Map a `FileRoute` to its compatible export formats |
| `src/occtService.ts` | Lazy WASM singleton, B-rep parsing + tessellation + export |
| `src/meshExtract.ts` | Extract WebGL geometry from OCCT shapes |
| `src/protocol.ts` | Shared message types and buffer encoding |

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
3. Registers a `webviewPanel.webview.onDidReceiveMessage` listener (and a per-panel
   `pending: Map<string, { resolve; reject }>` used to correlate export round-trips)
   that handles `"ready"`, `"exportRequest"`, `"exportResult"`, and `"exportError"`.
4. On `"ready"`: calls `routeFile()` and dispatches to `handleBRep()` or posts a `"loadUrl"` message.
5. On `"exportRequest"`: dispatches to `handleExport()`.
6. On `"exportResult"`/`"exportError"`: resolves/rejects the matching entry in `pending` by `requestId`.

**`handleBRep(extensionPath, bytes, format, webview)`** — Private method. Calls `loadBRep()`, posts `"status"` progress messages, then posts `"geometry"` + `"tree"` messages. Posts `"error"` on failure.

**`handleExport(uri, route, post, pending)`** — Private method. The whole "Export" toolbar button flow:
1. `exportTargetsFor(route)` → `vscode.window.showQuickPick()` of compatible formats; bails if cancelled.
2. `vscode.window.showSaveDialog()` defaulting to the source's folder + new extension (`EXPORT_EXTENSION`); bails if cancelled.
3. If the target is a B-rep format (STEP/IGES/BREP): reads the source bytes and calls `exportBRep()` directly — no webview round-trip.
   If the target is a mesh format (STL/OBJ/PLY/glTF): registers a `requestId` in `pending`, posts `"exportMesh"`, and awaits the promise that the `onDidReceiveMessage` handler resolves/rejects when the webview replies.
4. Decodes the result (base64 or UTF-8, per the `binary` flag) and writes it with `vscode.workspace.fs.writeFile()`. Posts `"status"` on success, `"error"` on failure.

**`getHtml(webview, extensionUri)`** — Private method. Generates the full webview HTML with:
- A strict CSP nonce.
- The compiled `media/viewer.js` bundle (IIFE).
- The `media/viewer.css` stylesheet.
- Static toolbar HTML (`#fit`, `#wireframe`, `#grid`, `#export`, `#tree-toggle`).
- Static view-controls panel HTML (`#view-controls`, `#vc-toggle`).
- Tree panel container (`#tree-panel`).
- Status/error overlay divs.

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
  groups: SolidGroup[]   // from meshExtract.ts
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
  format: CadFormat
): Promise<BRepResult>
```
High-level entry point called from `provider.ts`. Calls `getOcct()`, writes the file bytes to the OCCT virtual filesystem, calls `readShape()` to parse, calls `tessellateByGroup()` to extract geometry, and calls `buildTree()` to build the component hierarchy.

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
  targetFormat: "step" | "iges" | "brep"
): Promise<Uint8Array>
```
Re-parses `bytes` with `readShape()` and writes the resulting `TopoDS_Shape` out as
`targetFormat` via the private `writeShape()` helper, returning the output file's
bytes (read back from the OCCT virtual filesystem). Cleans up every handle —
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

## `src/meshExtract.ts`

Extracts WebGL-ready geometry buffers from an OCCT shape.

### Types

```typescript
interface GeometryBuffers {
  positions: Float32Array   // XYZ vertex positions
  normals: Float32Array     // XYZ vertex normals (currently unused by the webview material)
  indices: Uint32Array      // Triangle indices (0-based)
}

interface SolidGroup {
  id: string
  label: string
  faceCount: number
  meshes: GeometryBuffers[]
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
Tessellates the entire `TopoDS_Shape`. Uses `BRepMesh_IncrementalMesh_2` with linear deflection `0.1`. Explores solids via `TopExp_Explorer`, then within each solid explores faces and calls `extractFaceGeometry`. Returns one `SolidGroup` per solid.

**Memory discipline:** Every OCCT handle created inside this function is pushed onto a local `cleanup[]` array. A `try/finally` block deletes them in reverse order regardless of success or failure.

```typescript
function tessellateShape(oc: any, shape: any): GeometryBuffers[]
```
Legacy flat tessellation (no grouping). Kept for test compatibility. Returns one `GeometryBuffers` per face.

---

## `src/protocol.ts`

Defines the host ↔ webview message contract. See [Host ↔ Webview Protocol](./protocol.md) for the full reference.

### Buffer Encoding

```typescript
function encodeBuffer(arr: Float32Array | Uint32Array): string
```
Encodes a typed array as a base64 string for safe `postMessage` transport. Uses `Buffer.from(arr.buffer).toString('base64')` (Node.js `Buffer` — host-side only).

The corresponding decode helpers (`decodeF32`, `decodeU32`) live in `src/webview/geometryBuilder.ts` and use browser `atob`.
