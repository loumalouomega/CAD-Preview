# Architecture

## Two-Process Model

VS Code extensions run in two separate JavaScript environments:

| Environment | Runtime | CAD Preview responsibilities |
| --- | --- | --- |
| **Extension host** | Node.js (CJS) | File I/O, OCCT tessellation, geometry encoding, message dispatch |
| **Webview** | Chromium (browser IIFE) | Three.js scene, camera, rendering, UI |

The two processes communicate exclusively through VS Code's `postMessage` / `onDidReceiveMessage` API. They share no memory. See [Host ↔ Webview Protocol](./protocol.md) for the message schema.

```
Extension host (Node)                     Webview (Chromium)
─────────────────────────────────────     ─────────────────────────────────────────
 read file bytes
 OpenCascade.js parse + tessellate  ───▶  buildGroupFromEncoded() → THREE.Group
   → base64 {positions, indices}          Viewer.setModel()  →  render loop
              ── or ──
 asWebviewUri(filePath)             ───▶  loadMeshFromUrl()  →  THREE.Object3D
                                          Viewer.setModel()  →  render loop
```

### Why OCCT Runs in the Extension Host

1. **No CSP issues.** The webview enforces a strict Content Security Policy (`default-src 'none'`). Loading a 30 MB WASM binary from the filesystem inside the webview would require relaxing `script-src` and `connect-src`, which opens XSS surface. The extension host is a trusted Node process with full filesystem access.
2. **Lazy WASM, lazy cost.** Opening an STL or glTF file never loads the WASM. The kernel is initialized only on the first B-rep open and memoized. Activation time stays instant regardless of what file the user opens first.
3. **Node 18+ has `Buffer`/`fs`.** The OCCT factory needs `fs.readFileSync` to load the `.wasm` binary. That API is not available in the webview at all.

## File Routing

`src/fileRouter.ts` maps file extensions to one of two rendering strategies:

```
file extension
     │
     ▼
 routeFile()
     │
     ├── .step / .stp / .iges / .igs / .brep  →  strategy: "occt"
     │                                             format: "step" | "iges" | "brep"
     │
     └── .stl / .obj / .ply / .gltf / .glb   →  strategy: "three"
                                                  format: "stl" | "obj" | "ply" | "gltf"
```

`CadPreviewProvider.resolveCustomEditor()` in `src/provider.ts` reads the returned `FileRoute` and dispatches accordingly.

## Export

Export mirrors the same two-pipeline split, in reverse, driven by `exportTargetsFor()` in `src/exportTargets.ts`:

- **B-rep targets** (STEP/IGES/BREP) are written entirely in the extension host: `exportBRep()` in `src/occtService.ts` re-parses the source file with the existing OCCT reader and hands the live `TopoDS_Shape` to the matching OCCT writer. The webview is not involved.
- **Mesh targets** (STL/OBJ/PLY/glTF) are written in the webview, since that's where the triangulated `THREE.Object3D` already lives (for *any* source format — OCCT tessellation results and natively-loaded meshes are indistinguishable once they're in the Three.js scene). `src/webview/meshExporters.ts` wraps Three.js's bundled exporters and posts the serialized result back to the host over `postMessage`, since only the extension host can show native save dialogs.

OCCT in this build only includes B-rep writers — there are no STL/OBJ/PLY/glTF writers, and no reverse path from a triangle mesh to a B-rep. That asymmetry is why export targets are pipeline-dependent rather than a flat list of every supported format.

## WASM Loading — Critical Detail

**Do not use `initOpenCascade` from `opencascade.js/index.js`.** That wrapper takes zero arguments and ignores any options passed to it. In Node 18 the fallback code calls `fetch(wasmPath)`, which fails for filesystem paths (`TypeError: Failed to parse URL`).

Instead, import the raw Emscripten factory and pass `wasmBinary` explicitly:

```typescript
import openCascadeFactory from 'opencascade.js/dist/opencascade.wasm.js'

const wasmBinary = fs.readFileSync(
  path.join(extensionPath, 'dist', 'opencascade.wasm.wasm')
)
const oc = await openCascadeFactory({ wasmBinary })
```

This approach:

