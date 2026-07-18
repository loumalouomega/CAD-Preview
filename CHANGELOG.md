# Changelog

All notable changes to the "CAD Preview" extension are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this
project does not yet strictly follow Semantic Versioning (pre-1.0 releases moved
fast and bundled multiple features per bump).

## [1.0.3] - 2026-07-17

### Changed
- Dependency maintenance: bumped `esbuild`, `typescript`, `@types/node`,
  `@vscode/vsce`, `three` / `@types/three`, `vitest`, `three-bvh-csg`, and several
  GitHub Actions (`upload-pages-artifact`, `deploy-pages`, `upload-artifact`,
  `dependency-review-action`, `checkout`) to their latest compatible versions.

## [1.0.2] - 2026-07-13

### Fixed
- Adjusted gmsh-wasm handling in the esbuild config and `.vscodeignore` so the
  packaged extension bundles it correctly.

## [1.0.1] - 2026-07-13

### Fixed
- Marked `ws` as external in the esbuild config and adjusted gmsh-wasm
  initialization to fix packaging/runtime issues introduced in 1.0.0.

## [1.0.0] - 2026-07-13

### Changed
- First stable 1.0 release. Version and dependency bump; adjusted gmsh-wasm
  loading in `gmshService.ts` and fixed the MCP server's reported version.

## [0.9.0] - 2026-07-13

### Added
- Save/preprocessing improvements around the sidecar save pipeline (Save,
  Save As, Export flows).

## [0.8.0] - 2026-07-12

### Added
- **MCP server**: a standalone stdio MCP server (`dist/mcp-server.js`) exposing
  the load/edit/mesh/export pipeline to AI agents with no VS Code required —
  load models, apply edit operations, generate meshes, and export, all headless.

## [0.7.5] - 2026-07-08

### Added
- New automated screenshot-generation pipeline for documentation
  (`npm run docs:screenshots`), rendering the real shipped viewer DOM against
  live OCCT/Gmsh output instead of hand-captured images.

## [0.7.4] - 2026-07-08

### Added
- Top **File** menu (Open / Save / Save As / Export) with matching commands
  and keybindings (`Ctrl+O`, `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+E`).

## [0.7.2] - 2026-07-07

### Added
- **Parametric variables**: named variables (e.g. `L = 20`) usable as
  expressions in edit-operation fields, with live re-resolution when a
  variable changes.
- Operation removal: a per-row control to remove a single op from the edit
  history without discarding everything applied after it.

## [0.7.0] - 2026-07-06

### Improved
- General meshing improvements to the GMSH-based FE meshing pipeline.

## [0.6.5] - 2026-07-06

### Added
- Redesigned Edits panel with **GEOMETRY** / **EDIT** top-level tabs (2D/3D
  subtabs under GEOMETRY) and 16 new modeling operations.
- Replaced emoji toolbar/panel icons with theme-adaptive, monochrome SVG
  icons that track VS Code's light/dark theme.

## [0.6.0] - 2026-07-03

### Added
- Meshing panel size controls (coarser→finer slider with bounding-box-derived
  default, Coarse/Medium/Fine presets) and a large-mesh warning.

## [0.5.6] - 2026-07-03

### Changed
- Meshing panel refinements: size controls and large-mesh warning follow-up.

## [0.5.5] - 2026-07-03

### Added
- VS Code Marketplace publishing step in the CI workflow.

### Fixed
- Documentation formatting corrections.

## [0.5.1] - 2026-07-03

### Added
- **FE meshing** via GMSH-WASM: generate finite-element meshes (nodes +
  triangles/tetrahedra) from the displayed model, shown as an overlay.
- Parts-preserving meshing (Gmsh physical groups) and multi-format mesh
  export, including Kratos MDPA.

## [0.4.0] - 2026-07-01

### Added
- **Non-destructive geometry editing**: transforms (move/rotate/scale/
  mirror), booleans, fillet/chamfer, feature modeling (extrude/revolve/
  sweep/loft), primitives, 2D profile sketches, and bottom-up wireframe
  modeling (points/lines/arcs → surfaces → volumes). Edits persist to a
  `<model>.edits.json` sidecar and are re-applied on every open; the source
  CAD file is never modified.

## [0.1.8] - 2026-06-30

### Added
- **Geometry parts**: assign volumes, surfaces, and lines to named parts by
  clicking in the view. Assignments persist to a `<model>.parts.json`
  sidecar.

## [0.1.5] - 2026-06-29

### Added
- View-manipulation panel (stepped rotate/pan/zoom, fit-to-view) and an
  orientation gizmo cube.
- VitePress-based documentation site.

## [0.1.2] - 2026-06-29

### Changed
- Updated the extension publisher id to `kratos-multiphysics`.

## [0.1.1] - 2026-06-29

### Added
- GitHub Actions workflow to build and package the extension (`.vsix`) for
  releases.

## [0.1.0] - 2026-06-29

### Added
- Initial release: read-only 3D preview for CAD and mesh files (STEP, IGES,
  BREP, STL, OBJ, PLY, glTF) inside a VS Code custom editor, using
  OpenCascade.js (OCCT WASM) in the extension host for B-rep formats and
  Three.js in the webview for rendering.

[1.0.3]: https://github.com/loumalouomega/CAD-Preview/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/loumalouomega/CAD-Preview/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/loumalouomega/CAD-Preview/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/loumalouomega/CAD-Preview/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/loumalouomega/CAD-Preview/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/loumalouomega/CAD-Preview/compare/v0.7.5...v0.8.0
[0.7.5]: https://github.com/loumalouomega/CAD-Preview/compare/v0.7.4...v0.7.5
[0.7.4]: https://github.com/loumalouomega/CAD-Preview/compare/v0.7.2...v0.7.4
[0.7.2]: https://github.com/loumalouomega/CAD-Preview/compare/v0.7.1...v0.7.2
[0.7.0]: https://github.com/loumalouomega/CAD-Preview/compare/v0.6.5...v0.7.0
[0.6.5]: https://github.com/loumalouomega/CAD-Preview/compare/v0.6.0...v0.6.5
[0.6.0]: https://github.com/loumalouomega/CAD-Preview/compare/v0.5.6...v0.6.0
[0.5.6]: https://github.com/loumalouomega/CAD-Preview/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/loumalouomega/CAD-Preview/compare/v0.5.1...v0.5.5
[0.5.1]: https://github.com/loumalouomega/CAD-Preview/compare/v0.4.0...v0.5.1
[0.4.0]: https://github.com/loumalouomega/CAD-Preview/compare/v0.1.8...v0.4.0
[0.1.8]: https://github.com/loumalouomega/CAD-Preview/compare/v0.1.5...v0.1.8
[0.1.5]: https://github.com/loumalouomega/CAD-Preview/compare/v0.1.2...v0.1.5
[0.1.2]: https://github.com/loumalouomega/CAD-Preview/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/loumalouomega/CAD-Preview/compare/v0.1...v0.1.1
[0.1.0]: https://github.com/loumalouomega/CAD-Preview/releases/tag/v0.1
