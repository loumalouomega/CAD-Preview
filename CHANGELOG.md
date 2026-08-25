# Changelog

All notable changes to the "CAD Preview" extension are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project does not yet strictly follow Semantic Versioning (pre-1.0 releases moved fast and bundled multiple features per bump).

## [1.5.0] - 2026-08-25

### Added

- **DXF import and export** — the 2D drawing interchange format the CAM/laser-cutting/AutoCAD audience actually uses, at both ends of the pipeline. **File ▾ ▸ Import DXF…** reads a `.dxf` file's model-space `LINE` / `LWPOLYLINE` (bulge arcs sampled) / `POLYLINE` / `CIRCLE` / `ARC` / `SPLINE` entities into the existing sketch edit ops (B-rep sources only; blocks/INSERT/TEXT/DIMENSION/HATCH and paper space are skipped), and a new **File ▾ ▸ Export Silhouette DXF…** writes the silhouette outline as minimal model-space `ENTITIES` (`LWPOLYLINE` chains + `LINE` singletons) over the exact same segment list the SVG exporter serializes — so an SVG and a DXF of one view are geometrically consistent. The `export_svg_silhouette` MCP tool gained an optional `format: "svg" | "dxf"` param (plus `chainCount`/`lineCount` in the response) rather than a second tool.
- **Split view with per-pane cameras.** View ▾ now offers 1×1 / 1×2 / 2×1 / 2×2 viewport layouts over one scene — each pane its own orbitable camera, the orientation cube and gizmo following focus, selection/display modes/clip planes shared across all panes. Layouts and each pane's camera persist to `<model>.view.json`, so reopening restores exactly what you left.
- **Linked cameras across tabs** (View ▾): when enabled, orbiting/zooming one open CAD Preview tab drives every other open tab's camera in real time.
- **Query-based selection filters** (Select ▾): select faces by direction, planarity, area threshold, or largest/smallest N; lines by axis alignment, length, or longest/shortest N — with a seam-exclusion toggle and Select/Add buttons, instead of clicking entities one by one.
- **OpenFOAM case import** (`.foam` marker files) via the meshio++ bridge, and Kratos MDPA files with non-sequential node ids now load correctly (meshio++ ≥ 9.13).
- **Op-history scrubbing**: the Edits panel's history is now click-to-jump — applied ops render normally and redo-buffer ops render as dimmed pending rows; clicking any row moves the stack straight to that point in one step.

### Changed

