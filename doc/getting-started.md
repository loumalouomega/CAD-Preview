# Getting Started

This page is the reference: one section per panel, feature by feature. If you would rather learn
by building something, the [tutorials](/tutorials/) walk through a real part from start to
finish and link back here for the details.

## Installation

Install **CAD Preview** from the VS Code Marketplace:

1. Open VS Code.
2. Press `Ctrl+Shift+X` (or `Cmd+Shift+X` on macOS) to open the Extensions view.
3. Search for **CAD Preview** by `kratos-multiphysics`.
4. Click **Install**.

Alternatively, install from the command line:

```bash
code --install-extension kratos-multiphysics.cad-preview
```

Or download and install the `.vsix` directly:

```bash
code --install-extension cad-preview-<version>.vsix
```

## Settings

CAD Preview contributes a few cross-document defaults under **CAD Preview** in VS Code's Settings UI (`Ctrl+,`, search "CAD Preview"). Most only affect *newly opened* documents — a document's own saved state (a `.mesh.json` sidecar's size, the toolbar Grid toggle for the current session) always wins once set. `tessellationQuality` is the one exception, re-read on every edit (see its own row below).

| Setting | Default | Effect |
| --- | --- | --- |
| `cadPreview.background` | `#1e1e1e` | 3D view background color (CSS hex) |
| `cadPreview.defaultMeshSizePreset` | `medium` | Seeds the FE Mesh panel's target size (Coarse/Medium/Fine) for a model with no saved mesh options yet |
| `cadPreview.showGridAndAxesOnOpen` | `true` | Show the ground grid and axes helper when a model is opened |
| `cadPreview.openscadBinary` | `openscad` | OpenSCAD binary used to convert `.scad` sources to `.csg` on open (resolved via PATH when bare). Wins over the `OPENSCAD_BINARY` environment variable, the headless (MCP server) escape hatch. Unused when no `.scad` file is opened |
| `cadPreview.tessellationQuality` | `standard` | B-rep (STEP/IGES/BREP/CSG/SCAD) tessellation density — `draft`/`standard`/`fine`; `standard` is identical to every previous version's fixed behavior. Unlike the other settings here, re-read on every edit, so a change applies to the next edit without reopening the file. Face triangle density only — does not affect edge display or the FE Mesh panel's own (separate) mesh generation |
| `cadPreview.upAxis` | `y` | Default up-axis for newly opened models — set to `z` for Z-up source conventions |

## Opening a File

CAD Preview activates automatically via the VS Code [Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors). There is nothing to configure.

Open any supported file — for example, from the Explorer or via `File > Open File…`. VS Code routes it to the CAD Preview custom editor and the 3D view renders immediately.

You can also drag a file from the OS file explorer (or another editor tab) and drop it onto the 3D view to open it the same way. If the browser drop event doesn't expose a real filesystem path for the dropped item, CAD Preview falls back to showing the normal **Open…** dialog instead of silently failing.

The **CAD Preview** icon in the Activity Bar opens the **Models** view: every CAD/mesh file in the open workspace folder(s), discovered with the same routing rules (and the same depth cap and `.git`/`node_modules` exclusions) as the headless `list_workspace_models` tool. Click a file to open it in the 3D viewer; the toolbar offers **Open…**, **Refresh**, and **New Blank Model…** (new empty session — always visible, even when the workspace already has models). With no folder open — or no models found — the view shows **Open CAD File…** and **New Blank Model…** buttons instead.

### Starting from Scratch

You don't need an existing file. **File ▾ → New Blank Model…** (also `CAD Preview: New Blank Model…` in the Command Palette, and the **New** button in the Models view toolbar) asks where to put a new `.brep` file, creates it empty, and opens it. From there the **Edits** panel's whole creation vocabulary is available — primitives (Box, Sphere, Cylinder, Cone, Torus, Prism, Wedge), 2D sketch profiles to extrude/revolve/sweep/loft, and bottom-up wireframe modeling (points → lines/arcs → **Build → Surface** → **Build → Volume**) — plus booleans, fillets, chamfers, patterns and everything else that works on a B-rep source.

Two things are worth knowing about how a blank model is stored:

- **The `.brep` file itself stays empty.** Exactly as for an edited STEP file, your geometry is an ordered, replayable op-list in the `<model>.brep.edits.json` sidecar beside it; the CAD file is never written. Keep the pair together, or use **Export…** / **Save Preprocess…** to produce something standalone.
- **Export offers STEP/IGES and the mesh formats, but not BREP** — the export list always excludes a document's own format. Export to STEP for a file that carries the geometry itself.

New Blank Model only ever creates new files: if you point it at a path that already exists it refuses rather than overwriting, since blanking a model would leave its existing edit history replaying against nothing.

### Supported Formats

| Format      | Extensions      | Rendering Pipeline                         |
| ----------- | --------------- | ------------------------------------------ |
| STEP        | `.step`, `.stp` | OpenCascade.js tessellation                |
| IGES        | `.iges`, `.igs` | OpenCascade.js tessellation                |
| BREP        | `.brep`         | OpenCascade.js tessellation                |
| OpenSCAD CSG | `.csg`         | CSG parse → OCCT build → tessellation      |
| OpenSCAD Src | `.scad`        | openscad binary → `.csg` → same as above   |
| STL         | `.stl`          | Three.js `STLLoader`                       |
| OBJ         | `.obj`          | Three.js `OBJLoader`                       |
| PLY         | `.ply`          | Three.js `PLYLoader`                       |
| glTF / GLB  | `.gltf`, `.glb` | Three.js `GLTFLoader`                      |
| VTK / VTU   | `.vtk`, `.vtu`  | meshio++ → STL boundary surface → Three.js |
| MED         | `.med`          | meshio++ → STL boundary surface → Three.js |
| CGNS        | `.cgns`         | meshio++ → STL boundary surface → Three.js |
| Exodus      | `.exo`, `.e`    | meshio++ → STL boundary surface → Three.js |
| XDMF        | `.xdmf`         | meshio++ → STL boundary surface → Three.js |
| Kratos MDPA | `.mdpa`         | meshio++ → STL boundary surface → Three.js |
| OpenFOAM    | `.foam`         | meshio++ (case staging) → STL boundary surface → Three.js |
| Gmsh Mesh   | `.msh`, `.msh2` | meshio++ → STL boundary surface → Three.js |
| Abaqus      | `.inp`          | meshio++ → STL boundary surface → Three.js |
| I-DEAS Universal | `.unv`     | meshio++ → STL boundary surface → Three.js |
| SU2         | `.su2`          | meshio++ → STL boundary surface → Three.js |
| INRIA Medit | `.mesh`         | meshio++ → STL boundary surface → Three.js |
| GiD Postprocess | `.post.msh` (+ `.post.res`) | meshio++ → STL boundary surface → Three.js |

> **B-rep vs mesh:** STEP, IGES, and BREP are boundary-representation formats that are tessellated on-the-fly in the extension host. STL, OBJ, PLY, and glTF are already triangulated and are loaded directly into the webview by Three.js.
>
> **VTK/VTU/MED/CGNS/Exodus/XDMF/MDPA/OpenFOAM/Gmsh Mesh/Abaqus/I-DEAS Universal/SU2/INRIA Medit/GiD Postprocess** have no native Three.js loader, so the extension host converts them to a triangulated **boundary surface** in STL form first ([meshio++](https://github.com/loumalouomega/meshioplusplus), entirely host-side — no browser involved) and hands that to the webview exactly like a native `.stl` open. This means Parts, Edits, Export, Mass Properties, and Measurement all work identically to STL. **Named cell regions in the source file now auto-become real Parts** on first import (one per region, pre-coloured and pre-assigned — for a tetrahedral/triangular boundary; a quad/hex boundary still doesn't correlate); scalar field data (temperatures, stresses, …) beyond region names is still **not** preserved — only its names are shown, not its values. If you need to inspect scalar field values or colour by them, keep using a dedicated viewer (e.g. ParaView) for those formats — CAD-Preview's support here is for quick geometry (and now region) previews alongside your CAD files, not full FE post-processing.
>
> **OpenFOAM (`.foam`) is a case marker, not a mesh file.** It's an (often empty) marker whose real mesh lives in sibling files under `<parent>/constant/polyMesh/` — CAD-Preview stages the whole case and hand-builds the boundary surface. OpenFOAM import is geometry-only: no patch names or field data are preserved (no Parts auto-create, no colour-by-field for it).
>
> **Gmsh Mesh / Abaqus / I-DEAS Universal / SU2 / INRIA Medit close a real export/import asymmetry:** the FE Mesh panel already *wrote* `.msh`/`.inp`/`.unv`/`.su2`/`.mesh`, but until now had no way to re-*open* any of them. `.msh` and `.inp` are ambiguous extensions (also used by ANSYS/FreeFem and ANSYS APDL) — CAD-Preview always assumes its own output (Gmsh/Abaqus) and shows a one-line status caveat on open; there's no automatic disambiguation into the alternate formats. **Known limitation:** an `.xdmf` this extension itself exports almost always fails to re-mesh after reimport, due to a separate, pre-existing meshio++ defect in reading back its own "mixed cell type" output — opening the file still works, only Generate on the reopened document doesn't.
>
> **GiD Postprocess (`.post.msh`) is a sibling pair**, and unlike XDMF it re-meshes correctly after reimport. Geometry lives in the `.post.msh`, results in a `.post.res` beside it that the reader finds by name convention — keep the two together; only the `.post.msh` is opened directly. It is both an import format and an FE Mesh panel export target.

## User Interface

![The CAD Preview editor: 3D viewer with orientation cube, the Components/Parts/Edits/FE&nbsp;Mesh sidebar, toolbar, and view-controls panel.](/screenshots/viewer-main.png)

*The full editor — here previewing `bull.stp` with three colour-coded parts assigned, parametric variables, and every panel populated.*

Opening a STEP/IGES/BREP/CSG/SCAD file for the first time (or reopening one after an external change) shows a native VS Code progress notification with a **Cancel** button while OpenCascade parses and tessellates it. Clicking Cancel stops the result from being applied — the toolbar status line immediately shows "Cancelled" — though the underlying computation, once started, always finishes in the background regardless; a subsequent edit or reopen starts a fresh load. Routine edits (adding/undoing an operation) don't show this notification — with the model already parsed, they're normally near-instant and stay on the lightweight toolbar status line only.

### Collapsing Sidebar Sections

Every sidebar section — Components, Parts, Edits, FE Mesh, Mass Properties, Mesh Health, Region fit, Macros, Standard Parts — has a chevron at the left of its header. Click it to collapse that section down to just its header, and again to expand it. Sections collapse independently, so you can reduce the sidebar to only what you're actually working with; collapsing the two `flex`-growing panels (Parts, Edits) hands their space back to the rest rather than leaving a gap.

The collapsed/expanded layout is remembered **per document**, in the same `<model>.view.json` sidecar that already stores the camera, display mode and clip plane, so reopening a file restores the sidebar exactly as you left it. Merely opening a document never creates that file — only an actual change does.

Sections that don't apply to the current file (Mesh Health and Region fit are shown only for a native STL/OBJ/PLY/glTF source) are hidden entirely rather than collapsed, independently of this.

### Camera Interaction

| Action | Control          |
| ------ | ---------------- |
| Orbit  | Left-click drag  |
| Pan    | Right-click drag |
| Zoom   | Scroll wheel     |

Camera movement uses Three.js `OrbitControls` with damping enabled for smooth deceleration.

### File Menu

A full-width menu bar sits at the very top of the editor with a single **File ▾** dropdown:

| Item | Action | Shortcut |
| --- | --- | --- |
| **New Blank Model…** | Start an empty model and build it from scratch with the Edits panel — see [Starting from Scratch](#starting-from-scratch) | — |
| **Open…** | Pick another CAD/mesh file and open it in CAD Preview | Ctrl+O |
| **Save** | Immediately flush the parts/annotations/edits/mesh sidecars (`.parts.json` / `.annotations.json` / `.edits.json` / `.mesh.json`). The CAD file itself is read-only and never written; the sidecars also autosave on a ~500 ms debounce, so this just forces an immediate write. | Ctrl+S |
| **Save As…** | Convert the model to a new file/format via the [Export](#exporting-a-model) flow | Ctrl+Shift+S |
| **Export…** | Convert the model to a compatible format and save it (see [Exporting a Model](#exporting-a-model)) | Ctrl+E |
| **Save Preprocess…** | Bundle the CAD file plus whichever of its `.parts.json` / `.annotations.json` / `.edits.json` / `.mesh.json` sidecars currently exist into a single `.zip` archive (with a per-entry SHA-256 checksum recorded in its manifest), so the whole working state can be shared or archived as one file | Ctrl+Alt+S |
| **Load Preprocess…** | Restore a `.zip` built by Save Preprocess: pick a destination for the CAD file, write back whichever sidecars it contains, and open the result — rejects a corrupted/tampered archive or a destination whose file extension doesn't match the archive's own format | Ctrl+Alt+O |
| **Import SVG…** | Pick a `.svg` file and import every `<path>` in it as sketch **Polyline** edit ops — one per closed/open subpath (a shape with a hole, e.g. a traced letter "O", becomes two separate polylines) — ready to select (**Line** mode) and feed into Build → Surface / Extrude. B-rep only; only plain `<path>` elements are read (no `<rect>`/`<circle>`/other shape elements, and any `transform` attribute on the path is ignored) | — |
| **Import DXF…** | Pick a `.dxf` file and import its model-space `LINE` / `LWPOLYLINE` (bulge arcs sampled) / `POLYLINE` / `CIRCLE` / `ARC` / `SPLINE` entities as the matching Line/Polyline/Circle/Arc/Spline edit ops. B-rep only; blocks/INSERT/TEXT/DIMENSION/HATCH and paper space are skipped, and geometry lands flat at z=0 (1 DXF unit = 1 mm, Y-up native — adjust afterward with Scale/Move/Rotate) | — |
| **Export Silhouette SVG…** | Write a 2D **outline** of the model as an `.svg` file — pick a view (**Current view**, or Front/Back/Top/Bottom/Left/Right/Iso), then an export unit, then a destination. An outline, **not** a dimensioned technical drawing (see [Exporting a Silhouette SVG](#exporting-a-silhouette-svg)) | — |
| **Export Silhouette DXF…** | The same outline flow with a DXF serializer (`LWPOLYLINE` chains + `LINE` singletons), saved with a `.dxf` extension | — |
| **Export Technical Drawing…** | A 2D drawing with **hidden-line removal**: feature edges solid where visible, dashed where hidden behind the part. Unlike the two silhouette exports it draws interior edges too, so a hole's far rim shows dashed. Same view and unit picks; SVG or DXF (where hidden geometry lands on a `HIDDEN` layer). Still a review artifact — no dimensions, single view | — |

![The File dropdown open, showing New Blank Model, Open, Save, Save As, Export, Save Preprocess, Load Preprocess, Import SVG, Import DXF, and the silhouette/technical-drawing exports.](/screenshots/file-menu.png)

Every item is also a VS Code command (`CAD Preview: …` in the Command Palette). The keyboard shortcuts are scoped to a focused CAD Preview tab, so they don't override VS Code's global Open/Save elsewhere.

### What's New

The first time you open a CAD file (or run any `CAD Preview: …` command) after an update, a **What's New** tab opens beside the editor summarizing everything that changed since the version you last had installed — just close it (or click **Got it**) and keep working. It won't show again until the next update. You can reopen it anytime via **CAD Preview: Show What's New** in the Command Palette, which shows the full changelog rather than only what's new since your last session.

### Toolbar

The toolbar appears at the top-right of the editor, just below the menu bar. Three always-visible buttons sit on the left; everything else is grouped behind four dropdown menus, so the strip stays compact:

![The viewer toolbar: Fit, Tree, FE Mesh, and the View / Select / Measure / Markup dropdown menus.](/screenshots/toolbar.png)

| Button | Action |
| --- | --- |
| **Fit** | Reframe the model to fill the viewport (keeps current camera orientation) |
| **Tree** | Show/hide the component tree panel (visible only for models with multiple components) |
| **FE Mesh** | Toggle the generated finite-element mesh overlay on/off (see [Generating an FE Mesh](#generating-an-fe-mesh)). The **FE Mesh** panel itself is always visible in the sidebar; this button only shows/clears the overlay. |

A dropdown closes when you click its trigger again, press `Escape`, or click anywhere outside it; opening one closes any other that was open. Clicks *inside* a panel leave it open, so you can flip a mode on, pick a tool, and choose a colour in one visit. When the mode behind a menu is active, its trigger stays highlighted with a small dot, so you can tell at a glance that Measure or Markup is still live after the panel has closed.

**View ▾**

![The View menu: Grid, Edges, Screenshot.](/screenshots/view-menu.png)

| Item | Action |
| --- | --- |
| **Grid** | Show/hide the world-space grid and axis helpers (ticked when shown) |
| **Edges** | Show/hide edge lines independently of the shaded faces (ticked when shown) |
| **Hide smooth edges** | Declutter tangent patch-seam edges (e.g. between adjacent NURBS patches of one conceptually-curved surface on an imported STEP file) while keeping genuine feature edges — ticked when smooth edges are hidden. Off by default, so an existing model looks unchanged until you opt in |
| **Snap to grid** | While dragging the [Transform Gizmo](#transform-gizmo) in Translate mode, round the move to whole multiples of the **Grid size** field (view-controls Appearance group, default `1`) — off by default |
| **Snap to points** | While dragging the gizmo, snap a moved solid's nearest corner onto a nearby existing `point-N` vertex (any B-rep vertex or standalone point in the model) once it's within about 1% of the model's size — off by default. Both toggles can be on together; grid-snap applies once to the whole dragged group, point-snap then applies per solid, so different solids may snap to different nearby points |
| **Pane layout** | Four mutually-exclusive layouts over the same scene — **1×1** (single view), **1×2** (two side-by-side columns), **2×1** (two stacked rows), **2×2** (quad) — each pane an independent camera (direction/up/ortho) over the single WebGL canvas; display mode, clip plane, selection, parts colours, overlays, and markup stay shared across all panes. Orbit, pan, zoom, the Persp/Ortho toggle, and the orientation cube all work per pane, and clicking a pane makes it the one the view-control buttons act on. All panes of a new layout start as copies of the current view; collapsing keeps whichever pane you were last in. Persisted to `<model>.view.json` alongside camera direction (reopens exactly as you left it, including the per-pane cameras — older sidecars without a layout still restore sensibly to single-pane) |
| **Link cameras across tabs** | Share the focused pane's camera (direction/up/ortho) across all open CAD Preview tabs — orbiting one tab's view mirrors in the others within ~500 ms, re-framed to each document's own extents. Provider-level on/off (one checkbox for all tabs), session-only, never written to `.view.json` |
| **Screenshot…** | Save the current 3D view as a PNG via a Save dialog (see [Taking a Screenshot](#taking-a-screenshot)) — in a split view this captures the whole quad |

**Select ▾**

![The Select menu: Selection mode plus the Point/Vol/Surf/Line pick modes.](/screenshots/select-menu.png)

**Selection mode** toggles entity picking; the **Point · Vol · Surf · Line** row chooses what a click picks — points (vertices), volumes (solids), surfaces (faces), or lines (edges). Used to assign geometry to parts (see [Defining Parts](#defining-parts)) and to feed the wireframe **Build** composer (see [Editing Geometry](#editing-geometry)). Pick modes a given file format can't offer are greyed out, and a filter form below the row lets you **select by shape instead of by clicking**: faces — `Normal ±X/±Y/±Z`, `Planar`, `Area ≥/≤`, `Largest/Smallest N`; lines — `Along X/Y/Z`, `Length ≥/≤`, `Longest/Shortest N` — plus a `No seams` toggle that skips tangent seam edges. `Vol`/`Point` modes grey the whole form (a volume-level predicate would need group deduplication deferred with Phase 2). **Select** replaces the current selection; **Add** unions into it.

**Measure ▾**

![The Measure menu: Measure mode, the four tools, and Clear measurement.](/screenshots/measure-menu.png)

**Measure mode** toggles measurement picking; the tool row selects **Distance**, **Length**, **Angle**, or **Radius**, and **Clear measurement** discards the current one (see [Measuring](#measuring)). The result appears on its own line just below the toolbar, so it stays readable with the menu closed. A **Saved** list at the bottom of the panel shows any pinned annotations (📌, see [Pinning a measurement](#pinning-a-measurement) below).

**Markup ▾**

![The Markup menu: Markup mode, the six tools, a colour swatch, and Undo/Redo/Clear.](/screenshots/markup-menu.png)

**Markup mode** toggles annotation drawing; the tool row selects **Freehand**, **Line**, **Arrow**, **Rectangle**, **Circle**, or **Eraser**, the swatch sets the stroke colour, and **Undo** / **Redo** / **Clear** manage the strokes (see [Markup Annotations](#markup-annotations)).

### Taking a Screenshot

Click **View ▾ → Screenshot…** in the toolbar (or run **CAD Preview: Screenshot to PNG…** from the Command Palette, `Ctrl+Alt+P`) to save the current 3D view — whatever orientation, display mode, mesh overlay, **and markup annotations** are currently shown — as a PNG. A native Save dialog defaults to the source file's folder.

### Markup Annotations

Open **Markup ▾** in the toolbar and click **Markup mode** to start drawing review notes directly over the 3D view — "this boss", "gap here" — without leaving the viewer. Pick a tool from the row below it (**Freehand**, **Line**, **Arrow**, **Rectangle**, **Circle**, or **Eraser**) and a stroke colour from the swatch, then click-drag on the view to draw. **Undo**/**Redo** step through your strokes one at a time; **Clear** removes them all. Annotations are session-only — never saved to any sidecar or the CAD file — but they ARE baked into the next Screenshot you take (see above), so you can mark up a view and export the annotated image in one flow. Loading a different model clears any existing annotations; switching display mode, applying an edit, or rotating/panning the view does not. Erasing a stroke with the **Eraser** tool is immediate and does not go through Undo/Redo. Toggle **Markup mode** off to resume orbiting/panning/picking normally — while it is active, clicks draw instead of orbiting the camera. The **Markup ▾** trigger stays highlighted while the mode is on, even after the menu closes.

### View-Controls Panel

The collapsible panel at the bottom-right provides discrete camera controls without a mouse:

- **⌄ / ⌃ toggle** — Collapse or expand the panel.
- **Rotate buttons** — Step the camera by 15°, 45°, or 90° around the azimuth or elevation.
- **Pan buttons** — Shift the camera target by a fraction of the viewport.
- **Zoom buttons** — Dolly in or out by a fixed factor.
- **Fit** — Same as the toolbar Fit button (reframe in current orientation).
- **Ctr** — Reset to the default isometric view `(1, 0.8, 1)` and reframe.
- **Clip group** — Enable a live section/clipping plane, then drag the offset slider to sweep it across the model's bounding box (`-1` = the min-side face, `0` = centre, `1` = the max side), measured along whichever normal is active. The cross-section is solid-filled, not see-through, and also applies to the FE Mesh overlay when shown. Turning it off instantly restores the full model.

  The plane can be **any** direction, not just an axis:
  - **X / Y / Z** are fast presets.
  - **Face** clips along a selected planar face — select exactly one face in **Surf** mode and click it. The plane is oriented so the model is *kept* rather than cut away entirely, so for a face on the outside of the part nothing is cut until you drag the slider, which then sweeps inward from that face. Picking a curved face reports which surface type it found instead of applying a meaningless plane. B-rep sources only.
  - **3 Pts** clips through three selected points — select exactly three in **Point** mode. The result doesn't depend on the order you clicked them. Three points in a straight line are rejected with an explanation.

  Once a custom normal exists, a fourth **N** segment appears beside X/Y/Z showing it (hover for the vector and where it came from). It stays selectable, so you can flip to an axis preset to look at something and flip straight back without re-picking. The custom normal is saved to `<model>.view.json` along with everything else in the panel.
- **Planes group** — Named **construction planes**, saved beside the model in `<model>.planes.json` so they survive closing the file. **Save clip** stores whatever the Clip group is currently showing; **Enter…** reveals fields for typing a point and a normal directly, which is the only way to author a plane with no geometry to pick; **Midplane…** reveals two dropdowns of the already-saved planes and adds a new plane halfway between the picked pair (their normals must be parallel). Each row offers **Use** (apply it as the clip — the same path the Face/3 Pts buttons take, so a saved plane behaves identically to a freshly derived one), rename, and delete. Hover a row for its point, normal, and where it came from.

  **A plane stays put.** It stores the actual vectors, not a reference to the face it came from, so an edit that renumbers face ids leaves it exactly where you saved it — unlike Part and annotation assignments, which are re-matched geometrically. See [Construction Planes Sidecar](./file-formats.md#construction-planes-sidecar-modelplanesjson).
- **Appearance group** — A background-colour swatch (live preview only — the session-only override always wins over the [`cadPreview.background` setting](#settings) until you reload), an opacity slider for the whole model, a **Persp / Ortho** button toggling between perspective and orthographic projection (orbit/pan/zoom, picking, and the orientation cube all keep working under either projection), a **Units** dropdown (mm/cm/m/in/ft, see [Units](#units) below), and a **Grid size** field controlling the [Transform Gizmo](#transform-gizmo)'s Snap to grid increment (see **View ▾** above — unrelated to the display grid's own Grid toggle). For a meshio++-imported source that declares point or cell scalar data (temperatures, stresses, …), a **Colour by field** dropdown also appears here — picking a field paints the model as a viridis colour ramp with a min/max legend; picking "None" reverts. Background/opacity/units/grid-size/colour-by-field stay session-only (never exported/persisted); colour-by-field additionally resets whenever an edit is applied, since a field's values only stay meaningful for the model's original, unedited geometry.
- **Display group** — Five mutually exclusive rendering modes, replacing the old standalone Wireframe toolbar toggle: **Shaded** (the default, lit faces), **Wire** (faces rendered as a mesh of lines), **X-Ray** (translucent faces so edges show through), **Hidden** (edges of occluded geometry shown faintly through solid faces, full-strength where actually visible), and **Flat** (unlit, constant-colour faces — no lighting gradient, useful for reading true part colours without shading artifacts).

![The view-controls panel: stepped Rotate (15/45/90°), Pan, Zoom, Fit/Ctr, Clip, Planes, Appearance, and Display.](/screenshots/view-controls.png)

**The camera direction/up vector, Persp/Ortho, Display mode, and the Clip plane are all saved automatically** to a `<model>.view.json` sidecar and restored the next time you open the same file, so reopening a large assembly picks up right where you left off instead of always resetting to the default isometric — see [View State Sidecar](./file-formats.md#view-state-sidecar-modelviewjson) for the format. Applying an edit reframes in your CURRENT direction rather than snapping back to the saved (or default) one. Background colour, opacity, the Units dropdown, and Colour by field remain purely session-only, as does explode-preview state (the *committed* `explode` op itself is saved in `.edits.json` like any other edit).

### Explaining the geometry under the cursor

With a pick mode active (**Select ▾**), two things explain what you are pointing at.

**Hovering** shows a small tooltip with the entity's id (`face-12`, `edge-3`, `solid-0`) and which
of your applied ops mention that id. This is the quickest way to read your own `.edits.json`: the
ids in the sidecar are exactly the ids under your cursor. It says *mentions*, not *acts on*,
deliberately — ids are positional, so the same `face-12` in two different ops can refer to
different geometry once an op in between renumbers things.

**Clicking** additionally opens an inspector card in the bottom-left corner, classifying the entity
analytically: a planar / cylindrical / conical / spherical / toroidal face, or a straight /
circular / elliptical / spline edge. It lists **only the measurements that classification gives
meaning to** — a plane gets its area, normal, and a point on its plane; a cylinder gets no normal
at all, because a curved face has no single one.

The card needs the CAD kernel, so it is **B-rep only** (STEP/IGES/BREP/CSG/SCAD) and appears on selection
rather than on hover — a triangle mesh has no analytic surface type to report, and a fine-faceted
prism is indistinguishable from a cylinder in triangles.

**Right-clicking** an entity offers computed selection groups with their member counts — "Same
facing (3)", "Planar faces (19)", "Area ≤ this (36)" for a face; "Parallel to this", "Length ≥/≤
this" for an edge. Hovering a row previews exactly what choosing it would select; clicking replaces
the selection, and shift-clicking adds to it.

These are the same predicates as the **Select ▾** panel's filter form, with one difference that
makes them worth reaching for: **the entity you right-clicked supplies the number**. "Area ≤ this"
is the filter form's *Area ≤* with the threshold already filled in. Groups are offered for Surf and
Line modes only — the same modes the filter form supports — and a group that would select only the
entity you clicked is not offered at all.

### Macros

The **Macros** sidebar panel saves a set of edits you have already applied as a named, reusable
script, so a bolt pattern or a standard bracket treatment does not have to be rebuilt by hand every
time.

**Save current** records the current edit history under a name you choose; the document's own
parametric variables come along as the macro's parameters. Each saved macro then lists those
parameters with an editable field seeded from its saved default — change one and press **Run** to
apply the macro at the new values.

Running a macro pushes its ops onto the ordinary edit history, so it is undoable, visible in the
history list, and removable op-by-op exactly like a hand-applied edit — there is no separate "macro"
state to reason about.

Macros live in `cad-preview-macros.json` in the model's own folder, shared by every model there.
That is the **same file** the MCP tools read and write, so a macro you record by hand is directly
runnable by an agent and vice versa.

### Theme

The 3D scene follows VS Code's active colour theme. Switching between a light, dark, or
high-contrast theme repaints the background, the default face/edge/point colours, the grid, the
scene lighting, and the FE mesh overlay immediately — no reload, and nothing is written to any
sidecar.

**Colours you chose yourself are never re-tinted.** A Part's colour swatch, and a per-part FE mesh
colour, are your data: they win over the themed default, so a theme switch leaves them exactly as
you set them. The same applies to a background you picked by hand in the Appearance group — once
you drag that swatch, your choice wins for the rest of the session.

Two things deliberately do *not* follow the theme: the orientation cube's red/green/blue axis
arrows (an axis-colour convention shared across CAD tools, not a theme detail), and a live
operation preview's intent tint, which is regenerated whenever the draft changes anyway.

### Units

CAD Preview always keeps geometry internally in one consistent unit (millimetres) — for STEP files this is automatic: the OCCT reader converts every shape to millimetres at load time regardless of what unit the file was authored in (inches, centimetres, …), so numbers are always consistent no matter the source. The **Units** dropdown in the view-controls Appearance group is purely a *display* preference on top of that: it rescales how Mass Properties and Measurement results are shown (with a unit suffix, e.g. `12.700 mm` or `0.500 in`) — nothing stored (edit-op parameters, sidecars, mesh-size options) is ever rescaled, and FE Mesh panel size fields always show plain millimetres regardless of this setting, since that's Gmsh's own working unit. Opening a STEP file whose `DATA` section declares a length unit (e.g. `INCH`), or an IGES file whose Global section declares one (its own, differently-structured way of recording a unit), seeds the dropdown to that unit automatically; opening a file with no declared/recognized unit, or a mesh format (which has no unit metadata at all), always starts from `mm`. Moments of inertia in the Mass Properties panel are intentionally never rescaled by this setting. The selection is session-only — it resets on every new file open and is never written to a sidecar.

This dropdown is unrelated to (and doesn't drive) the **Export** flow's own unit conversion — see [Exporting a Model](#exporting-a-model), which applies a real geometric scale to the exported file, not just a display change.

### Orientation Cube

A labeled orientation cube sits in the top-left corner of the 3D view. It mirrors the current camera direction in real time.

Click any face of the cube to snap the camera to that standard view:

| Face        | View         |
| ----------- | ------------ |
| **+X / -X** | Right / Left |
| **+Y / -Y** | Top / Bottom |
| **+Z / -Z** | Front / Back |

### Component Tree Panel

For multi-solid STEP/IGES assemblies or glTF scenes with multiple meshes, the component tree panel shows the model hierarchy. Click any row to highlight that solid/mesh in the 3D view (all others are dimmed). Click the same row again or click an empty area to deselect.

For STEP sources specifically, the tree reflects the file's own **real assembly structure** when it has one — nested "Assembly"/"Component" groups matching how the file's author organized it, instead of always flattening every solid into one list (product/component *names* aren't shown — they're unreadable in this build's OCCT WASM — and an assembly wrapper with no real internal structure, or a source with none at all, falls back to the flat list exactly as before). A group-header row (an "Assembly N" line) is informational only — clicking it or its eye-toggle has no effect; only a leaf ("Solid N") row highlights/hides, exactly like every row always has.

Type into the filter field above the tree to narrow the list to rows whose name matches (case-insensitive substring) — matching rows and their ancestors stay visible so a match is never hidden inside a collapsed-looking branch; clear the field to show everything again. Each leaf row also has an eye-toggle to hide/show that solid/mesh (and its edges/points) in the 3D view — a display-only toggle, same as the Parts panel's (see below), never saved to a sidecar.

![The Components tree, showing the STEP root and its solid with a face-count badge.](/screenshots/components-tree.png)

### Measuring

The **Measure ▾** toolbar menu lets you measure distances, edge lengths, angles, and circle/arc radii directly in the 3D view — display-only by default, and never an edit operation, but a result can optionally be **pinned** so it survives closing the file (see below).

1. Open **Measure ▾** and click **Measure mode** (orbit/pan/zoom still work normally — a measurement pick is a click without a drag, same as part selection).
2. Pick a tool from the dropdown: **Distance** and **Angle** need two picks; **Edge Length** and **Radius** resolve from a single click.
3. Click in the view. **Distance**: click two points anywhere on the model. **Edge Length**: click one edge. **Angle**: click two faces or edges. **Radius**: click one circular/arc edge. A line (for Distance/Angle) plus a floating label with the result appears, and stays readable while you zoom.
4. Click **Clear** to remove the current result, or switch tools/toggle Measure off to start over.

Measurement precision follows the model's tessellation (the same 0.1 deflection tolerance used for display), not exact CAD geometry — fine for visual estimates, not for metrology-grade output. Distance, Edge Length, and Radius results are shown in whatever unit the view-controls **Units** dropdown is set to (see [Units](#units) above); Angle is always degrees.

For a STEP/IGES/BREP model, a **⟟ Exact** button appears next to a completed Distance, Edge Length, or Radius result (not Angle — there's no exact counterpart for that one). Clicking it asks the extension host to recompute the same measurement against the true OCCT geometry instead of the displayed triangulation — the readout updates to `D_exact`/`L_exact`/`R_exact = …` once it comes back. This is a real (if fast) computation, not instant like the triangulated result, and only works for CAD sources — mesh formats (STL, OBJ, …) have no exact B-rep geometry to fall back to, so the button never appears for them.

#### Pinning a measurement

A **📌 Pin** button appears next to a completed measurement result on any source kind (unlike **⟟ Exact**, which is B-rep only). Beside it sit three small optional tolerance fields — **nom**, **+**, and **−**. Fill at least **nom** and **+** (leave **−** blank for a symmetric ± band) and the pinned annotation records that tolerance band alongside the measured value; pinning with only **nom** filled still pins, but tells you no band was recorded. Clicking **Pin** saves the result as a persisted **annotation** — a "Saved" list at the bottom of the **Measure ▾** panel shows every pinned measurement, with a **Show** action (re-displays that overlay, no recompute) and a **✕** to delete it. Annotations survive closing the file, saved to a `<model>.annotations.json` sidecar next to the CAD source (the CAD file itself is still never touched).

A completed 2-point measurement (Distance or Angle) now renders as an actual **dimension**: arrowheads at both measured points, short witness marks, and the value label — not just a bare line. A toleranced pin shows its band in the label (`12.5 mm [10 ±0.05]`), and if the frozen measurement falls outside its own band, both the re-displayed label frame and its Saved-list row are coloured red — a presentation choice derived from the stored facts; nothing stores a pass/fail verdict. Pinned annotations also appear as dimension glyphs (extension lines, arrowheads, value labels) in **File ▾ → Export Silhouette SVG/DXF…** drawings.

Unlike Markup strokes (screen-space pixels with no 3D anchoring at all), a pinned annotation stays attached to the actual entity it measured — a geometric best-effort match runs automatically whenever you apply a topology-changing edit elsewhere on the model, the same matching that already keeps Parts assigned correctly across edits. If the specific entity an annotation anchored to is later removed or fused away (a boolean, for example), the annotation degrades honestly: its row in the Saved list goes struck-through and **Show** disables, rather than silently pointing at the wrong geometry.

### Defining Parts

CAD Preview lets you group geometry into named **parts** (the FEM sub-model-part / boundary-group concept). The **Parts** panel sits below the component tree in the left sidebar.

To assign geometry to a part:

1. Open **Select ▾** in the toolbar, click **Selection mode**, and choose a pick target: **Vol** (solids), **Surf** (faces), or **Line** (edges).
2. Click entities in the 3D view to select them — they highlight blue. Shift-click to add or remove from the selection; a plain click selects just one; clicking empty space clears the selection.
3. Click **＋ New** in the Parts panel to create a part, then click the **＋** on that part's row to assign the current selection to it.

Each part has an editable name, a colour swatch (click to recolour), an eye-toggle to hide/show just that part's entities, and a `v/s/l/p` badge counting its volumes / surfaces / lines / points. Assigned entities are painted in the part's colour in the 3D view. Expand a part to see and remove individual entities; click a part row to highlight all of its entities. The **✕** on a part deletes it.

The panel header's **⊙ Isolate** button shows only the currently-selected part's entities, hiding everything else; click it again (or select a different part and click it again) to clear isolation. Isolating composes with the per-row eye-toggles rather than overriding them — a part you'd already hidden stays hidden after you clear isolation. Like the eye-toggles, isolation is display-only and is never written to `<model>.parts.json`.

**Parts usually survive topology-changing edits.** Ops like Boolean, Fillet, and feature modeling rebuild the model's face/edge numbering, but CAD Preview automatically tries to re-match each part's assigned entities to their new numbering by geometry (same location, same area/length) right after you apply such an edit — so a part assigned to a face before a fillet elsewhere on the model typically keeps pointing at the right face afterward, with no action needed. This is a best-effort match, not a guarantee: an entity that genuinely merges or disappears (two faces fused into one by a Boolean, for instance) can't be matched to anything and is quietly dropped from the part, same as reopening a file with a stale reference. Undoing or removing an earlier op doesn't trigger a re-match (only applying a new one does).

![The Parts panel with three colour-coded parts expanded to show their assigned volumes, surfaces, and edges.](/screenshots/parts-panel.png)

Parts are saved automatically to a `<model>.parts.json` sidecar next to the CAD file and reloaded when you reopen it — the CAD file itself is never modified. See [Parts Sidecar](./file-formats.md#parts-sidecar-modelpartsjson) for the format.

> **Mesh formats** (STL/OBJ/PLY/glTF) have no stored face/edge topology. CAD Preview segments each mesh into connected, near-coplanar **facets** on load, so **Surf** picks a flat face (a cube → its 6 faces) and **Vol** picks the whole object. Highly curved meshes that would split into very many facets are kept whole; **Line** and **Point** are disabled for meshes.

### Inserting Standard Parts

The **Standard Parts** panel (below Parts in the sidebar) searches the hosted [step.parts](https://www.step.parts) catalog — fasteners, bearings, connectors, extrusions, and more — and inserts a result as an ordinary STEP file:

1. Type a query (e.g. "M6 hex bolt") and click **Search**.
2. Each result shows its name, description, category, and standard designation. Click **Insert…** on one.
3. A Save dialog appears, defaulting to `<part-id>.step` next to the currently open document. Saving downloads the file (its checksum is verified against the catalog's own recorded SHA-256, when one exists) and opens it as a new tab; dismissing the dialog is a no-op.

![The Standard Parts panel showing two search results with their Insert buttons.](/screenshots/standard-parts-panel.png)

An inserted part opens as its own document rather than merging into whatever model you already had open — combine it with your existing model using the ordinary [Editing Geometry](#editing-geometry) tools (position it with Move/the Transform Gizmo, then Boolean/Mate it in) once both are open. This requires network access to `api.step.parts`; if the service is unreachable, the panel shows a clear status message rather than an error.

### Editing Geometry

The **Edits** panel (below the Parts panel) applies non-destructive **edit operations** to the model. Edits never touch the CAD file — they are saved as an ordered, replayable op-list in a `<model>.edits.json` sidecar and re-applied each time you open the file.

Every parameter form previews **live**: while a form is open, the viewer shows what that op *would* produce as a translucent overlay, re-computed as you type (~250 ms debounce) and coloured by intent — green where material is added, red where it is removed, blue for wire/reference results (points, lines, sketch faces), neutral for transforms and fillet/chamfer. Switching forms or changing the selection cancels the preview; only **Apply** commits anything to the history.

The **Extrude**, **Revolve**, **Shell**, and **Draft** forms also carry a **Pin query** row: pick exactly one face, choose the producing op and bucket role it came from (e.g. an extrude's end cap), and click **Synthesize** to name that face as a stored query. The query is attached when you click **Apply** (as long as the selection hasn't changed since) and survives later edits renumbering the model's faces — the same mechanism agents use headlessly, now available interactively. Edge/volume operands and multi-face picks can't be pinned yet; the row says so rather than offering a dead button.

The panel is organised into two top-level tabs — **GEOMETRY** (create new entities) and **EDIT** (modify existing ones) — sharing one undo/redo/Clear header and one operation-history list. The GEOMETRY tab is further split into **2D** (points, lines, curves, sketch profiles) and **3D** (solid primitives, holes) subtabs. Each tab shows a grid of operation buttons (icon + name); clicking a button opens its parameter form below the grid, and clicking it again collapses the form. For mesh sources the whole **2D** subtab and every other B-rep-only button grey out.

<div style="display:flex; gap:1rem; flex-wrap:wrap; align-items:flex-start;">
  <img src="/screenshots/edits-geometry.png" alt="The GEOMETRY tab, 3D subtab: solid-primitive creation ops (Box selected)." style="max-width:280px; flex:1 1 240px;" />
  <img src="/screenshots/edits-edit.png" alt="The EDIT tab: Transform (Move/Rotate/Scale/Mirror) and Boolean (Unite/Subtract/Intersect) ops." style="max-width:280px; flex:1 1 240px;" />
</div>

*Left: **GEOMETRY → 3D** primitive creation. Right: the **EDIT** tab's modification ops.*

To apply a transform:

1. Open **Select ▾**, click **Selection mode**, choose **Vol**, and click one or more volumes (solids).
2. In the **Edits** panel open the **EDIT** tab and pick an operation — **Move**, **Rotate**, **Scale**, or **Mirror** — and fill in the numeric fields.
3. Click **Apply**. The model updates live and the operation is added to the list.

#### Transform Gizmo

Opening **Move**, **Rotate**, or **Scale** with a selection active also attaches a draggable 3D gizmo to the selected volume(s), centred on their shared bounding-box centre — dragging it is a live preview only (nothing is applied yet) and fills in the same numeric fields the form already shows, so typing and dragging stay in sync. **Move** shows a 3-axis arrow set (drag one to move along that axis only); **Rotate** shows rotation rings about the pivot; **Scale** shows drag handles. Selecting two or more volumes moves/rotates/scales them together as one rigid group, not independently. Orbit/pan is automatically suspended for the duration of a gizmo drag. Releasing the drag leaves the preview showing — nothing is added to the op list until you click **Apply**; switching to a different form, or clicking a different selection, discards an uncommitted drag and snaps the model back to where it was. **Snap to grid** and **Snap to points** (see **View ▾** above) both apply live during a Translate drag.

**GEOMETRY → 2D** (all B-rep only; each is typed-in, no selection needed unless noted):

| Op | Action |
| --- | --- |
| **Point / Line / Arc** | Appends a standalone point / straight line / circular arc you can select later (**Point**/**Line** mode) |
| **Polyline** | Appends straight edges through an editable list of points (**+ Add point** / **−** rows); **Closed** adds the last→first edge |
| **3-Pt Arc** | Appends the circular arc through three typed points (a collinear triple is skipped) |
| **Spline** | Appends a smooth curve through the point list (endpoint-exact fit) |
| **Bezier** | Appends a Bézier curve over the control-point list (passes through first and last only) |
| **Ell. Arc** | Appends an elliptical arc — Radius X along **Up**, Radius Y perpendicular, trimmed Start°→End° |
| **Helix** | Appends a helix: `Turns` revolutions of `Pitch` height around `Axis` from `Base`, radius `Radius` |
| **Circle / Rectangle / Polygon / Ellipse / Rounded / Slot / Trapezoid** | **Sketch** — appends a flat profile face you can later select (**Surf** mode) and feed into Extrude/Revolve/Sweep/Loft. Rectangle-family shapes take an **Up** direction for in-plane orientation |
| **Surface** (Build from selection) | Select ≥3 lines (**Line** mode) that close into a loop and **Build** — assembles them into a new flat face under "Sketches" |
| **Edge Slot** (Build from selection) | Select one edge (**Line** mode), enter a **Width**, **Build** — appends a stadium slot face around that edge (length = edge length + width) under "Sketches" |
| **Construction (guide)** checkbox | Every 2D profile/curve form offers one: the built entity is marked reference-only — rendered dimmed, still pickable/measurable, and refused as a profile operand by Extrude/Revolve/Sweep/Loft/Surface/Volume |

**GEOMETRY → 3D**:

| Op | Action |
| --- | --- |
| **Box / Sphere / Cylinder / Cone / Torus / Prism** | **Add** — appends a new body at that placement (no selection needed; all formats) |
| **Wedge** | **Add** — appends a right-angular wedge: base `Size X`×`Size Y` centred at `Base ctr` in the plane ⟂ `Axis`, extruded `Height`; the far edge narrows to `Top X` (B-rep only) |
| **Hole / C'bore / C'sink** | Select target volume(s) (**Vol** mode), place the mouth (`Mouth` + `Axis` pointing into the material), and **Cut** — drills a plain, counterbored, or countersunk hole (all formats). The **Standard** dropdown fills `Radius` (and, for a tapped size, a sensible blind `Depth`) from the ISO metric / UNC / UNF tables — pick e.g. *M6 tapped* or *M6 clearance* instead of looking the number up; the fields stay editable afterwards |
| **Volume** (Build from selection) | Select ≥4 surfaces (**Surf** mode) that close into a shell and **Build** — sews them into a new closed solid (B-rep only) |

**EDIT**:

| Op | Action |
| --- | --- |
| **Move / Rotate / Scale / Mirror** | Enter parameters, **Apply** to the selected volumes (all formats) |
| **Unite / Subtract / Intersect** | Select operand-A volumes and click **Set A**, then select operand-B volumes and click **Apply** (all formats) |
| **Fillet / Chamfer** | Select edges (**Line** mode), enter the radius / setback, **Apply** (B-rep only) |
| **Extrude / Revolve / Sweep / Loft** | Select a profile face (**Surf** mode; a path edge too for Sweep, 2+ faces for Loft), set parameters, **Apply** — builds a new body (B-rep only). Extrude/Revolve/Sweep also take **Regions** to narrow a multi-region profile (blank = face as modeled, `all`, or indices like `0,2`) |
| **Shell** | Select the opening face(s) (**Surf** mode), enter a wall thickness (negative = walls grow inward, the usual hollow), **Apply** — hollows the solid(s) owning those faces (B-rep only) |
| **Draft** | Select the face(s) to taper (**Surf** mode), enter an **Angle°** (0–90), and optionally a neutral-plane **Point** + **Normal** — leave both at 0 to taper each face about its own plane — then **Apply** (B-rep only). **Known kernel limitation**: the bundled OCCT WASM build's draft engine fails on real geometry (probed — see `CLAUDE.md`), so the op currently reports a "did not apply — kernel limitation" diagnostic in the history instead of changing the model; it will work without changes once the upstream build fixes it |
| **Split** | Select volumes (**Vol** mode), define the plane, choose which side(s) to **Keep**, **Apply** (B-rep only) |
| **Section** | Select volumes (**Vol** mode), define the plane, **Apply** — appends the planar cross-section as a sketch face, leaving the solids untouched (B-rep only) |
| **Drill** | Select volumes (**Vol** mode) plus a profile face (**Surf** mode) or wire (**Line** mode), set **Dir**/**Length**, **Apply** — cuts the profile's regions through the volumes. **Regions** narrows a multi-region profile: blank (face as modeled), `all`, or indices like `0,2` (`0` = outer boundary) (B-rep only) |
| **Rib** | Select an open spine sketch (**Line** mode), set a wall **Thickness** and an **Up-to** face, **Apply** — extrudes the wall to that face (plus one thickness of embed), fuses it into the surrounding solids, and blends the junction (B-rep only) |
| **Wrap** | Select a flat sketch face (**Surf** mode), pick **Cylinder** or **Cone** target, set axis/radius (half-angle for cones) + wall **Thickness** and variant — **Standalone** appends the wrapped shell, **Emboss** fuses it into the target volumes, **Engrave** cuts it out (B-rep only) |
| **Explode** | Drag the slider (or type the factor) for a live preview — bodies spread radially from the model centre as you drag, snapping back at 0 — then **Apply** to commit it as an operation (all formats) |
| **Mate** | Select two faces (**Surf** mode): face A then face B, and **Apply** — aligns A onto B (B-rep only) |
| **Align** | Select volumes (**Vol** mode); choose an **Axis** (X/Y/Z), an **Extent** (min/center/max of each volume's own bounding box), and a target coordinate **To**; **Apply** — moves each selected volume along that one axis so its own chosen extent lands exactly on the target. Every targeted volume aligns independently, even when the whole model is selected (all formats) |
| **Linear Pattern** | Select volumes (**Vol** mode); set a **Direction**, a **Spacing**, and a **Count** (total instances, including the original); **Apply** — appends `Count − 1` evenly-spaced copies of each selected volume (all formats) |
| **Circular Pattern** | Select volumes (**Vol** mode); set an **Axis point** + **Axis direction**, an **Angle** step, and a **Count**; **Apply** — appends `Count − 1` copies arrayed around that axis at equal angular spacing (all formats) |

Reference helpers: the op model itself accepts **references instead of typed coordinates** — **Mirror**, **Split**, and **Section** can take `midplaneFaces: [faceA, faceB]` (two planar, parallel faces; the op acts on the plane halfway between them) and **Circular Pattern** can take `midaxisOf: [cylA, cylB]` (two cylindrical faces or two parallel edges), each mutually exclusive with the typed-in vectors. These are authorable headlessly via `apply_edit_ops` (see `doc/mcp-server.md`) and degrade with a clear diagnostic when the referenced faces are missing, non-planar, or not parallel; mesh files only accept the typed-in coordinates. Interactively, the **Planes** panel's **Midplane…** button (below the saved-plane list) builds a new named plane halfway between two already-saved ones — the same math, computed client-side.

Header controls: **↶ / ↷** undo / redo the last operation; **Clear** removes all operations (back to the original model). To remove one specific operation without discarding everything applied after it, hover its row in the history list and click the **✕** that appears — unlike Undo, which only pops the most recent operation, this removes any row directly. The history is also a clickable timeline: undone-but-redoable steps appear as dimmed rows with continued numbering, and clicking **any** row — applied or dimmed — rolls the whole stack straight to that point in one step (clicking a dimmed row re-applies through it).

![The operation-history list — an ordered, individually-removable stack of applied edits.](/screenshots/edit-history.png)

Transforms, booleans, explode, primitives, and the hole family work on both B-rep and mesh files; everything else is B-rep only (the panel disables those buttons — and the whole 2D subtab — for meshes). Creation ops **append a new body** to the model; holes are the exception — they **cut into** the selected volumes. For primitives, `center` is the body's geometric centre (box/sphere/torus) or its base centre (cylinder/cone/prism/wedge, extruded along `Axis`) — matching how the underlying CAD kernel places them. A 2D profile sketch builds a flat face, not a body — it's meant to be picked and extruded/revolved/swept/lofted; doing so consumes the sketch into the new solid rather than leaving a duplicate flat face behind. Building a Surface or Volume needs an already-closed selection (a loop of lines, a sealed set of surfaces); an open selection is silently skipped rather than producing a malformed body — the same graceful-skip rule every op follows when its inputs don't resolve.

The operation buttons' icons are placeholder glyphs — they live in one file, `src/webview/opIcons.ts`, made to be swapped for real icons.

When you **Export** an edited model, the edits are baked into the output file. See [Edits Sidecar](./file-formats.md#edits-sidecar-modeleditsjson) for the format.

### Parametric Variables

The **Variables** table at the top of the Edits panel makes the model parametric: define named values once, reference them in any numeric field of any edit operation, and change them later to rebuild the geometry on the fly.

1. Click **＋ New** in the Variables header. A variable appears with an auto-generated name (`L1`, …) — rename it inline and set its expression (e.g. `20`). The computed value shows to the right of the row.
2. In any op's parameter form, type the variable name — or an arithmetic expression like `L/2 + 1` — instead of a number, then **Apply**/**Add** as usual. The op is created with the current value and remembers the expression (the history line shows it as `[length = L/2 + 1]`).
3. Edit the variable's expression in the table — every operation referencing it re-resolves and the model rebuilds immediately.

![The Variables table with two variables — L = 20 and the derived H = L / 2 = 10.](/screenshots/variables.png)

Expressions support numbers, variable names, `+ - * / ^`, parentheses, `sqrt/abs/min/max/floor/ceil/round`, `sin/cos/tan` (**degrees**, matching the angle fields), and `pi`. A variable's own expression may reference the variables defined **above** it in the table (so `W = L/2` works; reordering isn't supported). Because the fields are free-text, they no longer have browser spinner arrows — type the value.

If an expression can't be evaluated at Apply time (unknown name, syntax error), the apply is blocked with an inline message. If a *referenced* variable is later deleted or renamed, affected operations keep their last computed values — a warning names the missing variable, and re-adding it restores the parametric link. The delete button's tooltip warns when a variable is still referenced. Variables persist in the same `<model>.edits.json` sidecar as the operations ([format](./file-formats.md#parametric-variables)); variable edits are not part of the op undo/redo history.

### Generating an FE Mesh

The **FE Mesh** panel (below the Edits panel) generates a finite-element mesh (nodes + triangles/tetrahedra) of the currently displayed model using [Gmsh](https://gmsh.info) compiled to WebAssembly. The result is shown as a blue overlay on top of the existing geometry — it never replaces or modifies the original model. See [GMSH Integration](https://loumalouomega.github.io/CAD-Preview/gmsh-integration) for the full technical write-up.

To generate a mesh:

1. Pick a target element size with the **coarser→finer slider** (or a **Coarse/Medium/Fine** preset). The default is derived from the model's bounding box (diagonal / 20), and the readout below the slider shows the current size plus a rough estimate of how many elements it will produce. Fine-grained options (dimension, algorithms, element shape, element order, …) live in the collapsed **Advanced settings** section.
2. Click **▶ Generate**. The overlay appears and the panel's status line shows `Nodes: N · Elements: M · 3.2 s`, or an error message if generation fails. Below the status line, a quality summary reports the minimum and mean element quality (Gmsh's `minSICN` metric, 0–1, higher is better) plus a small histogram of the distribution — useful for spotting a generate that technically succeeded but produced a lot of sliver elements. If any elements scored below 0.20 (for a **3D** mesh), a **Worst** button appears next to **Clear** and lights up automatically, highlighting those elements in bright red — visible even where they're buried inside the model, so you don't need to clip or cut away anything to find them.
3. Click **FE Mesh** in the toolbar to show/hide the overlay without discarding it; click **Worst** to show/hide just the worst-element highlight; click **Clear** in the panel to remove everything.

<div style="display:flex; gap:1rem; flex-wrap:wrap; align-items:flex-start;">
  <img src="/screenshots/fe-mesh-panel.png" alt="The FE Mesh panel: coarser→finer size slider, presets, per-part sizes." style="max-width:300px; flex:1 1 260px;" />
  <img src="/screenshots/mesh-overlay.png" alt="A generated tetrahedral mesh overlaid on the model." style="max-width:520px; flex:2 1 380px;" />
</div>

*The FE Mesh panel and a generated 3D tetrahedral overlay (`Nodes: 2975 · Elements: 12952`), colour-scoped by part.*

| FE Mesh control | Action |
| --- | --- |
| **Coarser→finer slider** | The primary control: sets the target element size (`Mesh.MeshSizeMax`), log-scaled between bbox-diagonal/5 (coarsest) and /200 (finest). The readout shows the size and an order-of-magnitude element-count estimate; a warning appears above the panel when the estimate exceeds ~1M elements |
| **Coarse / Medium / Fine** | One-click presets: element size = bbox diagonal / 10, / 20 (the default), / 50 |
| **Part sizes** | One size input per defined Part (visible once parts exist) — the same per-part target size as the Parts panel's input, mirrored here; blank inherits the global size |
| **Engine** | **Gmsh** (default) or **fTetWild** — an alternative volume mesher for a dirty mesh-format 3D source (holes, self-intersections, non-manifold edges) that Gmsh's own boundary reclassification rejects or silently produces no elements for. Under fTetWild, Size min / 2D-3D algorithm / Element order / Element shape / STL angle are all greyed (unused); the size slider still applies, via fTetWild's own envelope/target-edge-length settings under Advanced. Requesting fTetWild for a B-rep source or a non-3D dimension falls back to Gmsh automatically |
| **Advanced settings** (collapsed) | The raw Gmsh options below — expand to reveal them ([shown here](/screenshots/fe-mesh-advanced.png)) |
| **Dimension** | 1D (edges only), 2D (surface triangulation), or 3D (volume tetrahedralization) |
| **Size min / max** | Bounds on generated element size (`Mesh.MeshSizeMin`/`Mesh.MeshSizeMax`); **Size max** is the same value the slider drives, shown numerically (clearing it restores the bbox-derived default) |
| **2D algorithm / 3D algorithm** | The Gmsh meshing algorithm to use for each dimension |
| **Element shape** | **Triangles / Tetrahedra** (default), **Quads / Hexahedra** (recombines the mesh into quadrilaterals in 2D / hexahedra in 3D), or **Hex-Dominant (3D)** (a mixed tet/hex mesh via Gmsh's RTree recombiner — not exportable to Kratos MDPA, use a different export format) |
| **Element order** | Linear (1) or quadratic (2) elements — quadratic adds mid-side nodes (the overlay still draws the corner geometry) |
| **Optimize** | Run Gmsh's mesh optimizer after generation |
| **STL angle (°)** | Surface-classification angle for mesh/STL sources (disabled for B-rep documents, which never reclassify) — only used by engine: Gmsh |
| **fTetWild envelope (eps)** | fTetWild's envelope size, as a fraction of the model's bounding-box diagonal — smaller stays closer to the input surface (slower). Only used by engine: fTetWild |
| **▶ Generate** | Run Gmsh now with the current options and show the result as an overlay |
| **Export format `<select>`** | Pick which format **📤 Export** writes — **Kratos MDPA (Elements + Conditions)** (the default), Kratos MDPA (Geometries), Gmsh Mesh (`.msh`), Gmsh Mesh v2/Legacy (`.msh2`), Gmsh Geometry (`.geo_unrolled`), VTK, MED, CGNS, XDMF, I-DEAS Universal (`.unv`), Abaqus (`.inp`), Nastran Bulk Data (`.bdf`), SU2, INRIA Medit (`.mesh`), STL Mesh, Diffpack (`.diff`), OFF, VTK XML Unstructured (`.vtu`), HDF Mesh Format (`.hmf`), AVS UCD (`.avs`), COMSOL Mphtxt (`.mphtxt`), Netgen (`.vol`), FLAC3D (`.f3grid`), Well-Known Text (`.wkt`), or Flux (`.pf3`). Both Kratos MDPA modes preserve named Parts as Kratos SubModelParts and support linear or quadratic tetrahedra/hexahedra/triangles/quadrilaterals. MED/CGNS/XDMF and the 8 trailing formats (VTU through Flux) are all bridged through meshio++ (this Gmsh build has no writer for any of them) — MED preserves named Parts as **named MED groups**, and XDMF also writes a companion `.h5` file alongside the `.xdmf`. |
| **Export unit `<select>`** | A real geometric scale applied to the exported file's geometry before Gmsh sees it — mirrors the model Export command's own unit picker (see [Units](#units)). Defaults to **mm** (native, no conversion); **Size min/max** and any per-part mesh size are automatically rescaled to match, so relative mesh density stays the same regardless of the chosen unit. Only affects **📤 Export** — **▶ Generate**'s overlay always meshes at native mm, since it has no exported file for a unit to matter to. |
| **📤 Export** | Mesh with the current options (at the chosen export unit) and save the result in the format picked above, via a Save dialog (independent of whether **▶ Generate** was already clicked — it always (re)generates fresh) |
| **⚠ Worst** | Only shown after a 3D generate with at least one element below quality 0.20 (auto-shown then, since it's a warning). Toggles the worst-quality-elements highlight in place, without discarding it |
| **Clear** | Remove the mesh overlay and the worst-elements highlight (the original model is unaffected either way) |

<div style="display:flex; gap:1rem; flex-wrap:wrap; align-items:flex-start;">
  <img src="/screenshots/part-sizes.png" alt="Per-part mesh-size inputs mirrored in the FE Mesh panel." style="max-width:260px; flex:1 1 220px;" />
  <img src="/screenshots/export-formats.png" alt="The export-format picker: Kratos MDPA, Gmsh, VTK, Abaqus, and more." style="max-width:220px; flex:1 1 200px;" />
</div>

*Left: per-part local sizing. Right: the mesh export-format picker (Kratos MDPA is the default).*

Mesh options are saved automatically to a `<model>.mesh.json` sidecar next to the CAD file, and an editable `<model>.geo` Gmsh script is regenerated alongside it on every change — see [Mesh Options Sidecar](./file-formats.md#mesh-options-sidecar-modelmeshjson-and-generated-geo-script) for the format. **The `.geo` file is one-way: hand-edits to it are never read back by the extension** — use the FE Mesh panel to change options, not the generated script. Neither file modifies the source CAD file.

> **B-rep vs mesh sources:** for STEP/IGES/BREP files, the model currently shown (including any applied edits) is re-exported to STEP and handed to Gmsh directly. For STL/OBJ/PLY/glTF files, Gmsh has no volume topology to start from, so the displayed triangle soup is first reclassified into surfaces at sharp-angle boundaries (`classifySurfaces`, default 40°) and rebuilt into a closed volume before a 3D mesh can be generated.

### Mass Properties

The **Mass Properties** panel (below the FE Mesh panel) computes volume, surface area, length, center of mass, and moments of inertia for the whole model or a single selected entity.

1. With nothing selected, click **Compute** for whole-model properties. To inspect one entity instead, enter **Select** mode, pick exactly one volume, surface, or edge, then click **Compute** — selecting more than one entity shows a guidance message instead of a (possibly misleading) combined result.
2. The panel shows whichever fields apply: a volume/solid gets **Volume**, **Area**, **Center of mass**, and **Ixx/Iyy/Izz**; a single face gets **Area** only; a single edge gets **Length** only.

For STEP/IGES/BREP files this runs in the extension host via OpenCascade.js's `BRepGProp`; for STL/OBJ/PLY/glTF files it's computed entirely in the webview from the displayed triangle mesh (no moments of inertia for mesh sources in this first cut). Volume/Area/Length/Center of mass are labeled and shown in whatever unit the view-controls **Units** dropdown is set to (see [Units](#units) above) — switching it live-rescales an already-computed result with no need to click **Compute** again; **Ixx/Iyy/Izz** are always shown raw, unaffected by that setting.

### Exporting a Model

Pick **File ▸ Export…** (or press Ctrl+E) to convert the open model and save it as a different file. The list of offered target formats depends on the file you opened:

| You opened | You can export to |
| --- | --- |
| STEP, IGES, or BREP | the other two B-rep formats, plus STL, OBJ, PLY, and glTF |
| STL, OBJ, PLY, or glTF | the other mesh formats only |

The format you opened is never offered as an export target. Picking any target format opens a second quick-pick asking for an **export unit** — "Native (mm) — no conversion" is first and pre-highlighted, so pressing Enter immediately exports unchanged; picking cm/m/in/ft instead applies a real geometric scale to the exported file (not just a display change — the model reopens at the new size). This applies to **every** target, STEP and IGES included — both correctly relabel their own declared length unit to match the converted geometry, not just scale the numbers while leaving the header saying millimetres. Pressing Escape on this step also exports natively rather than cancelling. A native Save dialog then lets you choose the destination — it defaults to the source file's folder with the new extension. glTF export always produces a single binary `.glb` file (no separate `.bin`/texture references to manage).

B-rep targets are converted by OpenCascade.js's own writers, so STEP ↔ IGES ↔ BREP round-trips preserve true CAD geometry, not just a tessellated approximation. Mesh targets are generated from the triangulated geometry already shown in the viewer — there is no way to turn a mesh file (or a tessellated B-rep) back into precise CAD surfaces, which is why mesh sources can't export to STEP/IGES/BREP.

### Exporting a Silhouette SVG

Pick **File ▸ Export Silhouette SVG…** (or **Export Silhouette DXF…** for the DXF variant; both also exist as `CAD Preview: Export Silhouette …` commands) to write a 2D **outline drawing** of the model as an `.svg` or `.dxf` file.

**For a drawing that shows what is behind the part, pick File ▸ Export Technical Drawing… instead.**
That one runs hidden-line removal: it draws interior feature edges as well as the outline, and
renders anything occluded as a dashed line — so a through-hole's far rim appears dashed rather than
missing. It shares the same view and unit picks, and writes SVG or DXF (where hidden geometry goes
on a `HIDDEN` layer you can toggle in a CAD tool). It is still a single view with no dimensions:
treat it as a review or illustration artifact and measure anything you need to be sure of. This is separate from the Export… flow above — an outline is a drawing, not a 3D model, so it never appears in that quick-pick's target list.

1. **Pick a view.** The first entry is **Current view** — the angle you are currently looking at — followed by Front, Back, Top, Bottom, Left, Right, and Iso. Pressing Escape here cancels the export.
2. **Pick an export unit.** The same quick-pick every other export shows, defaulting to native mm; Escape here still exports (at mm), it doesn't cancel.
3. **Choose a destination** in the native Save dialog (the menu item you picked decides SVG vs DXF and the default extension).

> **It's an outline, not a dimensioned 2D technical drawing — there is no hidden-line removal.** Back-facing geometry isn't drawn, but neither are interior feature edges that don't lie on a silhouette (a hole seen face-on draws as a circle; the same hole seen edge-on draws nothing). OpenCascade's hidden-line machinery is entirely unavailable in the bundled WASM build, so the outline is derived from triangle adjacency instead — which is also why this works for mesh files, not just B-rep. Use it for review notes, documentation figures, and laser/plotter outlines; use the [Measurement](#measuring) tools for any dimension you need to be sure of.

Works for STEP/IGES/BREP (with your edits baked in, from the current tessellation) and STL/OBJ/PLY/glTF (from the raw file — edits are **not** baked in, since mesh edits can't be replayed outside the viewer). meshio-only sources (VTK/VTU/MED/CGNS/Exodus/XDMF/MDPA/Gmsh Mesh/Abaqus/I-DEAS Universal/SU2/INRIA Medit) are rejected.

The SVG output is a single self-contained `<path>` with no external references, at **1 SVG user unit = 1 model unit** and a physical size in millimetres — so a drawing exported from a native (mm) model prints 1:1 in any vector tool. The DXF output is minimal model-space `ENTITIES`: chained collinear outline runs become `LWPOLYLINE`s and unmatched singletons stay independent `LINE`s. One caveat: the outline depends on consistent triangle winding, so a mesh with mixed winding (as some exporters and hand-edited files produce) draws spurious interior lines.

### Comparing Models

Run **CAD Preview: Compare Models…** from the Command Palette to diff two STEP/IGES/BREP, STL, OBJ, PLY, or glTF/GLB files (any combination) solid-by-solid — useful for checking what actually changed between two versions of a model. If a CAD Preview tab is focused when you run the command, its file is used as model **A** automatically and you're only prompted for **B**; otherwise you're prompted for both.

A results tab opens beside the editor showing:

- **Matched** solids (present in both, paired up by bounding-box-centroid proximity and volume similarity) — each row shows its **centre displacement** and **volume delta**, so you can tell a solid that just moved slightly from one that was heavily reshaped, rather than trusting a single "changed" verdict.
- **Removed** solids — present only in A.
- **Added** solids — present only in B.

This is a display-only report (no 3D view, no merge) — to actually look at both models side by side, open each in its own tab and use VS Code's split editor layout. STEP/IGES/BREP, STL, OBJ, PLY, and glTF/GLB are all supported, in any combination; the meshio-only formats (VTK/VTU/MED/CGNS/Exodus/XDMF/MDPA/OpenFOAM/Gmsh Mesh/Abaqus/I-DEAS Universal/SU2/INRIA Medit) are the one remaining exception, since they never expose a triangle array outside their own WASM module. For a STEP/IGES/BREP file, the comparison reflects its currently-applied edits (its `.edits.json` sidecar, if any); for an STL/OBJ/PLY/glTF file, edits are **not** baked in (there's no way to replay a mesh edit outside the viewer) — a warning banner says so if the file has pending edits, and the comparison runs against the raw file as-is.

## Known Limitations

- **No texture support for OBJ.** MTL material files are not loaded; a default grey material is applied.
- **No glTF animations.** Animation playback is not implemented — only the first frame (bind pose) is shown.
- **No BRep-embedded geometry in glTF.** Only triangulated `mesh` primitives inside glTF are rendered.
- **No Compare Models / Mesh Health support for the meshio-only formats.** STEP/IGES/BREP/STL/OBJ/PLY/glTF are all supported (any combination) — glTF included since a dedicated host-side parser shipped, cross-validated against three.js's own `GLTFLoader`. VTK/VTU/MED/CGNS/Exodus/XDMF/MDPA/Gmsh Mesh/Abaqus/I-DEAS Universal/SU2/INRIA Medit remain excluded: meshio++'s WASM module converts them to a boundary surface for display but never hands a triangle array back to JS, so there's nothing for the host to match on (they still open and preview normally).
- **An `.xdmf` this extension itself exports usually can't be re-meshed after reimport.** A separate, pre-existing meshio++ 10.20.2 defect (not fixable in this codebase) means its own reader can't parse the "mixed cell type" topology this extension's meshing (`Mesh.SaveAll=1`, always on) produces. Opening the file still works normally; clicking **▶ Generate** on the reopened document fails with a clear error. A single-cell-type XDMF from a different tool is unaffected.
- **Compressed glTF isn't parsed host-side.** A `.gltf`/`.glb` requiring `KHR_draco_mesh_compression` or `EXT_meshopt_compression` is rejected with a clear error by Compare Models / Mesh Health / Promote to B-rep / Silhouette SVG — the host-side parser can't decode compressed buffers. Viewing such a file in the 3D view is unaffected.
- **Mesh Health and Promote to B-rep cap out at 50,000 triangles.** Both build one OCCT face per triangle and sew them, so a larger mesh is refused with an actionable error rather than exhausting the WASM heap. Most likely to come up with glTF, a rendering-oriented format whose real-world files are routinely far larger than hand-authored STL/OBJ/PLY — decimate first, or use the Mesh Health panel's **Repair (robust)…** button (fTetWild-based, no equivalent triangle-count ceiling), if you hit it. **Repair (robust)…** writes a NEW watertight STL file — tetrahedralize the source with fTetWild, keep the resulting volume mesh's own boundary — enabled once Check Healability shows at least one component that did NOT close; re-running Check Healability / Promote to B-rep on the repaired output then typically succeeds where the original could not.
- **Silhouette SVG has no hidden-line removal.** It draws an outline, not a dimensioned 2D technical drawing — see [Exporting a Silhouette SVG](#exporting-a-silhouette-svg).
- **Large assemblies are slow.** STEP/IGES files above ~50 MB may take several seconds to tessellate. Tessellation runs in-process in the Node extension host — there is no streaming.
- **One-time WASM startup.** The first B-rep file open triggers OpenCascade.js initialization (~300 ms on a typical machine). Subsequent B-rep files open faster because the kernel is memoized.
- **Source CAD file is never modified.** CAD Preview never writes the opened CAD file. **Export** writes a new, separate file; **part** definitions are saved to a `<model>.parts.json` sidecar; **pinned measurements** to a `<model>.annotations.json` sidecar; and **edit operations** are saved to a `<model>.edits.json` sidecar — the original geometry is always left untouched. Edits are non-destructive and replayable, and are baked in only when you **Export**.
