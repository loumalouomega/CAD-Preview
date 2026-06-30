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
- **Read-only.** CAD Preview is a preview-only extension. The opened file itself cannot be edited or saved over from the 3D view — **Export** writes a new, separate file in a different format and never modifies the original.