- **Mesh mass properties now warn when a mesh source isn't watertight**, since the computed volume may not be meaningful for an open surface.
- **Picking ignores hidden geometry** — clicks no longer land on entities hidden via a Part's eye toggle, Isolate, or an active FE-mesh overlay.
- **Edit replay outcomes are visible**: an op that silently skipped during replay (unresolved operands after an id shift, a fillet radius too large, …) is now marked ⚠ in the Edits history with a diagnostic and hint, surfaced as warnings by the MCP tools instead of looking like a quiet no-op.
- **Dense-mesh safety guard**: Boolean/hole operations on a webview-side mesh above ~150 k combined triangles are refused with guidance to promote to B-rep first, instead of freezing the UI.
- **Faster picking on large meshes**: kept-whole meshes (organic scans above the facet limit) build a BVH acceleration structure, turning raycasting from milliseconds to near-zero per move.
- **Document-derived text is sanitized** — meshio region/data-array names quoted in status lines, MCP warnings, and auto-created Part names are stripped of control/bidi/format characters and truncated, so a hostile file can't smuggle instructions through them.
- **`inspect` now reports `planeOrigin` for planar faces** (the plane's own origin, usable directly as `planePoint` for Split/Section/Mirror), alongside the existing normal.
- **Mirror rejects a zero-length `planeNormal` up front** (sidecar parse, MCP, and parametric scripts) instead of silently skipping during replay.
- Dependency refreshes: `@meshioplusplus/wasm` 10.x (OpenFOAM reader/writer, MDPA id preservation), `js-yaml` 4.3.1, dev-dependency group bumps.

## [1.4.0] - 2026-08-04

### Added

- **SVG silhouette export.** A new **File ▾ ▸ Export Silhouette SVG…** (and the `CAD Preview: Export Silhouette SVG…` command, and the `export_svg_silhouette` MCP tool) writes a 2D outline of the model as a vector drawing — from the view you're currently looking at, or from a named view (Front/Back/Top/Bottom/Left/Right/Iso). Works for every source with host-side geometry: STEP/IGES/BREP with edits baked in, plus STL/OBJ/PLY/glTF. 1 SVG unit = 1 model unit, so it prints 1:1, and the same mm/cm/m/in/ft conversion every other export offers applies here too. **It is an outline, not a dimensioned technical drawing** — there is no hidden-line removal, so interior feature edges that don't lie on a silhouette aren't drawn. (OCCT's hidden-line machinery is entirely unavailable in this WebAssembly build; the one remaining alternative was probed against the live kernel and produced a visibly worse drawing, missing holes and cutouts the shipped approach draws correctly.)
- **Compare Models, mesh health, and Mesh → B-rep promotion now support glTF/GLB**, the last format that was still excluded. `CAD Preview: Compare Models…` (and `compare_models`) can now diff `.gltf`/`.glb` against any other supported format, `check_mesh_health` reports on them, and `promote_mesh_to_brep` turns one into a real STEP/IGES/BREP solid. This is a new host-side glTF parser, cross-validated in the test suite against three.js's own loader — the same loader the 3D view already uses to display these files — which is what made hand-rolling it defensible after it was previously ruled out for lack of a way to validate it.

### Changed

- **Mesh health and promotion now refuse a mesh above 50 000 triangles** with a clear message instead of grinding to a halt. Both build one CAD face per triangle, which was always a risk for a large mesh and becomes a likely one now that glTF — a rendering format whose files are routinely far larger than hand-authored STL/OBJ/PLY — is accepted.

## [1.3.0] - 2026-08-03

### Added

