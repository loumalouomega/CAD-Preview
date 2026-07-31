---
layout: home

hero:
  name: CAD Preview
  text: Interactive 3D CAD and mesh previews in VS Code
  tagline: Open a STEP, IGES, BREP, STL, OBJ, PLY, or glTF file — CAD Preview renders it instantly inside the editor with full orbit, pan, and zoom.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: Architecture
      link: /architecture
    - theme: alt
      text: GitHub
      link: https://github.com/loumalouomega/CAD-Preview

features:
  - icon: 🏗️
    title: B-rep Tessellation via OpenCascade.js
    details: STEP, IGES, and BREP files are parsed and tessellated by the OCCT kernel (compiled to WebAssembly). The WASM runs in the Node extension host — never in the webview — so there are no CSP issues and pure-mesh files never pay the WASM startup cost.

  - icon: 🎨
    title: Native Three.js Mesh Loading
    details: STL, OBJ, PLY, and glTF/GLB files are loaded directly by Three.js loaders via a webview URI. No host round-trip, no tessellation — just fast native parsing.

  - icon: 🧭
    title: Orientation Cube & View Controls
    details: A labeled orientation gizmo mirrors the current camera direction. Click any face to snap to that standard view. The collapsible view-controls panel lets you step-rotate, pan, zoom, fit, or reset the view without touching the mouse — plus a live uncapped clipping plane, a background/opacity Appearance group, and a perspective/orthographic toggle.

  - icon: 🌲
    title: Component Tree Panel
    details: For multi-solid B-rep assemblies or multi-mesh glTF files, a component tree panel shows the hierarchy. Click any node to highlight that solid in the 3D view.

  - icon: 🏷️
    title: Define Parts (Volumes / Surfaces / Lines / Points)
    details: Click solids, faces, edges, or vertices in the 3D view and assign them to named parts (FEM sub-model-parts). Assignments are colour-highlighted, listed in a panel, and autosaved to a `<model>.parts.json` sidecar — the CAD file stays read-only. Per-part eye-toggles and a panel-level Isolate button (plus a matching filter/eye-toggle on the Components tree) let you focus on just the geometry you're working on, display-only and never persisted.

  - icon: ✏️
    title: Non-destructive Editing
    details: Apply transforms (move / rotate / scale / mirror), booleans (unite / subtract / intersect), fillet/chamfer, feature modeling (extrude / revolve / sweep / loft), assembly ops (explode / mate), primitive creation (box/cube, sphere, cylinder, cone, torus, prism), 2D profile sketches (circle, rectangle, polygon) for use as extrude/revolve/sweep/loft profiles, and bottom-up wireframe modeling (points, lines, arcs → surfaces from lines → volumes from surfaces). Edits are undoable, replayable, and autosaved to a `<model>.edits.json` sidecar — the CAD file stays read-only, and edits are baked in only on Export.

  - icon: 🔬
    title: Display Modes & Grid Helpers
    details: Five rendering modes — Shaded, Wireframe, X-Ray, Hidden Lines, and Flat/unlit — plus world-space axes and a reference grid, all from the view-controls panel and toolbar.

  - icon: 🚀
    title: Lazy WASM, Fast Activation
    details: The OpenCascade.js kernel is initialized only on the first B-rep open and then memoized. Opening STL or glTF files never loads the WASM at all. Extension activation is instant.

  - icon: 💾
    title: Export to a Compatible Format
    details: Convert the open model and save it via a native dialog. B-rep files (STEP/IGES/BREP) can export to each other (true OCCT writers) or to any mesh format; mesh files can export to other mesh formats.

  - icon: 🧮
    title: FE Mesh Generation (Gmsh)
    details: Generate a finite-element mesh of the open model with Gmsh compiled to WebAssembly, shown as an overlay on top of the existing geometry, alongside a quality summary (min/mean element quality plus a histogram). Options autosave to a `<model>.mesh.json` sidecar plus a generated `<model>.geo` script; export the result as hand-written Kratos MDPA (the default, preserving named Parts as SubModelParts) or any Gmsh format the panel offers (.msh, .msh2, .geo_unrolled, VTK, I-DEAS Universal, Abaqus, Nastran, SU2, INRIA Medit, STL, Diffpack, OFF). The CAD file stays read-only.

  - icon: 🤖
    title: MCP Server for AI Agents
    details: A standalone Model Context Protocol stdio server (`dist/mcp-server.js`) exposes the same load/edit/mesh/export pipeline headless — no VS Code required. Agents like Claude Code can apply edit operations, manage parts and parametric variables, generate/export FE meshes, and query mass properties, persisting to the same sidecar files the extension reads. See the MCP Server reference page.

  - icon: 📏
    title: Measurement & Mass Properties
    details: Measure distance, edge length, angle, and circle/arc radius directly in the 3D view — a display-only overlay, never persisted. The Mass Properties panel computes volume, area, length, center of mass, and moments of inertia for the whole model or a single selected entity, via OpenCascade.js's BRepGProp for B-rep sources or client-side triangle math for mesh sources.

  - icon: 📷
    title: Screenshot & Settings
    details: Save the current view as a PNG via the toolbar or Command Palette. A handful of cadPreview.* VS Code settings (background colour, mesh-size preset, grid/axes visibility, up-axis) set cross-document defaults for newly opened files.
