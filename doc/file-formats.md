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
| XDMF | `.xdmf` (+ its `.h5` sibling, if any) | meshio++ → STL boundary → Three.js STLLoader | — |
| Kratos MDPA | `.mdpa` | meshio++ → STL boundary → Three.js STLLoader | — |
| OpenFOAM | `.foam` | meshio++ (case staging) → STL boundary → Three.js STLLoader | — |
| Gmsh Mesh | `.msh`, `.msh2` | meshio++ → STL boundary → Three.js STLLoader | — |
| Abaqus | `.inp` | meshio++ → STL boundary → Three.js STLLoader | — |
| I-DEAS Universal | `.unv` | meshio++ → STL boundary → Three.js STLLoader | — |
| SU2 | `.su2` | meshio++ → STL boundary → Three.js STLLoader | — |
| INRIA Medit | `.mesh` | meshio++ → STL boundary → Three.js STLLoader | — |
| GiD Postprocess | `.post.msh` (+ its `.post.res` sibling) | meshio++ → STL boundary → Three.js STLLoader | — |

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

**Host-side parsing.** Display goes through Three.js's `GLTFLoader` as described above, but a *second*, independent path exists for the features that need triangle geometry outside the webview: `src/gltfParser.ts` is a pure, hand-rolled glTF 2.0 / GLB parser (the fourth member of the `stlParser.ts` / `objParser.ts` / `plyParser.ts` family) that reads every mesh primitive's `POSITION` attribute and indices, transforms them by each node's world matrix, and welds the result into one shared index space. It is **geometry-only** — materials, textures, cameras, skins, animations, and morph targets are ignored entirely — and its unit tests cross-check every fixture against three.js's own `GLTFLoader` (`src/gltfParser.crossvalidation.test.ts`), which is what makes hand-rolling it defensible: a subtly-wrong parser producing plausible-but-wrong centroids and volumes would be worse than not supporting the format at all. This is what makes **Compare Models**, **check_mesh_health**, **promote_mesh_to_brep**, and **silhouette SVG export** work for `.gltf`/`.glb` sources.

Two host-side-parsing caveats, both surfaced as clear errors rather than silently-wrong geometry:

- **Compressed geometry is rejected.** A file whose `extensionsRequired` names `KHR_draco_mesh_compression` or `EXT_meshopt_compression` fails with an error naming the extension — this parser cannot decode compressed buffers. (Geometry-irrelevant extensions — `KHR_materials_*`, `KHR_texture_transform`, `KHR_lights_punctual`, … — are handled perfectly by ignoring them, and `KHR_mesh_quantization` is genuinely supported.)
- **External `.bin` buffers are read from beside the model.** A `.gltf` whose `buffers[].uri` points at a sibling file works normally; a sibling that can't be read is a clear error, not a silently-empty mesh. A self-contained `.glb`, or a `.gltf` with base64 data URIs, needs no sibling at all.

Fixtures: `examples/GLTF/cube.gltf`, `examples/GLTF/cube.glb`, and `examples/GLTF/two-boxes.gltf`.

---

## meshio++ Bridge Formats (VTK, MED, CGNS, Exodus, XDMF, Kratos MDPA, OpenFOAM, and more)

These formats — VTK/VTU, MED, CGNS, Exodus, XDMF, Kratos MDPA, OpenFOAM, Gmsh Mesh, Abaqus, I-DEAS Universal, SU2, INRIA Medit, and GiD Postprocess — have no native Three.js loader, so the extension host converts them to a triangulated **boundary surface** in STL form first — [meshio++](https://github.com/loumalouomega/meshioplusplus) (`@meshioplusplus/wasm`, a third host-side WASM module alongside OCCT and Gmsh) reads the source file and calls `convertSurface` (entirely inside its C++ core — a volume mesh becomes its boundary, everything else passes through), producing ASCII STL bytes. Those bytes are sent to the webview (`loadMeshBytes` protocol message, base64-over-postMessage) and fed through the **exact same STL loader** a native `.stl` open uses — see `src/meshioService.ts`'s `convertToStlBoundary()` and `doc/gmsh-integration.md`'s "The meshio++ bridge" section (which also covers the reverse direction: exporting a *generated* FE mesh to MED/CGNS/XDMF/VTU/and more, independent of this import path).

OpenFOAM is the one exception to the single-file shape: a `.foam` file is an (usually empty) **marker** — the ParaView convention — whose real mesh lives in sibling files under `<marker's parent>/constant/polyMesh/`. `src/meshioService.ts`'s `convertFoamCaseToStlBoundary(markerPath)` takes the marker's filesystem path, stages the whole case into meshio++'s virtual filesystem itself, and hand-builds the STL by fan-triangulating every boundary face (meshio++'s own STL writer emits zero facets for the quad-only boundaries typical of hex-dominant CFD meshes). OpenFOAM import is **geometry-only**: patch names ride a C++ side-channel its JS binding doesn't expose, and field files in the case's time directories are not read at all — no Parts are auto-created and the colour-by-field selector stays empty.

