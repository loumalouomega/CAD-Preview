# Roadmap

Candidate features for future CAD-Preview releases, prioritized by value versus
effort given what the extension already ships: an OCCT kernel and a Gmsh kernel
live in the extension host, a full picking/selection pipeline in the webview,
a sidecar persistence model, and an MCP server mirroring the pipeline headless.
Many high-value features are cheap precisely because that infrastructure exists.

This page is aspirational, not a commitment — items may be re-ordered, re-scoped,
or dropped. Effort is a rough order of magnitude: **S** (a day or two), **M**
(roughly a week), **L** (multi-week).

## P1 — Near-term: cheap wins on existing infrastructure

### 1. Mass properties readout — S

Volume, surface area, center of gravity, and moments of inertia for the whole
model and for selected entities.

- **Why:** the single cheapest large win. OCCT is already loaded for every B-rep
  document; `BRepGProp.VolumeProperties` / `SurfaceProperties` /
  `LinearProperties` over the live `TopoDS_Shape` in `src/occtService.ts` is all
  it takes. No new dependency, no new WASM.
- **How:** per-selection results resolve `solid-N` / `face-N` / `edge-N` ids via
  the same deterministic-explorer-order helpers `src/occtOperations.ts` already
  uses (`collectFaces`, `collectEdges`). Mesh sources (STL/OBJ/PLY/glTF) get the
  Three.js equivalent in the webview: signed-tetrahedron volume sums and triangle
  area sums over the displayed geometry.
- **Notes:** the exact `BRepGProp` overload suffixes must be probed against the
  live WASM (standard repo convention — see `CLAUDE.md`). Expose the same data as
  an MCP tool (e.g. `get_mass_properties`) per the MCP-sync rule.

### 2. Measurement tools — M

Interactive distance (point↔point, entity↔entity), edge length, angle between
two faces or edges, and circle/arc radius.

- **Why:** the most-requested feature class in every CAD viewer; the hard part
  (robust entity picking) already exists.
- **How:** a new toolbar measure mode reusing `src/webview/picking.ts` and the
  `SelectionSet` in `src/webview/selection.ts`, plus the existing point-sprite
  infrastructure for snap markers. Results render as a display-only overlay
  (line + floating label) and a small readout panel. Measurements are **never**
  edit ops and never persist to sidecars.

### 3. Screenshot to PNG — S

A toolbar button and a `cad-preview.screenshot` command that saves the current
view as an image.

- **How:** render on demand then `canvas.toDataURL("image/png")` (avoid a
  persistent `preserveDrawingBuffer`), post the bytes to the host as a new
  protocol message, and save via `vscode.window.showSaveDialog` +
  `workspace.fs.writeFile` — the same shape as the existing `exportResult` flow
  in `src/provider.ts`.
- **Notes:** protocol addition → update `doc/protocol.md` (docs-sync rule).

### 4. First user-settings surface — S

The extension currently contributes **zero** settings. Add a
`contributes.configuration` section: default background, default mesh-size
preset, show grid/axes on open, default up axis.

- **How:** read via `workspace.getConfiguration` in `src/provider.ts` and pass
  to the webview alongside the initial `meshingOptions` / `loadUrl` messages.
  Per-document state stays in sidecars; settings are only cross-document
  defaults.

## P2 — Mid-term: visualization & UX depth

### 5. Live clipping / section planes — M

A display-only cross-section: pick a plane axis, drag an offset slider, see
inside the model.

- **How:** Three.js `renderer.localClippingEnabled` + `clippingPlanes` on the
  face/edge materials built in `src/webview/geometryBuilder.ts`; UI in the
  view-controls area. The FE-mesh overlay materials need the same planes.
- **Notes:** explicitly distinct from the existing `section` *edit op* (which
  produces real geometry through the op stack); this never touches the model.

### 6. FE mesh quality statistics — M

After **Generate**, report per-element quality (min/mean + histogram) in the
FE Mesh panel, with optional worst-element highlighting.

- **How:** probe whether `mesh.getElementQualities` is bound in the bundled
  gmsh-wasm (repo convention: verify against the live WASM, never assume); if
  not, compute aspect ratio host-side from the node coordinates
  `src/gmshService.ts` already extracts. Highlighting can reuse the existing
  `elementGroups` multi-material mechanism of the overlay.