---

## See It in Action

[![The CAD Preview editor — 3D viewer, orientation cube, Components/Parts/Edits/FE Mesh sidebar, toolbar, and view controls.](/screenshots/viewer-main.png)](/getting-started)

<p style="text-align:center; opacity:0.75; margin-top:-0.5rem;"><em>Previewing a STEP model with colour-coded parts, parametric variables, and every panel live. See the <a href="/getting-started">Getting Started</a> guide for a walkthrough of each feature.</em></p>

<div style="display:flex; gap:1rem; flex-wrap:wrap; justify-content:center; margin-top:1.5rem;">
  <img src="/screenshots/edits-geometry.png" alt="Geometry creation ops" style="max-width:240px; flex:0 1 220px;" />
  <img src="/screenshots/parts-panel.png" alt="Named colour-coded parts" style="max-width:240px; flex:0 1 220px;" />
  <img src="/screenshots/mesh-overlay.png" alt="Generated FE mesh overlay" style="max-width:400px; flex:0 1 360px;" />
</div>

## Supported Formats

| Format | Extensions      | Pipeline                               |
| ------ | --------------- | -------------------------------------- |
| STEP   | `.step`, `.stp` | OpenCascade.js → BRepMesh tessellation |
| IGES   | `.iges`, `.igs` | OpenCascade.js → BRepMesh tessellation |
| BREP   | `.brep`         | OpenCascade.js → BRepMesh tessellation |
| STL    | `.stl`          | Three.js `STLLoader`                   |
| OBJ    | `.obj`          | Three.js `OBJLoader`                   |
| PLY    | `.ply`          | Three.js `PLYLoader`                   |
| glTF   | `.gltf`, `.glb` | Three.js `GLTFLoader`                  |

## Badges

[![CI](https://github.com/loumalouomega/CAD-Preview/actions/workflows/ci.yml/badge.svg)](https://github.com/loumalouomega/CAD-Preview/actions/workflows/ci.yml) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://loumalouomega.github.io/CAD-Preview/) [![VS Code Engine](https://img.shields.io/badge/VS%20Code-%5E1.80-blue?logo=visualstudiocode)](https://code.visualstudio.com/) [![Three.js](https://img.shields.io/badge/Three.js-r160-black?logo=threedotjs)](https://threejs.org/) [![OpenCascade.js](https://img.shields.io/badge/OpenCascade.js-1.x-orange)](https://ocjs.org/) [![License](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)](https://github.com/loumalouomega/CAD-Preview/blob/master/LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)