**Gmsh Mesh / Abaqus / I-DEAS Universal / SU2 / INRIA Medit close a real export/import asymmetry**: the FE Mesh panel already *wrote* `.msh`/`.inp`/`.unv`/`.su2`/`.mesh` via Gmsh's own writer, but until now had no way to re-*open* any of them — this codebase's own exported files were not importable. Each was verified round-trippable end-to-end against the live WASM (export a real tetrahedralized model, then `readMesh()` the result back) before being added; two formats Gmsh ALSO writes were tried and **rejected** after the same check — `.bdf` (Nastran) and `.off` round-trip through meshio++'s reader for the same nominal format with a parse error (`"Not a meshio++-C++ Nastran file"` / `"Expected the first line to be 'OFF'"`), meaning Gmsh's writer output for those two isn't shaped the way meshio++'s own reader for them expects. Neither is claimed as an import format.

**GiD Postprocess (`.post.msh`) is a sibling pair, and a compound extension.** Its ascii flavour splits a model across `<stem>.post.msh` (geometry) and `<stem>.post.res` (results), the second discovered purely by swapping that final segment — nothing inside the `.post.msh` names it. CAD Preview routes only the `.post.msh`; the `.post.res` is not independently openable (it is not a mesh) but is staged alongside the primary by the same `src/meshioCompanions.ts` machinery that stages XDMF's `.h5`. Because `.post.msh` **ends in `.msh`**, which is registered to a different format (Gmsh), `routeFile` matches the **longest registered suffix first** — a last-dot-only lookup would silently resolve every GiD file to a Gmsh parse that then fails, which is precisely the bug meshio++ itself had to fix in its own `resolve_format` in 10.18.0. Only the ascii flavour is claimed: meshio++ also reads GiD's `binary` (`.post.bin`) and `hdf5` (`.post.h5`) flavours, but this codebase has no fixture verifying either. GiD is also an **export** target — see `doc/gmsh-integration.md`'s "The meshio++ bridge".

**`.msh` and `.inp` are ambiguous extensions**, each used by more than one format meshio++ can read (`.msh`: Gmsh, ANSYS, FreeFem; `.inp`: Abaqus, ANSYS APDL). CAD Preview always assumes the format it itself writes (Gmsh for `.msh`, Abaqus for `.inp`) and shows a one-line status caveat on open — an ANSYS-authored `.msh` or `.inp` file will not parse correctly. There is deliberately no content-sniffing disambiguation into the alternate formats: this codebase has no real ANSYS/FreeFem-authored fixture to verify such a read against, so claiming that support would be an unverified promise (see `src/fileRouter.ts`'s `AMBIGUOUS_MESHIO_EXTENSIONS`).

**XDMF's `.h5` sibling is now staged automatically.** Earlier versions of this bridge wrote only the primary file's bytes into meshio++'s MEMFS, so an XDMF using the (default) `"HDF"` heavy-data format could never be read back at all (`HDF5: could not open file ...h5`) — every attempt failed before meshio++ ever got as far as interpreting the mesh. Opening an `.xdmf` now scans its own `<DataItem Format="HDF">` references (`src/meshioCompanions.ts`'s `extractXdmfHdfReferences`, a plain regex scan — no XML parser in this vitest config) and stages the referenced `.h5` file(s) alongside it under their exact referenced basename, if present beside the source. An XDMF using the `"XML"`/`"Binary"` data formats needs no companion and is unaffected either way.

