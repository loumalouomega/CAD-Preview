# CAD-Preview

[![CI](https://github.com/loumalouomega/CAD-Preview/actions/workflows/ci.yml/badge.svg)](https://github.com/loumalouomega/CAD-Preview/actions/workflows/ci.yml)
[![VS Code Engine](https://img.shields.io/badge/VS%20Code-%5E1.80-blue?logo=visualstudiocode)](https://code.visualstudio.com/)
[![Three.js](https://img.shields.io/badge/Three.js-r160-black?logo=threedotjs)](https://threejs.org/)
[![OpenCascade.js](https://img.shields.io/badge/OpenCascade.js-1.x-orange)](https://ocjs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)

A Visual Studio Code extension that previews 3D CAD and mesh files directly in the
editor. Open a supported file and CAD-Preview renders an interactive 3D view
(orbit / pan / zoom) in a read-only custom editor.

B-rep (boundary-representation) formats are parsed and tessellated with
[OpenCascade.js](https://ocjs.org/) (the OCCT CAD kernel compiled to WebAssembly).
Already-triangulated mesh formats are loaded with native [Three.js](https://threejs.org/)
loaders. Rendering is always Three.js.

## Supported formats

| Format | Extensions          | Pipeline                                 |
| ------ | ------------------- | ---------------------------------------- |
| STEP   | `.step`, `.stp`     | OpenCascade.js → `BRepMesh` tessellation |
| IGES   | `.iges`, `.igs`     | OpenCascade.js → `BRepMesh` tessellation |
| BREP   | `.brep`             | OpenCascade.js → `BRepMesh` tessellation |
| STL    | `.stl`              | Three.js `STLLoader`                     |
| OBJ    | `.obj`              | Three.js `OBJLoader`                     |
| PLY    | `.ply`              | Three.js `PLYLoader`                     |
| glTF   | `.gltf`, `.glb`     | Three.js `GLTFLoader`                    |

## Features

- Interactive camera: orbit, pan, zoom (OrbitControls with damping)
- Fit-to-view on open and on demand via toolbar button
- Shaded / wireframe toggle
- Axes and grid helpers
- Loading status indicator and error reporting

## Architecture

OpenCascade.js (the WASM kernel) runs in the **Node extension host**, not in the
webview. The host reads the file, tessellates B-rep shapes, and sends plain geometry
buffers (base64-encoded typed arrays) to the webview. The webview runs only Three.js
and is responsible for rendering and camera interaction. This keeps the WASM out of
the webview (no CSP issues), keeps activation fast (the kernel is lazy-loaded only on
the first B-rep open), and means pure-mesh files never load the WASM at all.

```
Extension host (Node)                    Webview (Chromium)
  read file bytes                          Three.js scene + OrbitControls
  OpenCascade.js parse + tessellate  ───▶  build BufferGeometry from buffers
  → base64 {positions, indices}            render, orbit/pan/zoom, toolbar
             — or —
  asWebviewUri(file)                 ───▶  STL/OBJ/PLY/GLTFLoader.loadAsync(url)
```

## Development

```bash
npm install        # install dependencies
npm run build      # build extension host + webview bundles (esbuild) and type-check
npm run watch      # rebuild on change
npm test           # run unit tests (vitest)
```

Press **F5** in VS Code to launch an Extension Development Host, then open any
supported file from `examples/`:

| Fixture | Format |
| ------- | ------ |
| `examples/STP/bull.stp` | STEP (B-rep, OCCT pipeline) |
| `examples/STL/cube.stl` | STL mesh |
| `examples/OBJ/cube.obj` | OBJ mesh |
| `examples/PLY/cube.ply` | PLY mesh |
| `examples/GLTF/cube.gltf` | glTF mesh |

## Packaging

```bash
npm run package    # produces cad-preview.vsix
code --install-extension cad-preview.vsix
```

## CI

GitHub Actions runs on every push and pull request to `master`:
builds the extension, runs unit tests, and uploads a `.vsix` artifact.
See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## License

See [LICENSE](LICENSE).
