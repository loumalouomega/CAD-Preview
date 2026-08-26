# CAD-Preview

[![CI](https://github.com/loumalouomega/CAD-Preview/actions/workflows/ci.yml/badge.svg)](https://github.com/loumalouomega/CAD-Preview/actions/workflows/ci.yml) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://loumalouomega.github.io/CAD-Preview/) [![VS Code Engine](https://img.shields.io/badge/VS%20Code-%5E1.80-blue?logo=visualstudiocode)](https://code.visualstudio.com/) [![Three.js](https://img.shields.io/badge/Three.js-r160-black?logo=threedotjs)](https://threejs.org/) [![OpenCascade.js](https://img.shields.io/badge/OpenCascade.js-1.x-orange)](https://ocjs.org/) [![License](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)](LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)

<div style="display: flex; justify-content: space-around; align-items: flex-start;">
  <img src="https://raw.githubusercontent.com/loumalouomega/CAD-Preview/master/images/cad_preview.png" alt="CAD Preview" style="width: 48%;">
  <img src="https://raw.githubusercontent.com/loumalouomega/CAD-Preview/master/images/mesh_generation.png" alt="Mesh Generation" style="width: 48%;">
</div>

A Visual Studio Code extension that previews 3D CAD and mesh files directly in the editor. Open a supported file and CAD-Preview renders an interactive 3D view (orbit / pan / zoom) in a read-only custom editor.

B-rep (boundary-representation) formats are parsed and tessellated with [OpenCascade.js](https://ocjs.org/) (the OCCT CAD kernel compiled to WebAssembly). Already-triangulated mesh formats are loaded with native [Three.js](https://threejs.org/) loaders. Rendering is always Three.js.

## Supported formats

| Format      | Extensions      | Pipeline                                   |
| ----------- | --------------- | ------------------------------------------ |
| STEP        | `.step`, `.stp` | OpenCascade.js → `BRepMesh` tessellation   |
| IGES        | `.iges`, `.igs` | OpenCascade.js → `BRepMesh` tessellation   |
| BREP        | `.brep`         | OpenCascade.js → `BRepMesh` tessellation   |
| STL         | `.stl`          | Three.js `STLLoader`                       |
| OBJ         | `.obj`          | Three.js `OBJLoader`                       |
| PLY         | `.ply`          | Three.js `PLYLoader`                       |
| glTF        | `.gltf`, `.glb` | Three.js `GLTFLoader`                      |
| VTK         | `.vtk`, `.vtu`  | meshio++ → STL boundary surface → Three.js |
| MED         | `.med`          | meshio++ → STL boundary surface → Three.js |
| CGNS        | `.cgns`         | meshio++ → STL boundary surface → Three.js |
| Exodus      | `.exo`, `.e`    | meshio++ → STL boundary surface → Three.js |
| XDMF        | `.xdmf`         | meshio++ → STL boundary surface → Three.js |
| Kratos MDPA | `.mdpa`         | meshio++ → STL boundary surface → Three.js |
| OpenFOAM    | `.foam`         | meshio++ (case staging) → STL boundary surface → Three.js |

> The **Pipeline** column is how each format is *rendered*. STL, OBJ, PLY, and glTF/GLB additionally have pure host-side triangle parsers (no webview, no OCCT), which is what lets **Compare Models**, **Mesh Health / Promote to B-rep**, and **Silhouette SVG export** work on them headlessly as well as interactively. The glTF parser is geometry-only and cross-validated against three.js's own `GLTFLoader`; it rejects Draco/meshopt-compressed files with a clear error rather than guessing.
>
> The last six formats are imported as a triangulated **boundary surface** (meshio++, host-side) — same capabilities as an STL open (Parts, Edits, Export, Mass Properties, Measurement all work identically). Named cell regions in the source file now auto-become real, selectable/colourable Parts on first import (for a tetrahedral/triangular boundary); scalar-field and multi-material data beyond that still isn't preserved. This is separate from the FE Meshing feature's own MDPA/MED/CGNS *export* path below, which writes a newly generated mesh, not the source file.

## Features

- **File menu**: a top menu bar with a **File ▾** dropdown — **Open…** (open another CAD/mesh file), **Save** (flush the parts/annotations/edits/mesh sidecars now; the CAD file itself stays read-only), **Save As…** and **Export…** (both run the Export flow), **Save Preprocess…** / **Load Preprocess…** (bundle/restore the CAD file plus whichever parts/annotations/edits/mesh sidecars exist as a single portable, checksummed `.zip` — restoring rejects a tampered archive or a destination whose extension doesn't match the archive's own format), **Import SVG…** / **Import DXF…** (import a traced `.svg`'s `<path>` elements or a DXF's model-space `LINE`/`LWPOLYLINE`/`CIRCLE`/`ARC`/`SPLINE` entities as B-rep sketch ops, ready to Build → Surface / Extrude), and **Export Silhouette SVG…** / **Export Silhouette DXF…** (write a 2D outline of the model as SVG or DXF — see [Export](#export) below). Every item is also a VS Code command; most have a keyboard shortcut (Ctrl+O / Ctrl+S / Ctrl+Shift+S / Ctrl+E / Ctrl+Alt+S / Ctrl+Alt+O, scoped to a focused CAD Preview tab). You can also drag a file onto the 3D view to open it, falling back to the **Open…** dialog if the drop doesn't expose a filesystem path.
- Interactive camera: orbit, pan, zoom (OrbitControls with damping); an **Ortho/Persp** toggle switches between orthographic and perspective projection at any time
- View-manipulation panel: stepped rotate (15° / 45° / 90°), pan, zoom, **Fit** (reframe in place) and **Ctr** (reset to the default isometric view); a **Clip** group with a live, uncapped section plane along X/Y/Z; an **Appearance** group for a session-only background colour override, whole-model opacity, the ortho/perspective toggle, a **Units** selector (mm/cm/m/in/ft) that rescales Mass Properties/Measurement readouts — display-only, seeded from a STEP file's own declared unit when present (geometry itself is always internally consistent in millimetres regardless of the source file's unit) — and a **Grid size** field controlling the Transform Gizmo's grid-snap increment. The panel is collapsible — use the **⌄ / ⌃** button to hide or show it.
- Grid and entity-point snapping: **View ▾ → Snap to grid / Snap to points** make a Transform Gizmo Translate drag round to the Grid size increment and/or snap onto nearby existing vertices — both off by default, and can be combined.
- Orientation cube: a labeled gizmo in the top-left corner that mirrors the current view; click a face to snap to that standard view
- Fit-to-view on open and on demand
- Shaded / wireframe toggle; edges can be shown/hidden independently of faces
- Axes and grid helpers
- Loading status indicator and error reporting — opening a STEP/IGES/BREP file for the first time (or after an external change) also shows a native, cancellable progress notification while it parses/tessellates; Cancel discards the result rather than interrupting the (uninterruptible) underlying computation. Routine edit-triggered re-tessellation stays on the lightweight status line only.
- **Parts**: define named groups by clicking volumes / surfaces / lines / points in the 3D view and assigning them to a part; assignments are colour-highlighted, listed in a tree panel, and saved to a `<model>.parts.json` sidecar (the CAD file stays read-only). Each part has a per-row eye-toggle, and a panel-level **⊙ Isolate** button shows only the selected part; both are display-only and compose with each other (never persisted). The Components tree has a matching per-row eye-toggle and a name filter.
- **Standard Parts**: search the hosted [step.parts](https://www.step.parts) catalog (fasteners, bearings, connectors, extrusions, …) from a sidebar panel and insert a result as a new STEP document with one click (checksum-verified against the catalog's own recorded SHA-256, when present).
- **Edits**: apply non-destructive operations — **transforms** (move / rotate / scale / mirror, with a draggable 3D **Transform Gizmo** live-previewing the drag and optional grid/entity-point snapping), **booleans** (unite / subtract / intersect), **fillet/chamfer**, **feature modeling** (extrude / revolve / sweep / loft), **assembly** (explode / mate / **align** / **linear & circular pattern**), **primitive creation** (box/cube, sphere, cylinder, cone, torus, N-sided prism, wedge, holes/counterbore/countersink), **2D profile sketches** (circle, rectangle, N-sided polygon, ellipse, rounded rectangle, slot, trapezoid — pick one later as an extrude/revolve/sweep/loft profile), curves (polyline, 3-point arc, spline, Bézier, elliptical arc, helix), **modify** (shell, split, section), and **bottom-up wireframe modeling** (points, lines, arcs → build a surface from a set of lines → build a volume from a set of surfaces); Explode has a live-preview slider that spreads the bodies as you drag before you commit it with Apply; operations are undoable, replayable, and saved to a `<model>.edits.json` sidecar — the CAD file stays read-only, and edits are baked in only on **Export**. (Transforms, booleans, explode, primitive creation, align, and pattern work on both B-rep and mesh; fillet/chamfer, feature modeling, mate, 2D profile sketches, curves, modify ops, and the wireframe/build ops are B-rep only.)
- **Export**: convert the open model to a compatible format and save it via a native Save dialog, or write a 2D **silhouette SVG** outline of it — see [Export](#export) below
- **FE Meshing**: generate a finite-element mesh (nodes + triangles/tetrahedra) of the open model with [Gmsh](https://gmsh.info) compiled to WebAssembly, shown as an overlay on top of the existing view. Options (dimension, element size, algorithm, element order) are set in the **FE Mesh** panel and autosaved to a `<model>.mesh.json` sidecar alongside a generated, editable `<model>.geo` script; a generate also reports an element-quality summary (min/mean `minSICN` plus a histogram) alongside the node/element counts; **📤 Export** saves the mesh to disk in any format the panel's dropdown offers, defaulting to **Kratos MDPA** (hand-written, in either an Elements+Conditions or a Geometries layout, preserving named Parts as Kratos SubModelParts), or Gmsh `.msh`/`.msh2`/`.geo_unrolled`, VTK, **MED**, **CGNS**, **XDMF** (the last three bridged through [meshio++](https://github.com/loumalouomega/meshioplusplus), since this Gmsh build can't write them itself), I-DEAS Universal, Abaqus, Nastran, SU2, INRIA Medit, STL, Diffpack, OFF. The CAD file stays read-only. See [GMSH Integration](https://loumalouomega.github.io/CAD-Preview/gmsh-integration) for details.
- **MCP server**: a standalone [Model Context Protocol](https://modelcontextprotocol.io) server (`dist/mcp-server.js`) exposes the same load/edit/mesh/export pipeline to AI agents (e.g. Claude Code) headless, persisting to the same sidecar files the extension reads — see [MCP Server](#mcp-server) below.
- **Measurement tools**: measure distance, edge length, angle, and circle/arc radius directly in the 3D view — a display-only overlay, never an edit operation; a completed 2-point result renders as an actual **dimension** (arrowheads, witness marks, value label), and a result can optionally be **pinned** (📌) as a persisted, topology-anchored **annotation**, saved to a `<model>.annotations.json` sidecar and automatically re-matched to its anchored entity across topology-changing edits — the same best-effort geometric rebinding Parts already get. An optional **tolerance band** (nominal ± allowance) can be recorded on a pin; an out-of-band measurement is flagged by colour, and pinned annotations appear as dimension glyphs in Export Silhouette SVG/DXF drawings.
- **Mass properties**: volume, surface area, length, center of mass, and moments of inertia for the whole model or a single selected entity — computed via OpenCascade.js's `BRepGProp` for B-rep sources, or entirely client-side for mesh sources.
- **Screenshot**: save the current 3D view as a PNG via a native Save dialog.
- **Settings**: a handful of `cadPreview.*` VS Code settings (default background, mesh-size preset, grid/axes visibility, up-axis) for newly opened documents.
- **Compare Models**: diff two files solid-by-solid — matched by bounding-box-centroid proximity and volume similarity, reporting added/removed/matched solids with each match's raw centre displacement and volume delta (never a hidden moved/unchanged guess). STEP/IGES/BREP, STL, OBJ, PLY, and glTF/GLB are supported, in any combination (only the meshio++ bridge formats aren't — they never expose a triangle array outside their own WASM module); display-only.

## Export

The **File ▸ Export…** menu item (or Ctrl+E) converts the currently displayed model to a compatible format. Available targets depend on the source file's pipeline:

| Source pipeline | Export targets |
| --- | --- |
| B-rep (STEP/IGES/BREP) | the other two B-rep formats (true OCCT writers) **+** STL/OBJ/PLY/glTF |
| Mesh (STL/OBJ/PLY/glTF) | the other mesh formats only |

The source format itself is never offered. B-rep targets are written entirely in the extension host via OCCT; mesh targets are serialized in the webview from the already-tessellated Three.js model (there is no way to promote a triangle mesh back into a B-rep). glTF export always produces a single binary `.glb` file. See [File Formats → Export](https://loumalouomega.github.io/CAD-Preview/file-formats#export) for details.

**File ▸ Export Silhouette SVG…** (and its **Export Silhouette DXF…** sibling) is a separate flow (a drawing, not a 3D model, so it never appears in the target list above): pick a view — **Current view**, or Front/Back/Top/Bottom/Left/Right/Iso — then an export unit, then a destination, and CAD-Preview writes a 2D **outline** of the model as a self-contained SVG (one `<path>`, no external references, 1 SVG user unit = 1 model unit with a physical size in mm, so it prints 1:1) or as a minimal DXF (`LWPOLYLINE`/`LINE` entities over the same outline). Both menu items share the flow; only the serializer and default extension differ. Works for STEP/IGES/BREP (edits baked in, from the current tessellation) and STL/OBJ/PLY/glTF (raw file bytes, edits not baked in).

> It is an **outline, not a dimensioned 2D technical drawing — there is no hidden-line removal**. Back-facing geometry isn't drawn, but neither are interior feature edges that don't lie on a silhouette. OpenCascade's hidden-line machinery is entirely unavailable in the bundled WASM build, so the outline is derived from triangle adjacency instead — which is also why it works for mesh files and not just B-rep. Accuracy depends on consistent triangle winding; a mixed-winding mesh draws spurious interior lines.

## MCP Server

CAD-Preview ships a standalone MCP (Model Context Protocol) stdio server so AI agents can drive the same pipeline headless — load models, apply edit operations, manage parts and parametric variables, and generate/export FE meshes — with no VS Code involved. It persists to the same `.edits.json`/`.parts.json`/`.mesh.json` sidecars the extension reads, so agent edits show up when you open the file (and never touches the CAD source file). After `npm run build`, register it with e.g. Claude Code:

```bash
claude mcp add cad-preview -- node /absolute/path/to/CAD-Preview/dist/mcp-server.js
```

B-rep sources (STEP/IGES/BREP) get the full pipeline; mesh-format sources are more limited headless. See [MCP Server](https://loumalouomega.github.io/CAD-Preview/mcp-server) for the tool reference and capability matrix.

## Architecture

OpenCascade.js (the WASM kernel) runs in the **Node extension host**, not in the webview. The host reads the file, tessellates B-rep shapes, and sends plain geometry buffers (base64-encoded typed arrays) to the webview. The webview runs only Three.js and is responsible for rendering and camera interaction. This keeps the WASM out of the webview (no CSP issues), keeps activation fast (the kernel is lazy-loaded only on the first B-rep open), and means pure-mesh files never load the WASM at all.

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

Press **F5** in VS Code to launch an Extension Development Host, then open any supported file from `examples/`:

| Fixture                   | Format                      |
| ------------------------- | --------------------------- |
| `examples/STP/bull.stp`   | STEP (B-rep, OCCT pipeline) |
| `examples/STL/cube.stl`   | STL mesh                    |
| `examples/OBJ/cube.obj`   | OBJ mesh                    |
| `examples/PLY/cube.ply`   | PLY mesh                    |
| `examples/GLTF/cube.gltf` | glTF mesh                   |

## Packaging

```bash
npm run package    # produces cad-preview.vsix
code --install-extension cad-preview.vsix
```

## Documentation

Full documentation is available at **https://loumalouomega.github.io/CAD-Preview/**

Source lives in the [`doc/`](doc/) folder, built with [VitePress](https://vitepress.dev/) and deployed automatically to GitHub Pages on every push to `master`. See [`.github/workflows/docs.yml`](.github/workflows/docs.yml).

Planned and candidate features are tracked in the [Roadmap](doc/roadmap.md).

## CI

GitHub Actions runs on every push and pull request to `master`: builds the extension, runs unit tests, and uploads a `.vsix` artifact. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

Dependencies are kept current and vetted by two mechanisms in `.github/`: [Dependabot](.github/dependabot.yml) opens weekly update PRs (and raises security alerts) for `npm` and GitHub Actions dependencies, and the [Dependency Review](.github/workflows/dependency-review.yml) workflow blocks any pull request that introduces a package with a known moderate-or-worse vulnerability.

## Licensing

CAD-Preview bundles [`@loumalouomega/gmsh-wasm`](https://github.com/loumalouomega/GMSH-JS), which compiles the Gmsh mesh generator and statically links it (together with OpenCASCADE Technology) into a single WebAssembly binary. Gmsh is distributed under the **GNU General Public License, version 2 or later** (GPL-2.0-or-later), with a linking exception that covers Netgen, METIS, OpenCASCADE, and ParaView. Because CAD-Preview ships that compiled binary as part of the extension, CAD-Preview itself is distributed under the **GPL-2.0-or-later** — see [LICENSE](LICENSE) for the full text.

OpenCASCADE Technology (OCCT) is used in two places in this extension: directly, via [`opencascade.js`](https://github.com/donalffons/opencascade.js), for the native B-rep read/export pipeline, and indirectly, inside gmsh-wasm's meshing pipeline. OCCT is licensed under the **GNU Lesser General Public License, version 2.1**, with an additional exception granted by its authors.

Anyone who needs to use Gmsh under terms other than the GPL can obtain a separate commercial license directly from its authors at [gmsh.info](https://gmsh.info).

The MCP server bundle additionally includes [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) and [`zod`](https://github.com/colinhacks/zod), both distributed under the **MIT License** — GPL-compatible, so bundling them into the shipped extension is fine. [`fflate`](https://github.com/101arrowz/fflate) (used to build/read the Save/Load Preprocess `.zip` archives, in both the extension and MCP server bundles) is also **MIT**-licensed. [`@meshioplusplus/wasm`](https://github.com/loumalouomega/meshioplusplus) (mesh I/O for VTK/MED/CGNS/Exodus/XDMF/MDPA and more, compiled to WebAssembly, used to import those formats and to export generated FE meshes to MED/CGNS) is also **MIT**-licensed, including the compiled `.wasm` binary as shipped in its npm package.

### Attribution

- **Gmsh** — C. Geuzaine and J.-F. Remacle. <https://gmsh.info>
- **OpenCASCADE Technology (OCCT)** — <https://dev.opencascade.org>
- **meshio++** — V. Mataix Ferrándiz. <https://github.com/loumalouomega/meshioplusplus>

## License

See [LICENSE](LICENSE).