**A SEPARATE, pre-existing meshio++ 10.20.2 limitation was found while verifying this fix, and is NOT fixed by it: an XDMF whose mesh mixes cell types (points, lines, triangles, tetrahedra, …) into one "Mixed" topology block cannot be read back by meshio++'s own reader** (`"XDMF: unknown mixed topology index"` — reproduced with a bare hand-built mesh, no CAD-Preview code involved, so this is meshio++'s own writer/reader pairing, not something fixable here). Since this codebase's `generate_mesh` always forces Gmsh's `Mesh.SaveAll=1` (see `doc/gmsh-integration.md`'s "Parts → physical groups" section), which includes 0-D point elements alongside the real mesh, **an XDMF file exported BY THIS EXTENSION'S OWN FE Mesh panel is almost always Mixed-topology and currently cannot be re-meshed after reimport** — `load_model` still succeeds (region/metadata reading degrades gracefully, per the established "never throws, empty on failure" contract, rather than surfacing this), but `generate_mesh` on the reimported file fails with the error above. A genuinely single-cell-type XDMF (e.g. hand-authored, or written by a different tool) is unaffected by this and round-trips correctly — verified independently of the `.h5`-companion fix, which is itself confirmed working (the failure mode changes from "companion missing" to "mixed topology" once the companion is present, never the other way around).

### Processing Steps

1. **Companions** — for a multi-file format (currently: XDMF's `.h5`), the host resolves and reads whatever sibling the source references, from beside the source file (`provider.ts`'s `resolveMeshioCompanionsFor` / `mcpTools.ts`'s `resolveMeshioCompanions` — the disk-I/O half; `meshioCompanions.ts`'s `meshioCompanionCandidates` is the pure, shared "which basenames to look for" half). A missing companion is silently skipped, not an error — a self-contained source still opens.
2. **Read + convert** — `convertToStlBoundaryWithRegions(sourceBytes, format, sourceName, companions)` stages the primary (and any companions) into meshio++'s own virtual filesystem under their real basenames, `readMesh()`s the full mesh, and — when the file declares ≥1 named `kind: "cell"` region and the boundary comes back pure triangles — correlates each boundary triangle to its region via `extractSurface(mesh, recordParentIds=true)`'s `cell_data["surface:parent_cell"]` provenance array. Falls back to the plain `convertToStlBoundary()` (`convertSurface(inPath, outPath, {inFormat: format, outFormat: "stl"})`) with no region data for anything else (quad/hex boundaries, no regions, correlation finding nothing).
3. **Transport** — the resulting STL bytes are base64-encoded and posted as `{type: "loadMeshBytes", sourceFormat, dataBase64, regionAssignment?}`.
4. **Load** — the webview base64-decodes them, wraps them in a `blob:` object URL, and calls the same `loadMeshFromUrl(url, "stl")` a native `.stl` open uses — from this point on, a meshio-imported document is **indistinguishable from a native STL** to every other feature (facet splitting, Parts, Edits, Export, Mass Properties, Measurement all work identically). When `regionAssignment` is present, the facet split is region-aware (see below) so a Part auto-created from a region references real, resolvable facet ids.

### What's Preserved, What's Not

Only geometry (points + triangle connectivity) becomes actual geometry through this funnel. **Named `kind: "cell"` regions now DO become real Parts**, for the tetrahedral/triangular-boundary case: on first import (only when the parts sidecar is still empty — an existing Part is never overwritten), CAD-Preview auto-creates one selectable, colourable Part per region (`src/meshioRegionParts.ts`'s `buildPartsFromMeshioRegions`), persisted to the usual `<model>.parts.json` sidecar exactly like a manually-created Part. This works identically whether the file is opened in VS Code or loaded headlessly via the MCP server's `load_model` (one shared implementation, not two that could drift).

**Named point/cell scalar data arrays (temperatures, stresses, …) can now be visualized too — interactively, via the view-controls "Colour by field" selector** (webview-only, no MCP tool). Picking a field fetches its values on demand (`src/meshioService.ts`'s `readMeshioFieldValues`, same triangle-boundary correlation mechanism as region→Parts) and paints the model as a viridis colour ramp with a legend; picking "None" reverts. This is display-only — no new data is stored, exported, or made selectable/queryable, and a field's actual per-point/per-cell values are never available headlessly via the MCP server. Quad/hex volume boundaries, `kind: "point"`/`"side"` regions, and whole-mesh `field_data` (not spatially varying — nothing to colour by) are still **not** handled by any mechanism — their NAMES are surfaced informationally only (a one-line status message on open, and a `load_model` warning via the MCP server). See CLAUDE.md's "meshio++ integration" section for the full mechanism and its exact scope. If you need to actually inspect scalar field values numerically, use a dedicated FE post-processing tool (e.g. ParaView) for these formats; CAD-Preview's support here is for quick geometry/region/field previews alongside your CAD files, not full FE post-processing.

### Kratos MDPA note

Unlike the MDPA **export** path (`src/mdpaWriter.ts`, hand-written — see `doc/gmsh-integration.md`'s "Kratos MDPA" section), **importing** an `.mdpa` file as a document goes through meshio++'s own native MDPA reader (mesh-level blocks only — `Nodes`/`Elements`/`Conditions`/`SubModelPart`; Kratos `Properties`/`Table`/`Geometries`/`Constraints` blocks are not represented in the WASM binding and throw if present, same as everywhere else meshio++ reads MDPA). These are two entirely independent code paths that happen to share a file extension — one reads MDPA (via meshio++, for the Components view), the other writes MDPA (hand-rolled, for FE mesh export) — neither replaces the other. Non-sequential ("gapped") node ids — routine in real Kratos decks, since SubModelPart extraction, entity removal and deck merging all leave them — are supported (`@meshioplusplus/wasm` ≥ 9.13; regression-fixture: `examples/MDPA/gapped-ids.mdpa`, whose original ids surface as `mdpa:id` point/cell data names).

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

## View State Sidecar (`<model>.view.json`)

The persisted **camera orientation, display mode, ortho/perspective toggle, and clip plane** (roadmap "View-state persistence", closed) are stored in a **fourth** JSON sidecar next to the CAD file — e.g. `bull.stp` → `bull.stp.view.json`. Like the other three, this never modifies the CAD file. It is read on open (`readViewState()`) and autosaved, debounced (~500 ms, its own timer), on every user-facing view change — camera orbit/pan/zoom/dolly, Fit/Reset, the orientation gizmo, the Ortho/Persp toggle, a Display mode button, the clip axis/offset/toggle, **or the split-view layout picker / any per-pane camera move** (Phase 2) — both in `src/viewStateStore.ts`; parse/serialize live in the vscode-free `src/viewStateSidecar.ts` so they are unit-tested.

```json
{
  "version": 1,
  "source": "bull.stp",
  "view": {
    "viewDirection": [1, 0.8, 1],
    "cameraUp": [0, 1, 0],
    "orthographic": false,
    "displayMode": "shaded",
    "clip": null
  },
  "layout": "1x2",
  "panes": [
    { "viewDirection": [1, 0, 0], "cameraUp": [0, 1, 0], "orthographic": false },
    { "viewDirection": [0, 1, 0], "cameraUp": [0, 0, 1], "orthographic": true }
  ]
}
```

`layout` (`"1x1"|"1x2"|"2x1"|"2x2"`, Phase 2 — absent/`"1x1"` = single pane) and `panes` (one `PaneViewState` per pane of that layout, row-major) are optional siblings of `view` at the file's top level, never inside `view` itself; a `1×1` session writes neither, so existing single-pane sidecars stay byte-stable. `view` stays the focused/single-pane state, so an older build reading a new sidecar still restores sensibly, and vice versa — purely additive, no version bump. Only camera state (`viewDirection`/`cameraUp`/`orthographic`) is per-pane; display mode and clip stay global, matching Phase 1's scoping.

`viewDirection`/`cameraUp` are a normalized direction (target → camera) and up vector, not a raw position/target/distance — `Viewer.frame(direction)` already re-derives both from the model's current bounding box, so this survives edits that change the model's extents. `clip.offsetFrac` is likewise a fraction of the model's bbox, not a raw plane constant — measured along the clip's **active normal**. `clip` may carry an optional explicit unit `normal` (`{axis, offsetFrac, normal?}`) which wins over `axis` when present; `axis` is still always written, set to that normal's dominant axis, so an older build restores a sensible neighbouring clip instead of none. A malformed `normal` drops only itself, leaving the clip as its axis form — unlike a malformed `axis`, which still drops the whole `clip`. Parsing is tolerant like the other three sidecars, with one stricter rule: a missing or degenerate (all-zero) `viewDirection`/`cameraUp` rejects the WHOLE record (falls back to no persisted view, i.e. the default isometric) rather than feeding NaN/zero into the camera — every other field falls back individually (an unrecognized `displayMode` → `"shaded"`, a malformed `clip` → `null`, an unknown `layout` → ignored as `"1x1"`, a bad per-pane entry → falls back to `view`'s own direction/up/ortho for that pane, a short/long `panes` array → padded/truncated to `paneCount(layout)`).

**Deliberately excludes explode-preview state** — that's a session-only interaction preview by design (`src/webview/explodePreview.ts`); the *committed* `explode` edit op already persists correctly via `.edits.json`. **Deliberately excluded from the Preprocess Archive** (below) — unlike parts/edits/mesh options, view state is purely a display/session preference with no effect on computed geometry, mesh output, or anything an MCP agent would need; there is also no MCP tool surface for it at all (same "genuinely a display feature, no headless equivalent" scope this codebase already applies to Markup and interactive Measurement).

## Annotations Sidecar (`<model>.annotations.json`)

User-**pinned measurements** (roadmap "Persisted, topology-anchored annotations", closed) — a "📌 Pin" action on a completed Measure-tool result — are stored in a **fifth** JSON sidecar next to the CAD file — e.g. `bull.stp` → `bull.stp.annotations.json`. Like the other four, this never modifies the CAD file. It is read on open (`readAnnotations()`) and autosaved, debounced (~500 ms, its own timer), on every pin/rename/delete (`writeAnnotations()`), both in `src/annotationsStore.ts`; parse/serialize live in the vscode-free `src/annotationsSidecar.ts` so they are unit-tested. The headless MCP server has a byte-compatible counterpart in `src/mcpSidecars.ts`.

```json
{
  "version": 1,
  "source": "bull.stp",
  "annotations": [
    {
      "id": "ann-1234567890-1",
      "tool": "distance",
      "text": "12.5 mm",
      "anchorPoint": [5, 0, 0],
      "linePoints": [[0, 0, 0], [10, 0, 0]],
      "volumes": [],
      "surfaces": ["face-1", "face-4"],
      "lines": [],
      "points": [],
      "tolerance": { "nominal": 12, "plus": 0.1, "minus": 0.05, "measured": 12.5 }
    }
  ]
}
```

Entity ids in `volumes`/`surfaces`/`lines`/`points` are the same stable topological ids `Part` uses, and are rebound through the identical best-effort geometric matching a topology-changing edit already applies to Parts (`src/entityFacts.ts`'s `rebindPartsAcrossOps`, extended to also rebind annotations via the same shape-diff pass at no extra cost) — an anchor that can't be confidently re-matched is dropped from these arrays, the same graceful-degradation contract unresolved Part ids already have. `text`/`anchorPoint`/`linePoints` are a **frozen** snapshot of the measurement result at pin time; they are never recomputed on reopen or after an edit — only whether the annotation is "detached" (none of its anchor ids currently resolve in the loaded model) is computed live, in the webview. Parsing is tolerant like the other four sidecars: a missing/malformed field drops that one annotation entry, not the whole file.

The optional `tolerance` object (roadmap "Tolerance-band fact checks on exact measurements") records a nominal-plus-band intent from the Measure panel's inline fields: `nominal`/`plus`/`minus` are the band (a symmetric ± when `plus === minus`; both allowances ≥ 0), and `measured` is the raw numeric value frozen at pin time so the in/out-of-band colour can be re-derived on redisplay without parsing formatted text back into a number. Facts only — nothing stores a verdict; `src/toleranceBand.ts`'s shared `evaluateToleranceBand` computes it at render time (the same pure module the MCP `check_tolerance` tool uses). A malformed band drops the BAND only — the annotation survives as a plain untoleranced pin. A toleranced pin's label reads `"<text> [nominal ±band]"`, and it appears decorated the same way in SVG/DXF silhouette-export dimension glyphs. **Included in the Preprocess Archive** (below), alongside parts/edits/mesh options (roadmap "Archive integrity", closed).

## Construction Planes Sidecar (`<model>.planes.json`)

Named **construction planes** (roadmap "A named, persisted construction-plane entity", Phase 3 closed) — reusable datum planes saved from the current clip or entered numerically in the view-controls **Planes** group — are stored in a **sixth** JSON sidecar next to the CAD file — e.g. `bull.stp` → `bull.stp.planes.json`. Like the other five, this never modifies the CAD file. It is read on open (`readPlanes()`) and autosaved, debounced (~500 ms, its own timer), on every add/rename/delete (`writePlanes()`), both in `src/planesStore.ts`; parse/serialize live in the vscode-free `src/planesSidecar.ts` so they are unit-tested. The headless MCP server has a byte-compatible counterpart in `src/mcpSidecars.ts`, written by the `set_plane` tool and reported by `get_state`.

```json
{
  "version": 1,
  "source": "bull.stp",
  "planes": [
    {
      "id": "plane-0",
      "name": "Top datum",
      "point": [0, 0, 10],
      "normal": [0, 0, 1],
      "derivedFrom": "face-12"
    }
  ]
}
```

**Unlike every other sidecar that references geometry, a plane stores resolved vectors rather than entity ids** — so it takes no part in entity-id rebinding at all. A topology-changing edit that renumbers `face-N` and rebinds Parts and annotations leaves this file byte-identical, which is the whole point of naming a plane: it stays where it was put. `derivedFrom` records where the plane came from (`"face-12"`, `"clip plane"`, `"entered"`) for display only and is never resolved back to geometry.

`id` is `plane-N` and is **never reused** — the next is the highest existing N plus one — so deleting a plane and adding another cannot resurrect the old id under a new meaning. Parsing is tolerant like the other sidecars: a malformed entry drops that one plane, not the file; `normal` is normalized on read, so a hand-edited `[0, 0, 10]` still yields a unit vector; and a zero-length normal drops that plane, since it describes no plane at all. **Included in the Preprocess Archive** (below).

## Preprocess Archive (`.zip`)

**File ▸ Save Preprocess…** (Ctrl+Alt+S) packages the CAD source file plus whichever of its sidecars — `<model>.parts.json`, `<model>.annotations.json`, `<model>.planes.json`, `<model>.edits.json`, `<model>.mesh.json` — currently exist on disk into a single `.zip`, so the whole working state of a document can be shared, archived, or moved as one file. Which pieces are included is purely file-existence-driven: a document that never had meshing options set simply has no `.mesh.json` in the archive — this is normal, not an error. Pending debounced sidecar writes are flushed immediately before packaging (the same flush **Save** triggers), so the archive always reflects the current in-editor state, not a stale on-disk one. The generated `.geo` script is deliberately **not** packaged (see below).

The archive's internal layout (built by the pure, vscode-free — but Node-only, never imported by the webview — `src/preprocessArchive.ts`, shared by the extension and the MCP server):

```
manifest.json               { "version": 2, "minimumReaderVersion": 1, "source": "bull.stp",
                               "checksums": { "bull.stp": "<sha256 hex>", "bull.stp.parts.json": "<sha256 hex>", ... } }
bull.stp                    (the CAD source, byte-identical)
bull.stp.parts.json         (only if it exists)
bull.stp.annotations.json   (only if it exists)
bull.stp.edits.json         (only if it exists)
bull.stp.mesh.json          (only if it exists)
```

**Archive integrity (roadmap "Archive integrity", closed).** `manifest.checksums` records a SHA-256 hex digest for every entry the writer included — cryptographic tamper-evidence on top of zip's own CRC32, which only catches accidental corruption, not deliberate tampering. `readPreprocessZip()` recomputes and compares every present entry's checksum before returning anything, throwing a clear "failed its checksum" error on a mismatch. `manifest.minimumReaderVersion` is a **forward**-compatibility gate, not a backward one: it names the oldest reader version required to correctly interpret this archive, and a reader whose own capability is older refuses to open it (rather than silently misinterpreting fields it doesn't recognize) with a clear "requires a newer version of CAD Preview" error. Both fields are new in manifest version 2; a **legacy v1 archive** (written before this feature — no `checksums`, no `minimumReaderVersion` field at all) still opens exactly as before, with checksum verification simply skipped — reading tolerantly defaults a missing `version`/`minimumReaderVersion` to `1`, never inventing the current version the way an earlier build's `parseManifest` used to (a real, if minor, gap this closed: nothing ever compared the invented value against anything, so a hypothetical future format bump would have loaded silently misinterpreted).

**File ▸ Load Preprocess…** (Ctrl+Alt+O) is the inverse: pick a `.zip`, then pick a destination path for the restored CAD file (defaulting to the manifest's `source` filename, beside the archive), and CAD-Preview writes the source bytes plus every sidecar the archive contains — named to match the chosen destination, not the archive's original filename — then opens the result. Mesh options (if present) are re-written through the normal `writeMeshOptions`/`writeGeoScript` path, which regenerates `.geo` fresh from them — the archive never packages a raw `.geo` text to restore verbatim in the first place, since neither reader ever did anything with one when it was still packaged (pure dead weight, closed alongside the integrity work above). **The destination's file extension is checked against the archive's own source format** (roadmap "Archive integrity", closed) — restoring a STEP archive to `restored.stl` now fails with a clear error instead of silently succeeding; a same-format alias (`.stp`/`.step`) still compares equal, since both route to the same `FileRoute.format`. Loading an archive never touches the CAD file it was originally saved from — it always creates a separate file at the chosen destination.

The headless MCP server exposes the same behavior as `save_preprocess`/ `load_preprocess` (see [MCP Server](mcp-server.md)), sharing the identical `preprocessArchive.ts` build/read logic — an archive saved from the extension loads via the MCP tool and vice versa.

## Export

The **File ▸ Export…** menu item (or Ctrl+E) converts the currently displayed model into a compatible format and saves it via a native VS Code save dialog. The available targets depend on the source file's pipeline (`exportTargetsFor()` in `src/exportTargets.ts`):

| Source pipeline | Export targets |
| --- | --- |
| B-rep (STEP/IGES/BREP) | the other two B-rep formats, **plus** STL/OBJ/PLY/glTF |
| Mesh (STL/OBJ/PLY/glTF) | the other mesh formats only |
| meshio++ (VTK/MED/CGNS/Exodus/XDMF/MDPA/OpenFOAM) | STL/OBJ/PLY/glTF — the displayed model is an ordinary `THREE.Object3D` by this point (see the meshio++ Bridge Formats section above), so it exports exactly like a native mesh source |

The source format is never offered as its own export target (moot for the meshio++ row above, since none of those formats are export targets to begin with).

**B-rep targets** are written entirely in the extension host: the source file is re-parsed with the same OCCT reader used to open it, the current edit op-list is applied (`applyEditsBRep`), then the result is handed to the matching OCCT writer (`STEPControl_Writer`, `IGESControl_Writer`, or `BRepTools::Write`) in `exportBRep()` (`src/occtService.ts`). There is no path from a triangulated mesh back to a B-rep, so mesh-sourced documents never offer STEP/IGES/BREP as a target.

**Mesh targets** are written in the webview, reusing Three.js's bundled exporters (`three/examples/jsm/exporters/`) on the `THREE.Object3D` already displayed — regardless of whether it arrived via a native loader or OCCT tessellation. The serialized result is sent back to the host over the protocol described in [Host ↔ Webview Protocol](./protocol.md) and written to disk there, since only the host can show file dialogs.

glTF export always produces a binary `.glb` file (not a text `.gltf` with embedded base64 buffers) — a single portable file, no separate buffer references to manage.

### Silhouette SVG/DXF Export

**File ▸ Export Silhouette SVG…** / **File ▸ Export Silhouette DXF…** (or the matching `CAD Preview: Export Silhouette …` commands) are a **third** export case, deliberately outside the Export… quick-pick above: they write a 2D **outline drawing** rather than a 3D model, so this is neither a B-rep target nor a mesh target and never appears in `exportTargetsFor()`'s list. The two menu items share one flow — a view quick-pick (**Current view** — the angle you are currently looking at — then Front/Back/Top/Bottom/Left/Right/Iso), then the same export-unit quick-pick every other export shows, then a save dialog — differing only in the serializer used (`src/svgSilhouette.ts` vs `src/dxfSilhouette.ts`, over the *same* segment list, so an SVG and a DXF of one view are geometrically consistent). Pressing Escape on the *view* pick cancels the export (it is the primary choice); Escape on the *unit* pick still exports at native mm, matching the existing convention.

> **It is an outline, not a dimensioned 2D technical drawing. There is no hidden-line removal.** Back-facing geometry is not drawn, but neither are interior feature edges that do not lie on a silhouette. OCCT's `HLRBRep_*` hidden-line machinery is entirely unavailable in this WASM build, and `HLRAppli_ReflectLines` — the one surviving green alternative — was probed against the live kernel and produced a strictly *worse* drawing (missing the part's holes and interior cutout), so the outline is derived from **triangle adjacency** instead: an edge is kept where its two adjacent triangles disagree about facing the viewer. That choice is also why this works for mesh sources and not just B-rep. Treat the result as a review/illustration artifact; use the Measurement tools for any dimension you need to be sure of.

| Source | Geometry the outline is derived from |
| --- | --- |
| STEP / IGES / BREP | the tessellation of the current model, **edits baked in** |
| STL / OBJ / PLY / glTF | the raw file bytes, **edits not baked in** (there is no host-side mesh edit engine — same limitation Compare Models has) |
| meshio++ (VTK/MED/CGNS/Exodus/XDMF/MDPA/OpenFOAM) | rejected — those formats never expose a triangle array back to JS |

The output is a single self-contained `<path>` — no `<style>`, no script, no external references — so it embeds anywhere. **1 SVG user unit = 1 model unit**, with the document's physical `width`/`height` given in millimetres, so a drawing exported from a native (mm) model prints 1:1 in any vector tool. Choosing a non-mm unit applies the same real coordinate scale every other export in this codebase uses, before projection. The DXF variant is minimal model-space `ENTITIES` only: chained collinear runs become `LWPOLYLINE`s and unmatched singletons stay independent `LINE`s, at 1 DXF drawing unit = 1 model unit.

**Limitation — triangle winding.** The facing test depends on consistent triangle winding across the mesh. A mesh with mixed winding (some triangles clockwise, some counter-clockwise, as some exporters and hand-edited files produce) yields spurious interior lines, because the test flips with the winding. There is no cheap, reliable way to repair winding for an arbitrary open mesh, so this is documented rather than worked around.

The same capability is available headlessly as the MCP server's `export_svg_silhouette` tool (its `format` param selects `"svg"` or `"dxf"`) — see [MCP Server](./mcp-server.md).

### DXF Import

**File ▸ Import DXF…** reads a `.dxf` file's model-space `ENTITIES` section and converts each supported entity into an existing parametric profile/curve edit op — genuinely no new geometry kernel surface. Handled: `LINE`, `LWPOLYLINE` (bulge arcs sampled), `POLYLINE`/`VERTEX`, `CIRCLE`, `ARC`, and `SPLINE` (control points); everything else (blocks, INSERT, TEXT/MTEXT, DIMENSION, HATCH, paper space) is skipped. Like SVG import, it is **B-rep sources only** — mesh files have no sketch topology to receive the imported ops — and placement follows the same simple defaults: flat in the XY plane at z=0, 1 DXF drawing unit = 1 mm, Y-up native (DXF needs no flip, unlike SVG). A poorly-scaled source is adjusted afterward with the ordinary `scale`/`translate`/`rotate` ops.

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
