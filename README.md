# CAD-Preview

A Visual Studio Code extension that previews 3D CAD and mesh files directly in the
editor. Open a supported file and CAD-Preview renders an interactive 3D view
(orbit / pan / zoom) in a read-only custom editor.

B-rep (boundary-representation) formats are parsed and tessellated with
[OpenCascade.js](https://ocjs.org/) (the OCCT CAD kernel compiled to WebAssembly).
Already-triangulated mesh formats are loaded with native [Three.js](https://threejs.org/)
loaders. Rendering is always Three.js.

## Supported formats

| Format | Extensions          | Pipeline                                  |
| ------ | ------------------- | ----------------------------------------- |
| STEP   | `.step`, `.stp`     | OpenCascade.js → `BRepMesh` tessellation  |
| IGES   | `.iges`, `.igs`     | OpenCascade.js → `BRepMesh` tessellation  |
| BREP   | `.brep`             | OpenCascade.js → `BRepMesh` tessellation  |
| STL    | `.stl`              | Three.js `STLLoader`                      |
| OBJ    | `.obj`              | Three.js `OBJLoader`                      |
| PLY    | `.ply`              | Three.js `PLYLoader`                      |
| glTF   | `.gltf`, `.glb`     | Three.js `GLTFLoader`                     |

## Features

- Interactive camera: orbit, pan, zoom (OrbitControls)
- Fit-to-view on open and on demand
- Shaded / wireframe toggle
- Axes and grid helpers
- Theme-aware background

## Architecture

OpenCascade.js (the large WASM kernel) runs in the **Node extension host**, not in
the webview. The host reads the file, tessellates B-rep shapes, and sends plain
geometry buffers (typed-array `ArrayBuffer`s) to the webview. The webview runs only
Three.js and is responsible for rendering and camera interaction. This keeps the WASM
out of the webview (no CSP issues), keeps activation fast (the kernel is lazy-loaded
only on the first B-rep open), and means pure-mesh files never load the WASM at all.

```
Extension host (Node)            Webview (Chromium)
  read file bytes                  Three.js scene + OrbitControls
  OpenCascade.js parse + mesh  ──▶ build BufferGeometry / run loaders
  → {positions, normals, indices}  render, orbit/pan/zoom, toolbar
```

See [the implementation plan](#) and `examples/` for test fixtures (e.g.
`examples/STP/bull.stp`).

## Development

```bash
npm install        # install dependencies
npm run build      # build the extension host + webview bundles (esbuild) and type-check
npm run watch      # rebuild on change
npm test           # run unit + integration tests
```

Press **F5** in VS Code to launch an Extension Development Host with the extension
loaded, then open a supported file from `examples/` — e.g. `examples/STL/cube.stl`.

> **Status:** STL preview is implemented. STEP/IGES/BREP (OpenCascade.js) and the
> remaining mesh loaders (OBJ/PLY/glTF) are in progress — see the milestones in the
> implementation plan.

## Packaging

```bash
npx vsce package   # produces a .vsix you can install or publish
```

## License

See [LICENSE](LICENSE).