- **STEP assembly structure.** The Components tree now shows a STEP file's real nested assembly/component hierarchy — matching how the file's author organized it — instead of always flattening every solid into one list; a source with no real assembly structure still falls back to the flat list as before. STEP export now also carries per-part names into the exported file's `PRODUCT` entities (per-label colors remain unsupported — confirmed non-functional in both directions in this OCCT build).
- **Standard Parts panel.** Search the hosted [step.parts](https://www.step.parts) catalog (fasteners, bearings, connectors, extrusions, …) and insert a result as a new STEP document with one click, from a new sidebar section — previously only available to AI agents via the `search_standard_parts`/`download_standard_part` MCP tools.
- **Align and Linear/Circular Pattern** edit ops, in the Edits panel's Assembly category.
- **Transform Gizmo.** Move/Rotate/Scale now show a draggable 3D handle that live-previews the edit before you click Apply, with optional **Snap to grid** / **Snap to points** (View ▾).
- **Import SVG…** (File ▾) traces a `.svg` file's paths into B-rep sketch polylines, ready to build into a surface or extrude.
- **A cancellable progress notification** for slow STEP/IGES/BREP loads (first open, or reopening after an external change) — clicking Cancel stops the result from being applied. Routine edits stay on the lightweight toolbar status line, since they're normally near-instant.
- **OCCT, Gmsh, and meshio++ now run in a forked child process**, both in the extension and in the standalone MCP server. A hung or crashed kernel operation no longer wedges the whole extension/server — it's killed and a fresh one takes over automatically for the next operation — and Cancel now genuinely interrupts a slow load instead of only discarding its result once it eventually finishes.

## [1.2.0] - 2026-07-31

### Added

- **Unit conversion on export, now everywhere it can be done correctly** — BREP, STL, OBJ, PLY, and glTF exports (and, separately, the FE Mesh panel's own Gmsh-format export: `.msh`, Kratos MDPA, VTK, and the rest) can now be scaled to mm/cm/m/in/ft on the way out, a real geometric transform applied to the exported file's coordinates, not just a display change. STEP/IGES exports deliberately stay native mm — this OCCT WASM build has no verified way to set those formats' own declared header unit, and shipping a file whose header disagrees with its geometry would be worse than not offering the option.
- **IGES unit detection** — the view-controls Units dropdown now auto-detects and selects an opened IGES file's declared unit, the same way it already did for STEP.
- **Compare Models now supports STL, OBJ, and PLY**, in addition to STEP/IGES/BREP — `CAD Preview: Compare Models…` (and the `compare_models` MCP tool) can diff any combination of these formats against each other, via new host-side parsers (glTF remains unsupported: a correct parser needs meaningfully more surface area than the others, with no realistic way to validate it against real-world exporter variety).
- **Exact-precision measurement** — a new "⟟ Exact" button next to a completed Distance / Edge Length / Radius measurement recomputes it against the true OCCT geometry instead of the displayed triangulation; also available headless as the new `measure_exact` MCP tool.
- **Best-effort entity-id rebinding** — a Part assigned to a face or edge now usually keeps pointing at the right geometry after a Boolean, Fillet, or feature-modeling edit applied elsewhere in the model, instead of silently losing that reference the next time the file reloads.
- **meshio++ import visibility** — opening a VTK/MED/CGNS/Exodus/XDMF/MDPA file now shows a status line (and a `load_model` warning via MCP) naming any named regions and data arrays the source file declares. Still geometry-only — nothing is converted into Parts or colourable data yet — but no longer silent about what's actually in the file.

### Fixed

- The MCP server (and its `render_snapshot` tool) no longer crashes outright on Node.js < 20. A routine Playwright dependency update started calling `process.exit()` at import time on older Node versions — not a catchable exception — so the server now checks the Node version before ever attempting that import, degrading gracefully instead.

### Changed

- Bumped `@meshioplusplus/wasm` to 9.9.0.

## [1.1.3] - 2026-07-30

### Added

- **Toolbar dropdown menus.** The toolbar had grown to ~21 controls in one strip; it's now three always-visible buttons (**Fit**, **Tree**, **FE&nbsp;Mesh**) plus four dropdowns — **View ▾** (Grid, Edges, Screenshot), **Select ▾** (selection mode + Point/Vol/Surf/Line), **Measure ▾** (measure mode + Distance/Length/Angle/Radius + Clear), and **Markup ▾** (markup mode + the six drawing tools, colour, Undo/Redo/Clear). A trigger stays highlighted while its mode is active, so you can still tell at a glance that Measure or Markup is live once the panel has closed. Measurement results moved to their own line below the toolbar.
- **A complete icon set.** Every remaining emoji (`▦ 📐 📷 ✎`) and unicode placeholder (`⊙ ＋ ↶ ↷`) is now a generated, monochrome SVG icon that tracks the VS Code theme — 41 icons in total, covering the toolbar, both tool pickers, the five Display modes, and the Parts/Edits/Variables/FE&nbsp;Mesh panel buttons. The Edits panel's 46 op buttons (Move, Box, Fillet, Boolean Subtract, and so on) are now real icons too, replacing their unicode placeholders.
- **Display modes** — five mutually exclusive whole-model rendering modes (Shaded, Wireframe, X-Ray, Hidden Lines, Flat), replacing the old standalone Wireframe toggle.
- **Markup annotations** — draw freehand/line/arrow/rectangle/circle review notes over the 3D view, with undo/redo and an eraser. Session-only, and baked into Screenshot exports.
- **Measurement tools** — distance, edge length, angle, and radius, shown as a live overlay in the view.
- **Mass properties** — volume, surface area, centre of mass, and moments of inertia for the whole model or a selected solid/face/edge.
- **Screenshot** — save the current view as a PNG from the toolbar, the File menu, or the `CAD Preview: Screenshot to PNG…` command.
- **Settings** — cross-document defaults under **CAD Preview** in the Settings UI: `background`, `showGridAndAxesOnOpen`, `upAxis`, and `defaultMeshSizePreset`.
- **Visualization and UX depth** — drag-and-drop to open, per-part isolate/hide plus a Components-tree filter, a live exploded-view slider, background/opacity controls, live clipping/section planes, FE mesh quality statistics, and an orthographic/perspective camera toggle.
- **Capped clipping planes.** The live clip/section plane now shows a real solid cross-section at the cut face instead of a see-through hollow.
- **Units handling** — the declared unit of a STEP file is detected and shown, and a display-unit selector (mm/cm/m/in/ft) rescales mass-properties and measurement readouts. Presentation only; stored geometry is unchanged.
- **Model comparison** — `CAD Preview: Compare Models…` diffs two B-rep documents and reports matched/added/removed solids with the centre displacement and volume delta behind each match.
- **meshio++ integration** — VTK/VTU, MED, CGNS, Exodus, XDMF, and Kratos MDPA files open as viewable boundary surfaces, and generated FE meshes can be exported to MED, CGNS, and XDMF (formats Gmsh's own writers can't produce). Geometry only — region names and field data are not preserved.
- **Hex-dominant meshing** — a third element shape alongside simplex and subdivided, producing a mixed tet/hex mesh.
- **Save / Load Preprocess** — bundle a CAD file and its sidecars into a single `.zip` and restore it later.
- **New MCP tools for agents** — `inspect` and `measure` (fact-only entity queries), `render_snapshot` (headless multi-view images), `get_mass_properties`, `compare_models`, `search_standard_parts` / `download_standard_part` (fasteners, bearings, and more from [step.parts](https://www.step.parts)), and `run_parametric_script` for declarative, re-runnable part scripts.

### Changed

- Default 3D meshing algorithm is now Gmsh's own Delaunay, after the wasm-stack-overflow bug that forced the Frontal workaround was fixed upstream in `@loumalouomega/gmsh-wasm` 0.3.0. Existing documents keep whatever is already saved in their `.mesh.json`.
- Bumped `@meshioplusplus/wasm` to 9.8.0, which closes two upstream gaps this extension previously had to work around: exporting a generated mesh to MED now preserves part names directly (no more MED-specific two-step), and exporting a 2D-dimension mesh to CGNS now produces a file that reads back correctly (it used to round-trip cleanly only for 3D volume meshes).

### Fixed

- The **File ▾** menu could not be dismissed by clicking its own icon — the click closed and immediately reopened it.
- Clicking away from an open menu no longer also acts on whatever is underneath; with markup mode on, that click used to draw a stroke.
- The measurement pick marker rendered at a fixed 1 world-unit size — massive and out of proportion on small (e.g. mm-scale) models. It now scales with the model, matching the existing point-mode vertex markers.

## [1.0.5] - 2026-07-19

### Changed

- Dependency maintenance: bumped `actions/setup-node` and `softprops/action-gh-release`, and added `package.json` overrides for `vite`, `fast-uri`, and `@hono/node-server`.

## [1.0.4] - 2026-07-18

### Added

- A "What's New" panel that opens automatically the first time you use the extension after an update, summarizing everything that changed since the version you last had installed. It won't show again until the next update; reopen it anytime via **CAD Preview: Show What's New** in the Command Palette (which always shows the full changelog).

## [1.0.3] - 2026-07-17

### Changed

- Dependency maintenance: bumped `esbuild`, `typescript`, `@types/node`, `@vscode/vsce`, `three` / `@types/three`, `vitest`, `three-bvh-csg`, and several GitHub Actions (`upload-pages-artifact`, `deploy-pages`, `upload-artifact`, `dependency-review-action`, `checkout`) to their latest compatible versions.

## [1.0.2] - 2026-07-13

### Fixed

- Adjusted gmsh-wasm handling in the esbuild config and `.vscodeignore` so the packaged extension bundles it correctly.

## [1.0.1] - 2026-07-13

### Fixed

- Marked `ws` as external in the esbuild config and adjusted gmsh-wasm initialization to fix packaging/runtime issues introduced in 1.0.0.

## [1.0.0] - 2026-07-13

### Changed

- First stable 1.0 release. Version and dependency bump; adjusted gmsh-wasm loading in `gmshService.ts` and fixed the MCP server's reported version.

## [0.9.0] - 2026-07-13

### Added

- Save/preprocessing improvements around the sidecar save pipeline (Save, Save As, Export flows).

## [0.8.0] - 2026-07-12

### Added

- **MCP server**: a standalone stdio MCP server (`dist/mcp-server.js`) exposing the load/edit/mesh/export pipeline to AI agents with no VS Code required — load models, apply edit operations, generate meshes, and export, all headless.

## [0.7.5] - 2026-07-08

### Added

- New automated screenshot-generation pipeline for documentation (`npm run docs:screenshots`), rendering the real shipped viewer DOM against live OCCT/Gmsh output instead of hand-captured images.

## [0.7.4] - 2026-07-08

### Added

- Top **File** menu (Open / Save / Save As / Export) with matching commands and keybindings (`Ctrl+O`, `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+E`).

## [0.7.2] - 2026-07-07

### Added

- **Parametric variables**: named variables (e.g. `L = 20`) usable as expressions in edit-operation fields, with live re-resolution when a variable changes.
- Operation removal: a per-row control to remove a single op from the edit history without discarding everything applied after it.

## [0.7.0] - 2026-07-06

### Improved

- General meshing improvements to the GMSH-based FE meshing pipeline.

## [0.6.5] - 2026-07-06

### Added

- Redesigned Edits panel with **GEOMETRY** / **EDIT** top-level tabs (2D/3D subtabs under GEOMETRY) and 16 new modeling operations.
- Replaced emoji toolbar/panel icons with theme-adaptive, monochrome SVG icons that track VS Code's light/dark theme.

## [0.6.0] - 2026-07-03

### Added

- Meshing panel size controls (coarser→finer slider with bounding-box-derived default, Coarse/Medium/Fine presets) and a large-mesh warning.

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

- **FE meshing** via GMSH-WASM: generate finite-element meshes (nodes + triangles/tetrahedra) from the displayed model, shown as an overlay.
- Parts-preserving meshing (Gmsh physical groups) and multi-format mesh export, including Kratos MDPA.

## [0.4.0] - 2026-07-01

### Added

- **Non-destructive geometry editing**: transforms (move/rotate/scale/ mirror), booleans, fillet/chamfer, feature modeling (extrude/revolve/ sweep/loft), primitives, 2D profile sketches, and bottom-up wireframe modeling (points/lines/arcs → surfaces → volumes). Edits persist to a `<model>.edits.json` sidecar and are re-applied on every open; the source CAD file is never modified.

## [0.1.8] - 2026-06-30

### Added

- **Geometry parts**: assign volumes, surfaces, and lines to named parts by clicking in the view. Assignments persist to a `<model>.parts.json` sidecar.

## [0.1.5] - 2026-06-29

### Added

- View-manipulation panel (stepped rotate/pan/zoom, fit-to-view) and an orientation gizmo cube.
- VitePress-based documentation site.

## [0.1.2] - 2026-06-29

### Changed

- Updated the extension publisher id to `kratos-multiphysics`.

## [0.1.1] - 2026-06-29

### Added

- GitHub Actions workflow to build and package the extension (`.vsix`) for releases.

## [0.1.0] - 2026-06-29

### Added

- Initial release: read-only 3D preview for CAD and mesh files (STEP, IGES, BREP, STL, OBJ, PLY, glTF) inside a VS Code custom editor, using OpenCascade.js (OCCT WASM) in the extension host for B-rep formats and Three.js in the webview for rendering.

[1.5.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.4.1...v1.5.0
[1.4.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.2.6...v1.3.0
[1.2.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/loumalouomega/CAD-Preview/compare/v1.0.5...v1.1.3
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