### 7. Per-part isolate/hide and Components-tree search — M

Visibility eye-toggles on part rows (`src/webview/partsPanel.ts`) and tree nodes
(`src/webview/treePanel.ts`), an "isolate" action, and a filter input over the
Components tree.

- **Notes:** pure webview, `Object3D.visible` only — the same display-only rule
  the mesh overlay follows. Visibility is transient (not persisted to the parts
  sidecar) unless a real need emerges.

### 8. Appearance controls — S–M

Background color, orthographic/perspective camera toggle (the main camera is
currently `PerspectiveCamera` only — the ortho camera exists solely inside the
orientation cube), edge visibility toggle, model opacity slider.

- **How:** lives in the view-controls pad (`src/viewerDom.ts` +
  `src/webview/main.ts` wiring); defaults come from the new settings surface
  (item 4).

### 9. Drag-and-drop open — S

Drop a CAD file onto the viewer to open it.

- **How:** webview `drop` handler posting a new open-path message; falls back to
  the existing `openFileDialog()` in `src/provider.ts` when the browser exposes
  no filesystem path for the dropped file.

### 10. Live exploded-view slider — S–M

Explode currently exists only as a discrete, undoable edit op. Add an
interactive slider that previews the explosion factor live.

- **How:** drive the *existing* explode math
  (`occtOperations.explodeSolids` / `meshEdits.applyMeshExplode`) as a
  display-only preview, with an "apply as edit op" button that commits the
  current factor through the normal op stack — so persistence semantics stay
  unchanged.

## P3 — Exploratory: bigger bets

### 11. meshio++ WASM integration — L

Bundle [`@meshioplusplus/wasm`](https://www.npmjs.com/package/@meshioplusplus/wasm)
(MIT — GPL-compatible, satisfying this repo's bundled-dependency license rule;
record the attribution in the README's Licensing section) as a third host-side
WASM module.

- **Why:** it reads/writes ~40 mesh formats — including **MED and CGNS, which
  the bundled gmsh-wasm build cannot write** (it throws "compiled without
  support"; see [GMSH Integration](./gmsh-integration.md)) — plus Exodus, VTU,
  XDMF, and more.
- **What it unlocks:**
  - **Import** of FE mesh formats (VTK, MED, CGNS, Exodus, MDPA, …) as viewable
    documents — a new branch in `src/fileRouter.ts`.
  - **Export** of generated FE meshes to the formats gmsh-wasm lacks.
  - Possibly replacing the hand-written `src/mdpaWriter.ts` — to be evaluated
    carefully: the current writer carries Kratos-specific orientation and
    SubModelPart logic that must not regress.
- **How:** follow the exact `occtService.ts` / `gmshService.ts` conventions:
  lazy init (never in `activate()`), memoized module singleton, explicit
  `wasmBinary` read from `dist/`, check the package's `import`-vs-`require`
  bundling behavior, and keep stdout clean in the MCP bundle. Update the
  capability matrix in `doc/mcp-server.md` and the MCP tools per the sync rule.

### 12. Units handling — M

Read the STEP file's length unit at import; display a unit suffix in
measurements, mass properties, and mesh-size fields; optionally convert units on
export. Today no unit metadata is read or displayed anywhere.

### 13. Model comparison — L

Open two versions of a model side by side with a visual diff (added / removed /
moved solids, matched by bounding-box/centroid heuristics). Exploratory — open
questions include how two documents share one custom-editor architecture and
how to present the diff without misleading false matches.

## Non-goals / known constraints

- **Writing the CAD source file** — never. The read-only invariant (sidecar
  persistence, export-only baking) is architectural, not a missing feature.
- **Hex-dominant mixed meshing** — `Mesh.Recombine3DAll` is non-functional in
  the bundled gmsh-wasm build (see
  [GMSH Integration — Known limitations](./gmsh-integration.md)).
- **CGNS/MED export via Gmsh** — the bundled build lacks the HDF5-backed
  writers; superseded by the meshio++ integration (item 11) rather than a
  custom Gmsh build.
- **OCCT in the webview** — the kernel stays in the extension host; the webview
  runs only Three.js (architecture invariant).
