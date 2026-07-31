# File Formats

CAD Preview supports two classes of 3D files: **B-rep** (boundary representation) formats that require tessellation, and **mesh** formats that are already triangulated.

## Format Overview

| Format | Extensions | Pipeline | Grouped by solid |
| --- | --- | --- | :-: |
| STEP | `.step`, `.stp` | OCCT → BRepMesh | ✅ |
| IGES | `.iges`, `.igs` | OCCT → BRepMesh | ✅ |
| BREP | `.brep` | OCCT → BRepMesh | ✅ |
| STL | `.stl` | Three.js STLLoader | — |
| OBJ | `.obj` | Three.js OBJLoader | per-object |
| PLY | `.ply` | Three.js PLYLoader | — |
| glTF | `.gltf`, `.glb` | Three.js GLTFLoader | per-mesh node |
| VTK / VTU | `.vtk`, `.vtu` | meshio++ → STL boundary → Three.js STLLoader | — |
| MED | `.med` | meshio++ → STL boundary → Three.js STLLoader | — |
| CGNS | `.cgns` | meshio++ → STL boundary → Three.js STLLoader | — |
| Exodus | `.exo`, `.e` | meshio++ → STL boundary → Three.js STLLoader | — |
| XDMF | `.xdmf` | meshio++ → STL boundary → Three.js STLLoader | — |
| Kratos MDPA | `.mdpa` | meshio++ → STL boundary → Three.js STLLoader | — |

## B-rep Formats (OCCT Pipeline)

