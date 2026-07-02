# Getting Started

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

## Opening a File

CAD Preview activates automatically via the VS Code [Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors). There is nothing to configure.

Open any supported file — for example, from the Explorer or via `File > Open File…`. VS Code routes it to the CAD Preview custom editor and the 3D view renders immediately.

### Supported Formats

| Format | Extensions | Rendering Pipeline |
|--------|-----------|-------------------|
| STEP | `.step`, `.stp` | OpenCascade.js tessellation |
| IGES | `.iges`, `.igs` | OpenCascade.js tessellation |
| BREP | `.brep` | OpenCascade.js tessellation |
| STL | `.stl` | Three.js `STLLoader` |
| OBJ | `.obj` | Three.js `OBJLoader` |
| PLY | `.ply` | Three.js `PLYLoader` |
| glTF / GLB | `.gltf`, `.glb` | Three.js `GLTFLoader` |

> **B-rep vs mesh:** STEP, IGES, and BREP are boundary-representation formats that are tessellated on-the-fly in the extension host. STL, OBJ, PLY, and glTF are already triangulated and are loaded directly into the webview by Three.js.

## User Interface

### Camera Interaction

| Action | Control |
|--------|---------|
| Orbit | Left-click drag |
| Pan | Right-click drag |
| Zoom | Scroll wheel |

Camera movement uses Three.js `OrbitControls` with damping enabled for smooth deceleration.

### Toolbar

The toolbar appears at the top of the editor:

| Button | Action |
|--------|--------|
| **Fit** | Reframe the model to fill the viewport (keeps current camera orientation) |
| **Wireframe** | Toggle wireframe rendering on/off |
| **Grid** | Show/hide the world-space grid and axis helpers |
| **Export** | Convert the model to a compatible format and save it (see [Exporting a Model](#exporting-a-model)) |
| **Tree** | Show/hide the component tree panel (visible only for models with multiple components) |
| **🔬 FE Mesh** | Toggle the generated finite-element mesh overlay on/off (see [Generating an FE Mesh](#generating-an-fe-mesh)). The **FE Mesh** panel itself is always visible in the sidebar; this button only shows/clears the overlay. |
| **Select / Point·Vol·Surf·Line** | Toggle entity selection mode and choose what a click picks — points (vertices), volumes (solids), surfaces (faces), or lines (edges). Used to assign geometry to parts (see [Defining Parts](#defining-parts)) and to feed the wireframe **Build** composer (see [Editing Geometry](#editing-geometry)). |

### View-Controls Panel

The collapsible panel at the bottom-right provides discrete camera controls without a mouse:

- **⌄ / ⌃ toggle** — Collapse or expand the panel.
- **Rotate buttons** — Step the camera by 15°, 45°, or 90° around the azimuth or elevation.
- **Pan buttons** — Shift the camera target by a fraction of the viewport.
- **Zoom buttons** — Dolly in or out by a fixed factor.
- **Fit** — Same as the toolbar Fit button (reframe in current orientation).
- **Ctr** — Reset to the default isometric view `(1, 0.8, 1)` and reframe.

### Orientation Cube

A labeled orientation cube sits in the top-left corner of the 3D view. It mirrors the current camera direction in real time.

Click any face of the cube to snap the camera to that standard view:

| Face | View |
|------|------|
| **+X / -X** | Right / Left |
| **+Y / -Y** | Top / Bottom |
| **+Z / -Z** | Front / Back |

### Component Tree Panel

For multi-solid STEP/IGES assemblies or glTF scenes with multiple meshes, the component tree panel shows the model hierarchy. Click any row to highlight that solid/mesh in the 3D view (all others are dimmed). Click the same row again or click an empty area to deselect.

### Defining Parts

CAD Preview lets you group geometry into named **parts** (the FEM
sub-model-part / boundary-group concept). The **Parts** panel sits below the
component tree in the left sidebar.

To assign geometry to a part:

1. Click **Select** in the toolbar to enter selection mode, and choose a pick
   target: **Vol** (solids), **Surf** (faces), or **Line** (edges).
2. Click entities in the 3D view to select them — they highlight blue.
   Shift-click to add or remove from the selection; a plain click selects just
   one; clicking empty space clears the selection.
3. Click **＋ New** in the Parts panel to create a part, then click the **＋**
   on that part's row to assign the current selection to it.

Each part has an editable name, a colour swatch (click to recolour), and a
`v/s/l/p` badge counting its volumes / surfaces / lines / points. Assigned entities are
painted in the part's colour in the 3D view. Expand a part to see and remove
individual entities; click a part row to highlight all of its entities. The
**✕** on a part deletes it.

Parts are saved automatically to a `<model>.parts.json` sidecar next to the CAD
file and reloaded when you reopen it — the CAD file itself is never modified. See
[Parts Sidecar](./file-formats.md#parts-sidecar-modelpartsjson) for the format.

> **Mesh formats** (STL/OBJ/PLY/glTF) have no stored face/edge topology. CAD
> Preview segments each mesh into connected, near-coplanar **facets** on load, so
> **Surf** picks a flat face (a cube → its 6 faces) and **Vol** picks the whole
> object. Highly curved meshes that would split into very many facets are kept
> whole; **Line** and **Point** are disabled for meshes.

### Editing Geometry

The **Edits** panel (below the Parts panel) applies non-destructive **edit
operations** to the model. Edits never touch the CAD file — they are saved as an
ordered, replayable op-list in a `<model>.edits.json` sidecar and re-applied each
time you open the file.

To apply a transform:

1. Click **Select**, choose **Vol** mode, and click one or more volumes (solids).
2. In the **Edits** panel pick an operation — **Move**, **Rotate**, **Scale**, or
   **Mirror** — and fill in the numeric fields.
3. Click **Apply**. The model updates live and the operation is added to the list.

| Edits control | Action |
|---|---|
| **Move / Rotate / Scale / Mirror** | Choose the transform, enter parameters, **Apply** it to the selected volumes |
| **Unite / Subtract / Intersect** | Select operand-A volumes and click **Set A**, then select operand-B volumes and click **Apply** |
| **Fillet / Chamfer** | Select edges (**Line** mode), enter the radius / setback, and **Apply** (B-rep only) |
| **Extrude / Revolve / Sweep / Loft** | Select a profile face (**Surf** mode; a path edge too for Sweep, 2+ faces for Loft), set parameters, **Apply** — builds a new body (B-rep only) |
| **Explode** | Enter a spread factor and **Apply** — spreads the bodies radially from the model centre (all formats) |
| **Mate** | Select two faces (**Surf** mode): face A then face B, and **Apply** — aligns A onto B (B-rep only) |
| **Box / Sphere / Cylinder / Cone / Torus / Prism** | Choose the primitive, enter its centre/axis/dimensions, and **Add** — appends a new body at that placement (no selection needed; all formats) |
| **Circle / Rectangle / Polygon** | Choose the shape, enter its centre/normal/dimensions (Rectangle & Polygon also take an **Up** direction), and **Sketch** — appends a flat profile face you can later select (**Surf** mode) and feed into Extrude/Revolve/Sweep/Loft (no selection needed; B-rep only) |
| **Point / Line / Arc** | Choose the entity, enter its coordinates (typed, not picked), and **Add** — appends a standalone point/line/arc you can select later (**Point**/**Line** mode) (no selection needed; B-rep only) |
| **Build → Surface** | Select ≥3 lines (**Line** mode) that close into a loop and click **Surface** — assembles them into a new flat face under "Sketches" (B-rep only) |
| **Build → Volume** | Select ≥4 surfaces (**Surf** mode) that close into a shell and click **Volume** — sews them into a new closed solid (B-rep only) |
| **↶ / ↷** | Undo / redo the last operation |
| **Clear** | Remove all operations (back to the original model) |

The current release ships **transforms** (move/rotate/scale/mirror), **booleans**
(unite/subtract/intersect), **fillet/chamfer**, **feature modeling**
(extrude/revolve/sweep/loft), **assembly** ops (explode/mate), **primitive creation**
(box/cube, sphere, cylinder, cone, torus, N-sided prism), **2D profile sketches**
(circle, rectangle, N-sided polygon), and **bottom-up wireframe modeling** (points,
lines, arcs → surfaces built from a set of lines → volumes built from a set of
surfaces). Transforms, booleans, explode, and primitive creation work on both B-rep
and mesh files; fillet/chamfer, feature-modeling, mate, 2D profile sketches, and the
wireframe/build ops are available only for B-rep sources (the panel disables them
for meshes). Feature-modeling ops and primitives **append a new body** to the model —
they never cut or fuse the source. For primitives, `center` is the body's geometric
centre (box/sphere/torus) or its base centre (cylinder/cone/prism, extruded along
`Axis`) — matching how the underlying CAD kernel places them. A 2D profile sketch
builds a flat face, not a body — it's meant to be picked and extruded/revolved/swept/
lofted; doing so consumes the sketch into the new solid rather than leaving a
duplicate flat face behind. Building a Surface or Volume needs an already-closed
selection (a loop of lines, a sealed set of surfaces); an open selection is silently
skipped rather than producing a malformed body.

When you **Export** an edited model, the edits are baked into the output file. See
[Edits Sidecar](./file-formats.md#edits-sidecar-modeleditsjson) for the format.

### Generating an FE Mesh

The **FE Mesh** panel (below the Edits panel) generates a finite-element mesh
(nodes + triangles/tetrahedra) of the currently displayed model using
[Gmsh](https://gmsh.info) compiled to WebAssembly. The result is shown as a blue
overlay on top of the existing geometry — it never replaces or modifies the
original model. See [GMSH Integration](https://loumalouomega.github.io/CAD-Preview/gmsh-integration)
for the full technical write-up.

To generate a mesh:

1. Set the meshing options in the panel: **Dimension** (1D/2D/3D), **Size min /
   max**, **2D algorithm** / **3D algorithm**, **Element order** (linear/
   quadratic), and **Optimize**.
2. Click **▶ Generate**. The overlay appears and the panel's status line shows
   `Nodes: N · Elements: M`, or an error message if generation fails.
3. Click **🔬 FE Mesh** in the toolbar to show/hide the overlay without
   discarding it; click **Clear** in the panel to remove it entirely.

| FE Mesh control | Action |
|---|---|
| **Dimension** | 1D (edges only), 2D (surface triangulation), or 3D (volume tetrahedralization) |
| **Size min / max** | Bounds on generated element size (`Mesh.MeshSizeMin`/`Mesh.MeshSizeMax`) |
| **2D algorithm / 3D algorithm** | The Gmsh meshing algorithm to use for each dimension |
| **Element order** | Linear (1) or quadratic (2) elements |
| **Optimize** | Run Gmsh's mesh optimizer after generation |
| **▶ Generate** | Run Gmsh now with the current options and show the result as an overlay |
| **Export format `<select>`** | Pick which Gmsh output format **📤 Export** writes — Gmsh Mesh (`.msh`), Gmsh Mesh v2/Legacy (`.msh2`), Gmsh Geometry (`.geo_unrolled`), VTK, I-DEAS Universal (`.unv`), Abaqus (`.inp`), Nastran Bulk Data (`.bdf`), SU2, INRIA Medit (`.mesh`), STL Mesh, Diffpack (`.diff`), or OFF |
| **📤 Export** | Mesh with the current options and save the result in the format picked above, via a Save dialog (independent of whether **▶ Generate** was already clicked — it always (re)generates fresh) |
| **Clear** | Remove the mesh overlay (the original model is unaffected either way) |

Mesh options are saved automatically to a `<model>.mesh.json` sidecar next to the
CAD file, and an editable `<model>.geo` Gmsh script is regenerated alongside it on
every change — see [Mesh Options Sidecar](./file-formats.md#mesh-options-sidecar-modelmeshjson-and-generated-geo-script)
for the format. **The `.geo` file is one-way: hand-edits to it are never read back
by the extension** — use the FE Mesh panel to change options, not the generated
script. Neither file modifies the source CAD file.

> **B-rep vs mesh sources:** for STEP/IGES/BREP files, the model currently shown
> (including any applied edits) is re-exported to STEP and handed to Gmsh
> directly. For STL/OBJ/PLY/glTF files, Gmsh has no volume topology to start
> from, so the displayed triangle soup is first reclassified into surfaces at
> sharp-angle boundaries (`classifySurfaces`, default 40°) and rebuilt into a
> closed volume before a 3D mesh can be generated.

### Exporting a Model

Click **Export** in the toolbar to convert the open model and save it as a different
file. The list of offered target formats depends on the file you opened:

| You opened | You can export to |
|---|---|
| STEP, IGES, or BREP | the other two B-rep formats, plus STL, OBJ, PLY, and glTF |
| STL, OBJ, PLY, or glTF | the other mesh formats only |

The format you opened is never offered as an export target. After picking a format
from the quick-pick, a native Save dialog lets you choose the destination — it
defaults to the source file's folder with the new extension. glTF export always
produces a single binary `.glb` file (no separate `.bin`/texture references to
manage).

B-rep targets are converted by OpenCascade.js's own writers, so STEP ↔ IGES ↔ BREP
round-trips preserve true CAD geometry, not just a tessellated approximation. Mesh
targets are generated from the triangulated geometry already shown in the viewer —
there is no way to turn a mesh file (or a tessellated B-rep) back into precise CAD
surfaces, which is why mesh sources can't export to STEP/IGES/BREP.

## Known Limitations

- **No texture support for OBJ.** MTL material files are not loaded; a default grey material is applied.
- **No glTF animations.** Animation playback is not implemented — only the first frame (bind pose) is shown.
- **No BRep-embedded geometry in glTF.** Only triangulated `mesh` primitives inside glTF are rendered.
- **Large assemblies are slow.** STEP/IGES files above ~50 MB may take several seconds to tessellate. Tessellation runs in-process in the Node extension host — there is no streaming.
- **One-time WASM startup.** The first B-rep file open triggers OpenCascade.js initialization (~300 ms on a typical machine). Subsequent B-rep files open faster because the kernel is memoized.
- **Source CAD file is never modified.** CAD Preview never writes the opened CAD file. **Export** writes a new, separate file; **part** definitions are saved to a `<model>.parts.json` sidecar; and **edit operations** are saved to a `<model>.edits.json` sidecar — the original geometry is always left untouched. Edits are non-destructive and replayable, and are baked in only when you **Export**.
