# CAD-Preview

[![CI](https://github.com/loumalouomega/CAD-Preview/actions/workflows/ci.yml/badge.svg)](https://github.com/loumalouomega/CAD-Preview/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-online-blue)](https://loumalouomega.github.io/CAD-Preview/)
[![VS Code Engine](https://img.shields.io/badge/VS%20Code-%5E1.80-blue?logo=visualstudiocode)](https://code.visualstudio.com/)
[![Three.js](https://img.shields.io/badge/Three.js-r160-black?logo=threedotjs)](https://threejs.org/)
[![OpenCascade.js](https://img.shields.io/badge/OpenCascade.js-1.x-orange)](https://ocjs.org/)
[![License](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)

![](https://raw.githubusercontent.com/loumalouomega/CAD-Preview/master/images/cad_preview.png)

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
- View-manipulation panel: stepped rotate (15° / 45° / 90°), pan, zoom, **Fit**
  (reframe in place) and **Ctr** (reset to the default isometric view). The panel is
  collapsible — use the **⌄ / ⌃** button to hide or show it.
- Orientation cube: a labeled gizmo in the top-left corner that mirrors the current
  view; click a face to snap to that standard view
- Fit-to-view on open and on demand
- Shaded / wireframe toggle
- Axes and grid helpers
- Loading status indicator and error reporting
- **Parts**: define named groups by clicking volumes / surfaces / lines / points in
  the 3D view and assigning them to a part; assignments are colour-highlighted,
  listed in a tree panel, and saved to a `<model>.parts.json` sidecar (the CAD file
  stays read-only)
- **Edits**: apply non-destructive operations — **transforms** (move / rotate / scale /
  mirror), **booleans** (unite / subtract / intersect), **fillet/chamfer**, **feature
  modeling** (extrude / revolve / sweep / loft), **assembly** (explode / mate),
  **primitive creation** (box/cube, sphere, cylinder, cone, torus, N-sided prism),
  **2D profile sketches** (circle, rectangle, N-sided polygon — pick one later as an
  extrude/revolve/sweep/loft profile), and **bottom-up wireframe modeling** (points,
  lines, arcs → build a surface from a set of lines → build a volume from a set of
  surfaces); operations are undoable, replayable, and saved
  to a `<model>.edits.json` sidecar — the CAD file stays read-only, and edits are
  baked in only on **Export**. (Transforms, booleans, explode, and primitive creation
  work on both B-rep and mesh; fillet/chamfer, feature modeling, mate, 2D profile
  sketches, and the wireframe/build ops are B-rep only.)
- **Export**: convert the open model to a compatible format and save it via a native
  Save dialog — see [Export](#export) below
- **FE Meshing**: generate a finite-element mesh (nodes + triangles/tetrahedra) of the
  open model with [Gmsh](https://gmsh.info) compiled to WebAssembly, shown as an
  overlay on top of the existing view. Options (dimension, element size, algorithm,
  element order) are set in the **FE Mesh** panel and autosaved to a
  `<model>.mesh.json` sidecar alongside a generated, editable `<model>.geo` script;
  **📤 Export** saves the mesh to disk in any format the panel's dropdown offers,
  defaulting to **Kratos MDPA** (hand-written, in either an Elements+Conditions
  or a Geometries layout, preserving named Parts as Kratos SubModelParts), or
  Gmsh `.msh`/`.msh2`/`.geo_unrolled`, VTK, I-DEAS Universal, Abaqus, Nastran,
  SU2, INRIA Medit, STL, Diffpack, OFF. The CAD file stays read-only. See
  [GMSH Integration](https://loumalouomega.github.io/CAD-Preview/gmsh-integration)
  for details.

## Export

The toolbar **Export** button converts the currently displayed model to a compatible
format. Available targets depend on the source file's pipeline:

| Source pipeline | Export targets |
| ---------------- | --------------- |
| B-rep (STEP/IGES/BREP) | the other two B-rep formats (true OCCT writers) **+** STL/OBJ/PLY/glTF |
| Mesh (STL/OBJ/PLY/glTF) | the other mesh formats only |

The source format itself is never offered. B-rep targets are written entirely in the
extension host via OCCT; mesh targets are serialized in the webview from the
already-tessellated Three.js model (there is no way to promote a triangle mesh back
into a B-rep). glTF export always produces a single binary `.glb` file. See
[File Formats → Export](https://loumalouomega.github.io/CAD-Preview/file-formats#export)
for details.

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

## Documentation

Full documentation is available at **https://loumalouomega.github.io/CAD-Preview/**

Source lives in the [`doc/`](doc/) folder, built with [VitePress](https://vitepress.dev/) and
deployed automatically to GitHub Pages on every push to `master`.
See [`.github/workflows/docs.yml`](.github/workflows/docs.yml).

## CI

GitHub Actions runs on every push and pull request to `master`:
builds the extension, runs unit tests, and uploads a `.vsix` artifact.
See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Licensing

CAD-Preview bundles [`@loumalouomega/gmsh-wasm`](https://github.com/loumalouomega/GMSH-JS),
which compiles the Gmsh mesh generator and statically links it (together with
OpenCASCADE Technology) into a single WebAssembly binary. Gmsh is distributed under the
**GNU General Public License, version 2 or later** (GPL-2.0-or-later), with a linking
exception that covers Netgen, METIS, OpenCASCADE, and ParaView. Because CAD-Preview
ships that compiled binary as part of the extension, CAD-Preview itself is distributed
under the **GPL-2.0-or-later** — see [LICENSE](LICENSE) for the full text.

OpenCASCADE Technology (OCCT) is used in two places in this extension: directly, via
[`opencascade.js`](https://github.com/donalffons/opencascade.js), for the native B-rep
read/export pipeline, and indirectly, inside gmsh-wasm's meshing pipeline. OCCT is
licensed under the **GNU Lesser General Public License, version 2.1**, with an
additional exception granted by its authors.

Anyone who needs to use Gmsh under terms other than the GPL can obtain a separate
commercial license directly from its authors at [gmsh.info](https://gmsh.info).

### Attribution

- **Gmsh** — C. Geuzaine and J.-F. Remacle. <https://gmsh.info>
- **OpenCASCADE Technology (OCCT)** — <https://dev.opencascade.org>

## License

See [LICENSE](LICENSE).