- Is deterministic — no `fetch`, no URL resolution.
- Works on all platforms (Windows paths, Remote/SSH, dev containers).
- Is the only approach that survives the esbuild bundle (see [Bundling](#bundling) below).

## Lazy Singleton Pattern

`src/occtService.ts` holds a module-level `_ocPromise: Promise<any> | null`. The first call to `getOcct(extensionPath)` initializes it; subsequent calls return the same promise. The singleton is never reset between file opens — only `resetOcct()` (used in tests) clears it.

```typescript
// Simplified
let _ocPromise: Promise<any> | null = null

export function getOcct(extensionPath: string): Promise<any> {
  if (!_ocPromise) {
    _ocPromise = openCascadeFactory({ wasmBinary: fs.readFileSync(...) })
  }
  return _ocPromise
}
```

## Bundling

The project uses [esbuild](https://esbuild.github.io/) (not tsc) to produce two bundles:

| Bundle         | Path                | Format | Target         |
| -------------- | ------------------- | ------ | -------------- |
| Extension host | `dist/extension.js` | CJS    | Node 18        |
| Webview        | `media/viewer.js`   | IIFE   | ES2020 browser |

`tsc --noEmit` (via `npm run compile`) provides type-checking only — it emits nothing.

### WASM Handling in esbuild

A custom esbuild plugin (`wasmPathPlugin` in `esbuild.mjs`) intercepts the import of `opencascade.js/dist/opencascade.wasm.wasm` and replaces it with a CJS stub:

```javascript
// Generated stub (not actual file content)
module.exports = require('path').join(__dirname, 'opencascade.wasm.wasm')
```

After the bundle is written, `esbuild.mjs` copies `node_modules/opencascade.js/dist/opencascade.wasm.wasm` to `dist/opencascade.wasm.wasm`. At runtime, `__dirname` in the bundle resolves to `dist/`, so the path is correct.

**opencascade.js is NOT marked external.** It is fully bundled (ESM → CJS) into `dist/extension.js` along with its emscripten glue code.

## Content Security Policy

The webview HTML sets a strict CSP:

```
default-src 'none';
script-src 'nonce-{nonce}';
style-src 'nonce-{nonce}';
img-src {webview-csp-source} data:;
```

This means:

- No inline scripts without the nonce.
- No `eval` / `unsafe-eval` (so no dynamic code).
- Images are allowed only from `vscode-webview://` URIs or `data:` (used by `CanvasTexture`).
- Fonts and external resources are blocked.

The orientation cube's face labels are drawn via `CanvasTexture` (HTML5 `<canvas>` → `drawText`) — this approach requires no external image assets and is fully CSP-safe.

## Single WebGL Renderer

A second WebGL context is disallowed in some environments and degrades performance in all of them. The `OrientationCube` class therefore owns **no `WebGLRenderer`**.

Instead, `Viewer.renderGizmo()` draws the orientation cube into a corner of the **single main renderer** using a scissor viewport:

```
main canvas
┌──────────────────────────────────┐
│                                  │
│   Main Three.js scene            │
│   (model + lights + grid)        │
│                                  │
│ ┌──────┐                         │
│ │ Gizmo│  ← scissor viewport     │
│ │ cube │    (top-left corner)     │
│ └──────┘                         │
└──────────────────────────────────┘
```

The render sequence per frame:

1. Clear color + depth for the full canvas → render the main scene.
2. Set scissor rect (top-left, 120×120 px) → clear depth only (scene colors preserved) → render the gizmo scene.
3. Disable scissor.

Face clicks on the gizmo are handled by a `capture-phase pointerdown` listener on the canvas that calls `stopImmediatePropagation()`, preventing OrbitControls from also interpreting the click as a camera drag.

## OCCT Memory Discipline

Every wrapped OCCT object (reader, shape, explorer, mesher, triangulation handle, face) is an Emscripten heap handle. These objects are **not garbage-collected**. The OCCT singleton is reused across file opens, so only per-file objects need to be freed.

The pattern in `src/meshExtract.ts`:

```typescript
const cleanup: { delete(): void }[] = []
try {
  const reader = new oc.STEPControl_Reader_1()
  cleanup.push(reader)
  // ... more objects
} finally {
  for (let i = cleanup.length - 1; i >= 0; i--) {
    cleanup[i].delete()  // reverse order — inner objects before outer
  }
}
```

Violating this discipline causes the WASM heap to grow unboundedly across file opens. Measure it in the Extension Development Host by opening/closing large STEP files repeatedly and watching the extension host process memory.
