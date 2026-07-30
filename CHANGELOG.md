# Changelog

All notable changes to the "CAD Preview" extension are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this
project does not yet strictly follow Semantic Versioning (pre-1.0 releases moved
fast and bundled multiple features per bump).

## [1.1.0] - 2026-07-30

### Added
- **Toolbar dropdown menus.** The toolbar had grown to ~21 controls in one
  strip; it's now three always-visible buttons (**Fit**, **Tree**,
  **FE&nbsp;Mesh**) plus four dropdowns — **View ▾** (Grid, Edges,
  Screenshot), **Select ▾** (selection mode + Point/Vol/Surf/Line),
  **Measure ▾** (measure mode + Distance/Length/Angle/Radius + Clear), and
  **Markup ▾** (markup mode + the six drawing tools, colour, Undo/Redo/Clear).
  A trigger stays highlighted while its mode is active, so you can still tell
  at a glance that Measure or Markup is live once the panel has closed.
  Measurement results moved to their own line below the toolbar.
- **A complete icon set.** Every remaining emoji (`▦ 📐 📷 ✎`) and unicode
  placeholder (`⊙ ＋ ↶ ↷`) is now a generated, monochrome SVG icon that tracks
  the VS Code theme — 41 icons in total, covering the toolbar, both tool
  pickers, the five Display modes, and the Parts/Edits/Variables/FE&nbsp;Mesh
  panel buttons.
- **Display modes** — five mutually exclusive whole-model rendering modes
  (Shaded, Wireframe, X-Ray, Hidden Lines, Flat), replacing the old standalone
  Wireframe toggle.
- **Markup annotations** — draw freehand/line/arrow/rectangle/circle review
  notes over the 3D view, with undo/redo and an eraser. Session-only, and baked
  into Screenshot exports.
- **Measurement tools** — distance, edge length, angle, and radius, shown as a
  live overlay in the view.
- **Mass properties** — volume, surface area, centre of mass, and moments of
  inertia for the whole model or a selected solid/face/edge.
- **Screenshot** — save the current view as a PNG from the toolbar, the File
  menu, or the `CAD Preview: Screenshot to PNG…` command.
- **Settings** — cross-document defaults under **CAD Preview** in the Settings
  UI: `background`, `showGridAndAxesOnOpen`, `upAxis`, and
  `defaultMeshSizePreset`.
- **Visualization and UX depth** — drag-and-drop to open, per-part
  isolate/hide plus a Components-tree filter, a live exploded-view slider,
  background/opacity controls, live clipping/section planes, FE mesh quality
  statistics, and an orthographic/perspective camera toggle.
- **Units handling** — the declared unit of a STEP file is detected and shown,
  and a display-unit selector (mm/cm/m/in/ft) rescales mass-properties and
  measurement readouts. Presentation only; stored geometry is unchanged.
- **Model comparison** — `CAD Preview: Compare Models…` diffs two B-rep
  documents and reports matched/added/removed solids with the centre
  displacement and volume delta behind each match.
- **meshio++ integration** — VTK/VTU, MED, CGNS, Exodus, XDMF, and Kratos MDPA
  files open as viewable boundary surfaces, and generated FE meshes can be
  exported to MED, CGNS, and XDMF (formats Gmsh's own writers can't produce).
  Geometry only — region names and field data are not preserved.
- **Hex-dominant meshing** — a third element shape alongside simplex and
  subdivided, producing a mixed tet/hex mesh.
- **Save / Load Preprocess** — bundle a CAD file and its sidecars into a single
  `.zip` and restore it later.
- **New MCP tools for agents** — `inspect` and `measure` (fact-only entity
  queries), `render_snapshot` (headless multi-view images),
  `get_mass_properties`, `compare_models`, `search_standard_parts` /
  `download_standard_part` (fasteners, bearings, and more from
  [step.parts](https://www.step.parts)), and `run_parametric_script` for
  declarative, re-runnable part scripts.

### Changed
- Default 3D meshing algorithm is now Gmsh's own Delaunay, after the
  wasm-stack-overflow bug that forced the Frontal workaround was fixed upstream
  in `@loumalouomega/gmsh-wasm` 0.3.0. Existing documents keep whatever is
  already saved in their `.mesh.json`.

### Fixed
- The **File ▾** menu could not be dismissed by clicking its own icon — the
  click closed and immediately reopened it.
- Clicking away from an open menu no longer also acts on whatever is
  underneath; with markup mode on, that click used to draw a stroke.

## [1.0.5] - 2026-07-19

### Changed
- Dependency maintenance: bumped `actions/setup-node` and
  `softprops/action-gh-release`, and added `package.json` overrides for `vite`,
  `fast-uri`, and `@hono/node-server`.

## [1.0.4] - 2026-07-18

### Added
- A "What's New" panel that opens automatically the first time you use the
  extension after an update, summarizing everything that changed since the
  version you last had installed. It won't show again until the next update;
  reopen it anytime via **CAD Preview: Show What's New** in the Command
  Palette (which always shows the full changelog).

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

[1.1.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.0.5...v1.1.0
[1.0.5]: https://github.com/loumalouomega/CAD-Preview/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/loumalouomega/CAD-Preview/compare/v1.0.3...v1.0.4
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