B-rep files describe solid geometry analytically (surfaces, edges, vertices) rather than as triangles. CAD Preview tessellates them on-the-fly using [OpenCascade.js](https://ocjs.org/).

### Processing Steps

1. **Read** — the appropriate OCCT reader parses the file bytes:
   - STEP: `STEPControl_Reader_1`
   - IGES: `IGESControl_Reader_1`
   - BREP: `BRep_Builder` + `BRepTools::Read`
2. **Tessellate** — `BRepMesh_IncrementalMesh_2` with:
   - Linear deflection: `0.1`
   - Angular deflection: `0.5` (radians)
3. **Extract faces** — `TopExp_Explorer` walks the `TopoDS_Shape`, visiting each `TopoDS_Face`. For each face, the triangulation (`Poly_Triangulation`) is pulled from the location-transformed face and converted to WebGL-ready `Float32Array` positions and `Uint32Array` indices. Each face gets a stable id (`face-N`, deterministic explorer order) and records its parent solid.
4. **Extract edges** — `extractEdges()` walks every `TopoDS_Edge`, de-duplicating shared edges by `HashCode` + `IsSame` (this OCCT build does not bind `TopTools_IndexedMapOfShape`), and discretizes each unique edge to a polyline via `BRepAdaptor_Curve` + `GCPnts_UniformDeflection`. Each gets a stable id (`edge-N`).
5. **Group** — faces are collected into `SolidGroup`s, one per top-level solid (`TopAbs_SOLID`). In the webview each face becomes its own `THREE.Mesh` and each edge its own `THREE.Line`, parented under a per-solid `THREE.Group` — so faces, edges, and solids can all be picked and coloured independently.
6. **Encode** — positions and indices are base64-encoded and posted to the webview as `EncodedMesh` (faces) and `EncodedEdge` (edges) objects.

### Tessellation Quality

The linear deflection of `0.1` is a reasonable default for mechanical parts. Decrease it (e.g. `0.01`) for smoother curved surfaces at the cost of more triangles. This value is hardcoded in `src/meshExtract.ts`; it is not currently user-configurable.

### Solid Grouping

A `SolidGroup` maps to one `THREE.Group` child of the root, holding one `THREE.Mesh` per face. The `userData.groupId` (the solid id) links faces to the component tree panel for highlighting; each face mesh also carries `userData.entityType = "surface"` and `userData.entityId = face-N`. Each group's `faceCount` is the number of OCCT faces (not triangles) that were extracted.

### STEP

STEP (ISO 10303) is the most common exchange format for CAD. CAD Preview reads AP203 and AP214 (and AP242 in practice). Shell assemblies, free surfaces, and wire edges are not rendered — only faces that yield a triangulation.

### IGES

IGES (Initial Graphics Exchange Specification) is an older format. The OCCT reader handles most IGES entity types but edge cases (trimmed surfaces, complex NURBS) may result in incomplete geometry.

### BREP

BREP is OpenCascade's native binary topology format. It reads fast and has no conversion artifacts. The `BRepTools::Read` function parses directly into a `TopoDS_Shape`.

---

## Mesh Formats (Three.js Pipeline)

Mesh files contain pre-triangulated geometry. The extension host resolves the file to a `vscode-webview://` URI via `webviewPanel.webview.asWebviewUri()` and posts it to the webview, which loads it directly with a Three.js loader.

### STL

Binary and ASCII STL are both supported via `STLLoader`. The result is a single `THREE.Mesh`. Vertex normals are embedded in the STL format; they are used as-is.

**Limitation:** STL has no material, color, or hierarchy. A default grey `MeshStandardMaterial` is applied.

### OBJ

`OBJLoader` produces a `THREE.Group` of meshes corresponding to the `o` / `g` groups in the OBJ file.

**Limitation:** `.mtl` material files are not loaded. If the OBJ file references an MTL, the material block is ignored and a default material is applied by `applyDefaultMaterial()` in `src/webview/meshLoaders.ts`.

### PLY

`PLYLoader` loads the file as a single `THREE.BufferGeometry`. If the PLY file lacks vertex normals, `computeVertexNormals()` is called automatically to generate smooth normals.

**Limitation:** Vertex colors in PLY are not currently applied to the material.

### glTF / GLB

`GLTFLoader` supports the full glTF 2.0 spec, including embedded textures, materials, and scene hierarchies. CAD Preview uses `gltf.scene` (the root `THREE.Group`) from the parsed result.

**Limitations:**

- Animation playback is not supported. Only the bind pose (frame 0) is rendered.
- The component tree is built from the `Object3D` name hierarchy, not from glTF extras.

---

## meshio++ Bridge Formats (VTK, MED, CGNS, Exodus, XDMF, Kratos MDPA)

These six formats have no native Three.js loader, so the extension host converts them to a triangulated **boundary surface** in STL form first — [meshio++](https://github.com/loumalouomega/meshioplusplus) (`@meshioplusplus/wasm`, a third host-side WASM module alongside OCCT and Gmsh) reads the source file and calls `convertSurface` (entirely inside its C++ core — a volume mesh becomes its boundary, everything else passes through), producing ASCII STL bytes. Those bytes are sent to the webview (`loadMeshBytes` protocol message, base64-over-postMessage) and fed through the **exact same STL loader** a native `.stl` open uses — see `src/meshioService.ts`'s `convertToStlBoundary()` and `doc/gmsh-integration.md`'s "The meshio++ bridge" section (which also covers the reverse direction: exporting a *generated* FE mesh to MED/CGNS/ XDMF, independent of this import path).

### Processing Steps

1. **Read + convert** — `convertToStlBoundary(sourceBytes, format)` writes the raw file bytes into meshio++'s own virtual filesystem and calls `convertSurface(inPath, outPath, {inFormat: format, outFormat: "stl"})`.
2. **Transport** — the resulting STL bytes are base64-encoded and posted as `{type: "loadMeshBytes", sourceFormat, dataBase64}`.
3. **Load** — the webview base64-decodes them, wraps them in a `blob:` object URL, and calls the same `loadMeshFromUrl(url, "stl")` a native `.stl` open uses — from this point on, a meshio-imported document is **indistinguishable from a native STL** to every other feature (facet splitting, Parts, Edits, Export, Mass Properties, Measurement all work identically).

### What's Preserved, What's Not

Only geometry (points + triangle connectivity) becomes actual Parts/geometry through this funnel — region names, scalar point/cell data (temperatures, stresses, …), and multi-material grouping in the source file are **not** converted into anything you can select, colour, or export. As of the "Richer meshio++ import visibility" improvement, CAD-Preview now tells you what's *there* even though it isn't (yet) used: if the source file declares named regions or data arrays, opening it shows a one-line status message (and, via the MCP server, a `load_model` warning) naming them — informational only, not a preview of that data's actual values. See CLAUDE.md's "meshio++ integration" section for the full scope (including the mechanism identified for turning region names into real Parts, deliberately not shipped yet). If you need to actually inspect scalar field values or colour by them, use a dedicated FE post-processing tool (e.g. ParaView) for these formats; CAD-Preview's support here is for quick geometry previews alongside your CAD files.

### Kratos MDPA note

Unlike the MDPA **export** path (`src/mdpaWriter.ts`, hand-written — see `doc/gmsh-integration.md`'s "Kratos MDPA" section), **importing** an `.mdpa` file as a document goes through meshio++'s own native MDPA reader (mesh-level blocks only — `Nodes`/`Elements`/`Conditions`/`SubModelPart`; Kratos `Properties`/`Table`/`Geometries`/`Constraints` blocks are not represented in the WASM binding and throw if present, same as everywhere else meshio++ reads MDPA). These are two entirely independent code paths that happen to share a file extension — one reads MDPA (via meshio++, for the Components view), the other writes MDPA (hand-rolled, for FE mesh export) — neither replaces the other.

---

## Parts Sidecar (`<model>.parts.json`)

User-defined **parts** (named groups of volumes / surfaces / lines) are stored in a JSON sidecar written **next to** the CAD file — e.g. `bull.stp` → `bull.stp.parts.json`. The CAD file itself is never modified; the custom editor stays read-only. The sidecar is read on open (`readParts()`) and autosaved, debounced, on every edit (`writeParts()`), both in `src/partsStore.ts`. Parsing and serialization live in the vscode-free `src/partsSidecar.ts` so they are unit-tested.

```json
{
  "version": 1,
  "source": "bull.stp",
  "parts": [
    {
      "name": "Inlet",
      "color": "#e6194b",
      "volumes": ["solid-0"],
      "surfaces": ["face-3", "face-7"],
      "lines": ["edge-12"]
    }
  ]
}
```

Entity ids are the stable topological ids assigned during extraction (`solid-*`, `face-*`, `edge-*`). For mesh formats (which have no stored B-rep topology), the whole object is a **volume** with a stable traversal-order id (`node-*`), and each connected near-coplanar **facet** detected on load is a **surface** (`node-*/face-*`); meshes have no assignable lines. Ids stay valid as long as the source file is unchanged. Parsing is tolerant: a missing or hand-corrupted sidecar yields an empty part list rather than blocking the model from opening.

## Edits Sidecar (`<model>.edits.json`)

User-applied **edit operations** (transforms and booleans, and — in later milestones — feature modeling, assembly) are stored in a **second** JSON sidecar next to the CAD file — e.g. `bull.stp` → `bull.stp.edits.json`. Like parts, this never modifies the CAD file: the editor stays read-only. The sidecar holds an **ordered, replayable op-list** that is re-applied on every open, so the displayed model is `base shape ∘ ops`. It is read on open (`readEdits()`) and autosaved, debounced, on every change (`writeEdits()`), both in `src/editsStore.ts`; parse/serialize live in the vscode-free `src/editsSidecar.ts` so they are unit-tested.

```json
{
  "version": 1,
  "source": "bull.stp",
  "variables": [
    { "name": "L", "expr": "20", "value": 20 },
    { "name": "W", "expr": "L/2", "value": 10 }
  ],
  "ops": [
    { "op": "translate", "targets": ["solid-0"], "vec": [10, 0, 0] },
    { "op": "rotate", "targets": ["solid-0"], "axisPoint": [0, 0, 0], "axisDir": [0, 0, 1], "angleDeg": 45 },
    { "op": "addBox", "center": [0, 0, 0], "size": [20, 10, 5], "exprs": { "size[0]": "L", "size[1]": "W" } }
  ]
}
```

### Parametric variables

The optional top-level `variables` array holds the document's named **parametric variables** (`{name, expr, value}`), and any op may carry an optional `exprs` annotation mapping a numeric field path (`length`, `size[1]`, `points[2][0]`) to an expression string over them. Editing a variable in the panel re-resolves every annotated op and rebuilds the geometry live. Rules:

- **Numeric fields are last-good caches.** The addressed field always holds the most recent successful evaluation, so a consumer that ignores `exprs` (or an older extension version) still sees a fully-resolved op. Parsing re-resolves ops against the variables (`parseEditsJson`), so hand-editing a variable's `expr` in the sidecar takes effect on the next open.
- **Expressions** support numbers, variable names, `+ - * / ^`, parentheses, `sqrt/abs/min/max/floor/ceil/round/sin/cos/tan` (trig in **degrees**, matching the `*Deg` angle fields), and `pi`. Evaluation is a small closed interpreter (`src/paramExpr.ts`) — never `eval()`.
- **A variable may reference only variables defined above it** in the list (derived values like `W = L/2` work; cycles are unrepresentable). A variable whose expression fails keeps its cached `value`.
- **Failures freeze, never crash:** an op whose expression references a deleted variable — or whose resolved values would violate a cross-field invariant (e.g. a torus with `minorRadius ≥ majorRadius`) — keeps its previous numbers and a warning is shown; replay continues.
- `variables` is omitted when empty, so pre-parametric sidecars are unchanged. The `version` stays `1`. Note: an **older** extension version rewriting the sidecar drops `variables` and `exprs` (it serializes only what it knows).

**Where ops are applied** mirrors the read/export split:

| Source pipeline | Edit engine | Supported ops (current) |
| --- | --- | --- |
| B-rep (STEP/IGES/BREP) | host, OCCT (`applyEditsBRep`, `src/occtOperations.ts`) | every op kind: transforms, boolean, fillet/chamfer, extrude/revolve/sweep/loft, shell/splitByPlane/section, explode/mate, all primitives (incl. wedge) and holes, all 2D profile sketches, all curves, and the bottom-up wireframe/build ops |
| Mesh (STL/OBJ/PLY/glTF) | webview, Three.js (`applyEditsMesh`, `src/webview/meshEdits.ts`) | translate, rotate, scale, mirror, boolean (via `three-bvh-csg`), explode, addBox, addSphere, addCylinder, addCone, addTorus, addPrism, and the hole family (addHole/addCounterboreHole/addCountersinkHole, via CSG subtraction) — everything else (fillet/chamfer, feature-modeling, shell/split/section, mate, wedge, the 2D profile ops, curves, and the bottom-up wireframe ops) is B-rep only |

Primitive-creation ops (`addBox`/`addSphere`/`addCylinder`/`addCone`/`addTorus`/ `addPrism`) are an op family that needs **no existing operands** — they build a new body from parameters alone and append it, on both pipelines, no B-rep-only restriction (`addWedge` is the exception: B-rep only). The hole ops (`addHole`/`addCounterboreHole`/`addCountersinkHole`) are the opposite of the other `add*` ops — **subtractive**: they cut a cylindrical (optionally counterbored/countersunk) hole into the selected target volumes, on both pipelines.

The 2D profile ops (`addCircleProfile`/`addRectangleProfile`/`addPolygonProfile`/ `addEllipseProfile`/`addRoundedRectangleProfile`/`addSlotProfile`/ `addTrapezoidProfile`) similarly need no operands, but build a **flat face** (no thickness) rather than a solid, and are B-rep only — their purpose is to be picked (Surf mode) as an `extrude`/`revolve`/`sweep`/`loft` profile afterward. The curve ops (`addPolyline`/`addThreePointArc`/`addSpline`/`addBezier`/ `addEllipseArc`/`addHelix`) append standalone edges the same way the wireframe ops below do (B-rep only; `addSpline` is an approximating, endpoint-exact fit). The modify ops (`shell`/`splitByPlane`/`section`, B-rep only) reshape existing solids: shell hollows the solids owning the selected opening faces, split cuts the targets by a plane keeping one or both sides, and section appends the planar cross-section as a sketch face without touching the solids. They're grouped together under a `"Sketches"` pseudo-body in the Components tree/view, made visible by a "free-face" pass in the tessellation pipeline (see `doc/extension-host-api.md`). Extruding/ revolving/sweeping/lofting a sketch consumes it into the resulting solid — it doesn't leave a duplicate face behind.

The bottom-up wireframe ops (`addPoint`/`addLine`/`addArc`/`addSurfaceFromLines`/ `addVolumeFromSurfaces`) let a shape be built up the traditional CAD way instead of from parametric primitives or profile extrusion: place standalone points, connect them with lines/arcs (typed endpoints, not point references), select a closed set of lines and **Build → Surface** to assemble a face, then select a closed set of surfaces and **Build → Volume** to sew them into a solid. Like the 2D profile ops, all five are B-rep only — meshes have no wire/sewing concept — and a point-select mode (`📍 Point`) shows every vertex in the model (original geometry's corners as well as added points), consistent with how Vol/Surf/Line already show everything. An `addSurfaceFromLines`/`addVolumeFromSurfaces` selection that doesn't actually close (open chain of lines, open shell of surfaces) is skipped gracefully — no error, no op applied.

Op order is preserved (replay depends on it). Parsing is tolerant: malformed ops are dropped via `validateEditOp` (`src/editOps.ts`) and a corrupt or missing sidecar yields an empty list rather than blocking the model. **Export bakes the edits in** — the export pipeline re-applies the same ops to the exported geometry.

> **Entity-id drift:** topology-changing ops (booleans, fillet, feature modeling) re-tessellate into new `face-*`/`edge-*` ids, so a part assignment made before such an op may no longer resolve afterwards. The tolerant parts parser drops unresolved ids on reload, so this degrades gracefully rather than erroring.

## Mesh Options Sidecar (`<model>.mesh.json`) and Generated `.geo` Script

The **FE Mesh** panel's finite-element mesh generation settings (via [Gmsh](https://gmsh.info) compiled to WebAssembly — see [GMSH Integration](./gmsh-integration.md)) are stored in a **third** JSON sidecar next to the CAD file — e.g. `bull.stp` → `bull.stp.mesh.json`. Like parts and edits, this never modifies the CAD file. It is read on open (`readMeshOptions()`) and autosaved, debounced (~500 ms, its own timer), on every options change (`writeMeshOptions()`), both in `src/meshOptionsStore.ts`; parse/serialize live in the vscode-free `src/meshOptionsSidecar.ts` so they are unit-tested.

```json
{
  "version": 1,
  "source": "bull.stp",
  "options": {
    "dimension": 3,
    "sizeMin": 0,
    "sizeMax": 1e22,
    "algorithm2D": 6,
    "algorithm3D": 1,
    "elementOrder": 1,
    "optimize": true,
    "stlAngle": 40
  }
}
```

On the same debounce, `writeGeoScript()` also (re)generates an editable Gmsh `.geo` script beside the sidecar — e.g. `bull.stp` → `bull.stp.geo` — merging the source file and setting one `Mesh.*` option per `MeshOptions` field:

```
Merge "bull.stp";
Mesh.MeshSizeMin = 0;
Mesh.MeshSizeMax = 1e22;
Mesh.Algorithm = 6;
Mesh.Algorithm3D = 1;
Mesh.ElementOrder = 1;
Mesh.RecombineAll = 0;
Mesh.SubdivisionAlgorithm = 0;
Mesh.Optimize = 1;
Mesh 3;
```

**This `.geo` file is a one-way, generated **output**, not an input CAD-Preview reads back.** It exists so the mesh can be regenerated or tweaked directly in Gmsh outside the editor. Hand-edits made to it are silently overwritten the next time an option changes in the FE Mesh panel — CAD-Preview never parses `.geo` files itself. Parsing the sidecar is tolerant: a missing or hand-corrupted `<model>.mesh.json` falls back to `DEFAULT_MESH_OPTIONS` rather than blocking the panel from working.

A `sizeMax` of `1e22` is Gmsh's "unbounded" sentinel: it means "no explicit target size was ever chosen", and the webview displays it as an empty **auto** field, seeding a bounding-box-derived default (model diagonal / 20) over it in memory once the model loads. That seed is display-only — neither sidecar file is created or rewritten until the user actually changes an option in the panel.

**Exported mesh artifacts:** the FE Mesh panel's export `<select>` + **📤 Export** write further output files via a native Save dialog, in whichever format is picked — hand-written Kratos `.mdpa` (the default; either an Elements + Conditions or a Geometries layout, see [GMSH Integration § Kratos MDPA](gmsh-integration.md#kratos-mdpa-hand-written-not-a-gmshwrite-format)), GMSH's native `.msh` mesh format (nodes + elements), the legacy `.msh2` (v2.2) variant, Gmsh's fully-expanded `.geo_unrolled` script, or any of VTK/I-DEAS Universal (`.unv`)/Abaqus (`.inp`)/Nastran (`.bdf`)/SU2 (`.su2`)/INRIA Medit (`.mesh`)/STL/Diffpack (`.diff`)/OFF — see [GMSH Integration § Export formats](gmsh-integration.md#export-formats) for the full registry and which formats this WASM build actually supports. Like every other Export target in this codebase, these are save-as artifacts the user places wherever they choose; they are not sidecars and are not read back by CAD-Preview.

## Preprocess Archive (`.zip`)

**File ▸ Save Preprocess…** (Ctrl+Alt+S) packages the CAD source file plus whichever of its three sidecars — `<model>.parts.json`, `<model>.edits.json`, `<model>.mesh.json` — and the generated `<model>.geo` script currently exist on disk into a single `.zip`, so the whole working state of a document can be shared, archived, or moved as one file. Which pieces are included is purely file-existence-driven: a document that never had meshing options set simply has no `.mesh.json`/`.geo` in the archive — this is normal, not an error. Pending debounced sidecar writes are flushed immediately before packaging (the same flush **Save** triggers), so the archive always reflects the current in-editor state, not a stale on-disk one.

The archive's internal layout (built by the pure, vscode-free `src/preprocessArchive.ts`, shared by the extension and the MCP server):

```
manifest.json         { "version": 1, "source": "bull.stp" }
bull.stp              (the CAD source, byte-identical)
bull.stp.parts.json   (only if it exists)
bull.stp.edits.json   (only if it exists)
bull.stp.mesh.json    (only if it exists)
bull.stp.geo          (only if it exists)
```

**File ▸ Load Preprocess…** (Ctrl+Alt+O) is the inverse: pick a `.zip`, then pick a destination path for the restored CAD file (defaulting to the manifest's `source` filename, beside the archive), and CAD-Preview writes the source bytes plus every sidecar the archive contains — named to match the chosen destination, not the archive's original filename — then opens the result. The archive's `.geo` text is **not** restored verbatim: if a `.mesh.json` is present, its options are re-written through the normal `writeMeshOptions`/`writeGeoScript` path instead, so the one-way-generated script stays in lockstep with the (re-validated) options, same rule every other options write follows. Loading an archive never touches the CAD file it was originally saved from — it always creates a separate file at the chosen destination.

The headless MCP server exposes the same behavior as `save_preprocess`/ `load_preprocess` (see [MCP Server](mcp-server.md)), sharing the identical `preprocessArchive.ts` build/read logic — an archive saved from the extension loads via the MCP tool and vice versa.

## Export

The **File ▸ Export…** menu item (or Ctrl+E) converts the currently displayed model into a compatible format and saves it via a native VS Code save dialog. The available targets depend on the source file's pipeline (`exportTargetsFor()` in `src/exportTargets.ts`):

| Source pipeline | Export targets |
| --- | --- |
| B-rep (STEP/IGES/BREP) | the other two B-rep formats, **plus** STL/OBJ/PLY/glTF |
| Mesh (STL/OBJ/PLY/glTF) | the other mesh formats only |
| meshio++ (VTK/MED/CGNS/Exodus/XDMF/MDPA) | STL/OBJ/PLY/glTF — the displayed model is an ordinary `THREE.Object3D` by this point (see the meshio++ Bridge Formats section above), so it exports exactly like a native mesh source |

The source format is never offered as its own export target (moot for the meshio++ row above, since none of those formats are export targets to begin with).

**B-rep targets** are written entirely in the extension host: the source file is re-parsed with the same OCCT reader used to open it, the current edit op-list is applied (`applyEditsBRep`), then the result is handed to the matching OCCT writer (`STEPControl_Writer`, `IGESControl_Writer`, or `BRepTools::Write`) in `exportBRep()` (`src/occtService.ts`). There is no path from a triangulated mesh back to a B-rep, so mesh-sourced documents never offer STEP/IGES/BREP as a target.

**Mesh targets** are written in the webview, reusing Three.js's bundled exporters (`three/examples/jsm/exporters/`) on the `THREE.Object3D` already displayed — regardless of whether it arrived via a native loader or OCCT tessellation. The serialized result is sent back to the host over the protocol described in [Host ↔ Webview Protocol](./protocol.md) and written to disk there, since only the host can show file dialogs.

glTF export always produces a binary `.glb` file (not a text `.gltf` with embedded base64 buffers) — a single portable file, no separate buffer references to manage.

## File Size Guidance

| Format | Practical limit | Notes |
| --- | --- | --- |
| STEP / IGES | ~50 MB | Tessellation is CPU-bound in the extension host process |
| BREP | ~100 MB | Faster read than STEP/IGES; still tessellated |
| STL | ~200 MB | Binary STL loads fast; ASCII STL is much slower for large files |
| OBJ | ~100 MB | Parsing is text-based; large files may be slow |
| PLY | ~200 MB | Binary PLY is fast |
| glTF | ~100 MB | Depends on embedded texture size |

These are rough guidelines, not hard limits. Performance depends on vertex count after tessellation, not just file size.
