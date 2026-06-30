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
    details: A labeled orientation gizmo mirrors the current camera direction. Click any face to snap to that standard view. The collapsible view-controls panel lets you step-rotate, pan, zoom, fit, or reset the view without touching the mouse.

  - icon: 🌲
    title: Component Tree Panel
    details: For multi-solid B-rep assemblies or multi-mesh glTF files, a component tree panel shows the hierarchy. Click any node to highlight that solid in the 3D view.

  - icon: 🏷️
    title: Define Parts (Volumes / Surfaces / Lines)
    details: Click solids, faces, or edges in the 3D view and assign them to named parts (FEM sub-model-parts). Assignments are colour-highlighted, listed in a panel, and autosaved to a `<model>.parts.json` sidecar — the CAD file stays read-only.

  - icon: ✏️
    title: Non-destructive Editing
    details: Apply transform operations (move / rotate / scale / mirror) to selected volumes. Edits are undoable, replayable, and autosaved to a `<model>.edits.json` sidecar — the CAD file stays read-only, and edits are baked in only on Export. Booleans, feature modeling and assembly ops land in later milestones.

  - icon: 🔬
    title: Wireframe & Grid Helpers
    details: Toggle wireframe rendering, world-space axes, and a reference grid — all from the toolbar.

  - icon: 🚀
    title: Lazy WASM, Fast Activation
    details: The OpenCascade.js kernel is initialized only on the first B-rep open and then memoized. Opening STL or glTF files never loads the WASM at all. Extension activation is instant.

  - icon: 💾
    title: Export to a Compatible Format
    details: Convert the open model and save it via a native dialog. B-rep files (STEP/IGES/BREP) can export to each other (true OCCT writers) or to any mesh format; mesh files can export to other mesh formats.
---

## Supported Formats

| Format | Extensions | Pipeline |
|--------|-----------|----------|
| STEP | `.step`, `.stp` | OpenCascade.js → BRepMesh tessellation |
| IGES | `.iges`, `.igs` | OpenCascade.js → BRepMesh tessellation |
| BREP | `.brep` | OpenCascade.js → BRepMesh tessellation |
| STL | `.stl` | Three.js `STLLoader` |
| OBJ | `.obj` | Three.js `OBJLoader` |
| PLY | `.ply` | Three.js `PLYLoader` |
| glTF | `.gltf`, `.glb` | Three.js `GLTFLoader` |

## Badges

[![CI](https://github.com/loumalouomega/CAD-Preview/actions/workflows/ci.yml/badge.svg)](https://github.com/loumalouomega/CAD-Preview/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-online-blue)](https://loumalouomega.github.io/CAD-Preview/)
[![VS Code Engine](https://img.shields.io/badge/VS%20Code-%5E1.80-blue?logo=visualstudiocode)](https://code.visualstudio.com/)
[![Three.js](https://img.shields.io/badge/Three.js-r160-black?logo=threedotjs)](https://threejs.org/)
[![OpenCascade.js](https://img.shields.io/badge/OpenCascade.js-1.x-orange)](https://ocjs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](https://github.com/loumalouomega/CAD-Preview/blob/master/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)
