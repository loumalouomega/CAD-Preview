# GMSH Integration (FE Meshing)

CAD Preview can generate a finite-element mesh (nodes + tetrahedra/triangles, GMSH's
native `.msh` format) from the model currently open in the editor, using
[Gmsh](https://gmsh.info) compiled to WebAssembly via
[`@loumalouomega/gmsh-wasm`](https://github.com/loumalouomega/GMSH-JS). This is a
distinct pipeline from the B-rep tessellation used for display (see
[Architecture](architecture.md)) — meshing is opt-in, triggered from the **FE Mesh**
panel, and its output is an overlay on top of the existing view, never a replacement
for it.

## Host-only execution, lazy WASM init

Like OpenCascade.js (see [Architecture § Lazy Singleton Pattern](architecture.md#lazy-singleton-pattern)),
**gmsh-wasm runs only in the Node extension host, never in the webview**, and is
never initialized eagerly. `src/gmshService.ts` holds a module-level
`_gmshPromise: Promise<GmshApi> | null`; the first call to `getGmsh(extensionPath)`
reads `dist/gmsh-core.wasm` from disk, passes it as `wasmBinary` to the raw
Emscripten factory (mirroring the `opencascade.wasm.wasm` loading trick, not the
zero-arg `fetch`-based wrapper), calls the module's own `gmsh.initialize()` exactly
once, and memoizes the resolved promise:

```typescript
export function getGmsh(extensionPath: string): Promise<GmshApi> {
  if (!_gmshPromise) {
    const wasmBinary = fs.readFileSync(path.join(extensionPath, "dist", "gmsh-core.wasm"));
    _gmshPromise = initialize({ wasmBinary }).then((gmsh) => {
      gmsh.initialize();
      return gmsh;
    });
  }
  return _gmshPromise;
}
```

Opening a file never triggers this — only clicking **▶ Generate** or **📤 Export**
in the FE Mesh panel does, exactly the same first-use trigger discipline as
OCCT's `getOcct`. Subsequent mesh generations reuse
the same singleton; per-generation state is reset with `gmsh.clear()` +
`gmsh.model.add(...)` rather than a second `gmsh.initialize()` (see
`loadGeometryAndApplyOptions` in `src/gmshService.ts`).

## Two input paths

`MeshGenerationInput` is a discriminated union of exactly the two shapes the meshing
pipeline can start from:

```typescript
export type MeshGenerationInput =
  | { kind: "brep"; stepBytes: Uint8Array }
  | { kind: "stl"; stlBytes: Uint8Array };
```

`src/provider.ts`'s `resolveMeshInput` picks the input based on the document's
`FileRoute`:

- **B-rep source** (`.step/.stp/.iges/.igs/.brep`) — the source file is re-exported
  to STEP bytes via the existing `exportBRep()` (so live, unsaved edits are baked in
  the same way normal Export does), and those bytes are staged to GMSH's in-memory
  filesystem (MEMFS) as `/model.step`, then loaded with:

  ```typescript
  gmsh.model.occ.importShapes(tmpPath);
  gmsh.model.occ.synchronize();
  ```

  Immediately after `synchronize()`, the B-rep path also threads the document's
  `Part[]` (read fresh from `<model>.parts.json` via `readParts()`) through
  `applyPartsToGmshModel` (`src/gmshPartsMap.ts`) — see
  [Parts → physical groups](#parts--physical-groups-b-rep-only) below. Mesh-source
  input never calls this; `parts` is always `[]` for the STL branch.

- **Mesh source** (`.stl/.obj/.ply/.gltf/.glb`) — the host has no B-rep to
  re-export, so the *webview* serializes whatever `THREE.Object3D` is currently
  displayed to an in-memory STL (reusing the same `exportModel(..., "stl")` mesh
  exporter Export already uses) and sends it up as a base64 `stl` field on the
  `meshingGenerate`/`meshingExport` message. The host writes those bytes to
  `/model.stl` and remeshes it with the STL-specific call sequence:

  ```typescript
  gmsh.merge(tmpPath);
  gmsh.model.mesh.classifySurfaces((options.stlAngle ?? 40) * (Math.PI / 180));
  gmsh.model.mesh.createGeometry();
  const surfaces = gmsh.model.getEntities(2).dimTags as number[];
  // ...collect surface tags...
  const loopTag = gmsh.model.geo.addSurfaceLoop(surfaceTags);
  gmsh.model.geo.addVolume([loopTag]);
  gmsh.model.geo.synchronize();
  ```

  `classifySurfaces` splits the raw STL triangle soup into a set of parametric
  surfaces at sharp-angle boundaries (angle threshold = `options.stlAngle`, default
  40°), `createGeometry` turns those into a real b-rep-like set of `geo` surfaces,
  and the surface loop + volume declare a solid so a 3D mesh can be generated from a
  format that otherwise has no volume topology at all.

Both paths converge on the shared options application in
`loadGeometryAndApplyOptions` (`Mesh.MeshSizeMin/Max`, `Mesh.Algorithm`,
`Mesh.Algorithm3D`, `Mesh.ElementOrder`, `Mesh.RecombineAll`,
`Mesh.SubdivisionAlgorithm`, `Mesh.Optimize`, all via `gmsh.option.setNumber`),
then `generateMesh` calls `gmsh.model.mesh.generate(options.dimension)` and reads
the result back with `gmsh.model.mesh.getNodes()` / `gmsh.model.mesh.getElements()`.

**meshio++-imported documents (VTK/MED/CGNS/Exodus/XDMF/MDPA) still take the
"Mesh source" `{kind: "stl"}` branch above, in the interactive extension —
no third `MeshGenerationInput` kind was added.** They're converted to an STL
boundary surface once at import time (`convertToStlBoundary`, host-side —
see "The meshio++ bridge" below) and displayed in the webview as an ordinary
`THREE.Object3D`, indistinguishable from a native `.stl` open from that point
on; when meshing runs, the *webview* re-serializes that already-displayed
object to STL exactly like any other mesh source, following the same code
path described above. The **headless MCP server** is the one place a genuinely
new STL-sourcing mechanism exists: `mcpTools.ts`'s `resolveMeshInputHeadless`
calls `convertToStlBoundary` directly (no webview involved at all, since the
MCP server has none) to turn the raw file bytes into `{kind: "stl", stlBytes}`
— which is *more* capable than `.obj`/`.ply`/`.gltf` get headless, since
meshio++ runs entirely host-side and those three genuinely have no headless
equivalent (only the webview's Three.js loaders can parse them).

## Element shapes & order

Two options control the generated cell geometry:

- **`elementOrder`** (`1` linear / `2` quadratic) → `Mesh.ElementOrder`. Quadratic
  meshes carry mid-side/-face nodes (tet → tet10, hex → hex27, triangle → tri6,
  quad → quad9). The display overlay renders **corner nodes only** (mid nodes are
  present in the position buffer but unreferenced by the triangulation — a
  quadratic mesh looks the same as its linear skeleton in the overlay).
- **`elementShape`** (`"simplex"` / `"subdivided"`) → `Mesh.RecombineAll` +
  `Mesh.SubdivisionAlgorithm`, via the shared, dimension-dependent
  `gmshShapeOptions(shape, dimension)` helper (`src/meshOptions.ts`), reused by
  both the live-mesh path and the `.geo` generator so they can't drift:

  | shape | 2D | 3D |
  |---|---|---|
  | `simplex` | triangles (`RecombineAll=0`) | tetrahedra |
  | `subdivided` | quads (`RecombineAll=1`, Blossom) | hexahedra (`SubdivisionAlgorithm=2`) |

  The recipe is **dimension-dependent by necessity, verified against the live
  gmsh-wasm build**: 2D quads come out cleanest from Blossom recombination, but the
  3D `RecombineAll` path throws *"Cannot use frontal 3D algorithm with quadrangles
  on boundary"* — all-hex 3D instead needs the subdivision algorithm. `subdivided`
  works with both the Delaunay (`Algorithm3D=1`) and Frontal (`4`) 3D algorithms.

  A **hex-*dominant* mixed mode** (tets+prisms+pyramids+hexes, via
  `Mesh.Recombine3DAll`) is deliberately **not offered** — see
  [Known limitations](#known-limitations).

The single generic per-element-type table `src/gmshElementTypes.ts`
(`GMSH_ELEMENT_TYPES`) is the source of truth for every supported gmsh type's
stride, corner count, boundary-face decomposition, and Kratos mapping. Both the
overlay builders and the MDPA extractor resolve types through it, so the overlay
triangulation and MDPA connectivity can never diverge. Its node-order data and the
gmsh→Kratos permutations were **derived by coordinate-matching against the live
WASM** (`getElementProperties().localNodeCoord`), not from documentation.

## Parts → physical groups (B-rep only)

Generated meshes preserve the user's **parts** (named face/edge/solid/point groups
from the Parts panel, `Part` in `src/protocol.ts`) as Gmsh **physical groups** — so
a `.msh`/`.geo_unrolled` export carries the same named regions a downstream FE
solver expects, and the live overlay recolours per part. This is **B-rep only**,
for the same reason feature-modeling/fillet/chamfer are B-rep only (see
[Geometry editing](../CLAUDE.md#geometry-editing-operations)): Gmsh's STL path
(`classifySurfaces`/`createGeometry`) produces brand-new surface/volume tags with
zero correlation to a mesh-format document's original `node-N`/facet ids, so there
is no reliable way to preserve part membership through it.

**The correlation problem.** `face-N`/`solid-N`/`edge-N`/`point-N` ids are assigned
by CAD-Preview's own OCCT (opencascade.js) walking `TopExp_Explorer` order over the
shape (`src/meshExtract.ts`/`src/occtOperations.ts`). Gmsh re-parses the exported
STEP bytes with its **own, separate** OCCT build baked into gmsh-wasm — a different
WASM module entirely, so no live shape object can be shared between the two, and
there is no guarantee Gmsh's internal entity tags land in the same order (STEP
import order is not a reliable cross-OCCT-build correspondence — `importShapes`'s
`outDimTags` is deliberately **not** relied on for this reason).

`src/gmshPartsMap.ts`'s `applyPartsToGmshModel` resolves the correspondence
**geometrically** instead: for every entity referenced by some part, it computes a
bounding-box centre on both sides — `bboxCenter` (`src/occtOperations.ts`, already
used elsewhere for `explodeSolids`) on CAD-Preview's own OCCT shape (re-read from
the *same* STEP bytes already handed to Gmsh), and `gmsh.model.getBoundingBox(dim,
tag)` on Gmsh's synchronized entities — then nearest-matches them within a
tolerance relative to the whole model's bbox diagonal (`1e-3 × diagonal`), accepted
only if unambiguous (the best match must be either the sole candidate within
tolerance, or meaningfully closer than the runner-up). An unresolved or ambiguous
entity is silently skipped — the same graceful-degradation convention every other
unresolved-id path in this codebase follows (fillet/chamfer/mate/etc.).

Once ids resolve to Gmsh `(dim, tag)` pairs, one `gmsh.model.addPhysicalGroup(dim,
tags, -1, part.name)` call is made per part per dimension it has entities in. This
happens before `mesh.generate()`/`gmsh.write()`, so the `.msh` output's
`$PhysicalNames` section carries the groups natively. **`.geo_unrolled` output does
NOT carry them as textual `Physical Volume(...)`/`Physical Surface(...)` statements**
— see [Known limitations](#known-limitations)'s XAO entry for why and how that
export is actually made to round-trip the groups.

`loadGeometryAndApplyOptions` also always sets `gmsh.option.setNumber("Mesh.SaveAll",
1)`, unconditionally (parts or no parts). **This is required, not optional:** Gmsh's
own default (`Mesh.SaveAll = 0`) means `gmsh.write()` only serializes elements
belonging to *some* physical group once *any* physical group exists in the model —
so the instant a single part resolves a single entity, every other entity's elements
would silently vanish from `.msh`/`.geo_unrolled` output (confirmed: a model with
one part covering 1 of 15 surfaces wrote a `.msh` with exactly one entity block and
88 triangles, dropping the other 14 surfaces and the volume entirely). Physical
groups are meant to be an additional tag layered on top of a full mesh in this
feature, never a filter, hence the explicit override.

`gmshService.ts`'s `buildIndices` also uses the returned tag→part maps to bucket
generated triangles into contiguous per-part ranges (`MeshElementGroup[]` — see
[Protocol messages](#protocol-messages)) for the live overlay's per-part colouring,
scoping `getElements(dim, tag)` to one entity at a time instead of the original
single global call. For `dimension === 3`, this runs **per volume** (`getElements(3,
tag)` limits tets to that volume's own set before the tet-boundary-face-dedup
algorithm runs) — correct even for two touching part-volumes, since Gmsh tags each
tetrahedron by its single owning volume regardless of geometric adjacency, so a
face shared between two touching volumes is independently each volume's own
boundary.

**Known asymmetry, confirmed against the live WASM (`examples/STP/angle1.stp`, a
single-solid model with one volume-scoped part and one surface-scoped part):** a
part assigned by **surface** (not volume) still gets its own `Physical Surface` in
`.msh`/`.geo_unrolled` output correctly — but for a **3D** (`dimension === 3`)
generate, it will **not** get its own colour range in the live overlay, because
`buildIndices3D` only groups by `volumeTagToPart` (a tet-boundary triangle's group
comes from which *volume* the owning tetrahedron belongs to — Gmsh's 3D mesh
doesn't retain a "this boundary triangle's parent B-rep surface" link the way a 2D
surface mesh's elements do). A surface-scoped part's triangles fall into the
trailing default-blue range in 3D mode. This is not a bug in the correlation or
physical-group logic — both work correctly — it's a deliberate scope limit of the
overlay-colouring bucketing specifically. **2D** (`dimension === 2`) generates are
unaffected: `buildIndices2D` groups directly by `surfaceTagToPart` via
`getElements(2, tag)` per surface, so a surface-scoped part colours correctly there.
If overlay colouring for surface-scoped parts in 3D mode is ever needed, it would
require also reading the intermediate 2D surface mesh Gmsh generates as part of a
3D run (`getElements(2, tag)` is still populated even when `Mesh.dimension === 3`)
and cross-referencing triangle node-tag sets against the tet-boundary triangles —
not attempted here to keep the initial implementation's risk surface smaller.

## Per-part mesh size

A part can carry an optional `meshSize?: number` (a single target element size, not
a min/max range) — set via the Parts panel's per-row numeric field or, equivalently,
via the FE Mesh panel's mirrored "Part sizes" section (both edit the same
`Part.meshSize` through the same `PartsModel`; blank = inherit the global size).
For every part
with `meshSize` set and at least one resolved entity, `applyPartsToGmshModel`
creates a Gmsh **`Constant` field** (`gmsh.model.mesh.field.add("Constant")`)
scoped to that part's resolved entities via `PointsList`/`CurvesList`/
`SurfacesList`/`VolumesList` (`setNumbers`) with `VIn` (`setNumber`) set to the
part's `meshSize`. All parts' Constant fields are then combined via a `Min` field
(`FieldsList` = every Constant field's tag) and set as the background mesh
(`setAsBackgroundMesh`) — so the smallest requested size wins in any overlap, and
regions outside every sized part keep the global `Mesh.MeshSizeMin/Max` sizing
unaffected (Gmsh's own semantics: those remain clamps on the background field's
output). This mechanism is implemented per the standard Gmsh Field API (documented
in the Gmsh reference manual, not this WASM build specifically) and has been
exercised end-to-end against the live WASM (`examples/STP/angle1.stp`, dimension 2
and 3, one part with `meshSize: 0.5`): the sized part's own region refines as
expected, and every other surface/volume in the model still meshes fully — the
`Constant` field's un-set `VOut` (Gmsh's own default, `1e22`) only sizes the field's
*own* output outside the part's entities, it does not blank out or fail to mesh
unrelated entities, which was the failure mode worth specifically ruling out here.

**STL/mesh-format sources get a narrower degrade, not the full mechanism above:**
since there is no per-entity correlation for STL input, `src/meshOptions.ts`'s
`applyStlPartSizeOverride` checks whether *exactly one* part in the document has
`meshSize` set; if so, that value overrides `sizeMin`/`sizeMax` globally for that
one generate/export call (never persisted to `<model>.mesh.json`). Zero or more
than one part with `meshSize` set is ambiguous — which part's size should win for a
single merged STL volume? — so it silently falls back to the panel's own options,
unchanged.

## Options, sidecars, and the `.geo` script

The mesh generation options are a single flat, vscode-free, unit-tested bag defined
in `src/meshOptions.ts`:

```typescript
export interface MeshOptions {
  dimension: 1 | 2 | 3;
  sizeMin: number;
  sizeMax: number;
  algorithm2D: number; // Mesh.Algorithm
  algorithm3D: number; // Mesh.Algorithm3D
  elementOrder: 1 | 2;
  elementShape: "simplex" | "subdivided"; // triangles/tets vs quads/hexes
  optimize: boolean;
  stlAngle: number; // classifySurfaces angle, degrees
}
```

`validateMeshOptions` is the single tolerance gate: an individually invalid field
(wrong type, out-of-range, or `sizeMin > sizeMax`) falls back to
`DEFAULT_MESH_OPTIONS` for that field alone, rather than rejecting the whole
options object — the same graceful-degradation philosophy `EditOp`/`Part` sidecars
use elsewhere in this codebase.

**`sizeMax` defaults to the `1e22` "unbounded" sentinel (`SIZE_MAX_SENTINEL`), and
the webview seeds a real default over it.** Once a model's bounding box is known,
`syncMeshSizeSeed()` (`src/webview/main.ts`) replaces a still-sentinel `sizeMax`
with `diagonal / 20` (`defaultTargetSize` in `src/webview/meshSizeHeuristics.ts`) —
via `MeshingModel.load()`, which does **not** fire `onChange`, so merely opening a
file never posts `meshingChanged` and never creates `.mesh.json`/`.geo` sidecars;
the seeded value only persists after a real user change. A persisted user-set
`sizeMax` (≠ sentinel) always wins over the seed. The panel never displays the raw
`1e+22`: the Advanced "Size max" field shows an empty `auto` placeholder and the
slider stays disabled until the seed resolves.

**The panel's primary size control is a coarser→finer slider** driving `sizeMax`,
log-scaled between `diagonal / 5` (coarsest) and `diagonal / 200` (finest), with
Coarse/Medium/Fine presets at `diagonal / {10, 20, 50}`. Its readout shows the size
plus an element-count estimate, and estimates above ~1M elements raise an inline
warning before Generate. All of that math lives in the pure, headless-tested
`src/webview/meshSizeHeuristics.ts` — plain-number JS computed from the bounding
box only (`estimateElementCount` is an order-of-magnitude heuristic that knowingly
overestimates non-boxy models), **never a gmsh/WASM call**, so rendering the panel
keeps the lazy-WASM-init invariant intact. Slider/preset commits that would drop
`sizeMax` below the current `sizeMin` reset `sizeMin` to 0 in the same patch, so
`validateMeshOptions`' pair rule can't silently revert both on reload.

Two files persist beside the source model, both generated by `src/meshOptionsStore.ts`
(the `vscode.workspace.fs` I/O layer over the pure `src/meshOptionsSidecar.ts`
parse/serialize functions):

- **`<model>.mesh.json`** — the `MeshOptions` the panel was last set to, autosaved
  ~500 ms after each change (`meshingChanged`, on its own debounce timer, separate
  from parts/edits). Read back on `ready` and used to hydrate the panel
  (`meshingOptions` message).
- **`<model>.geo`** — an editable Gmsh script generated from the same options by
  `generateGeoScript` (`src/meshOptionsSidecar.ts`), written on the same debounce.
  It merges the source file and sets one `Mesh.*` option per `MeshOptions` field:

  ```
  Merge "model.stp";
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

  **This is a one-way generation.** See [Known limitations](#known-limitations) below
  — `<model>.geo` is never parsed back by the extension.

## Protocol messages

Six message types were added to `src/protocol.ts` for this feature (see
[Host ↔ Webview Protocol](protocol.md) for the full message catalogue):

| Message | Direction | Purpose |
|---------|-----------|---------|
| `meshingOptions` | host → webview | Hydrates the panel with the sidecar's (or default) `MeshOptions` on load. |
| `meshingResult` | host → webview | Encoded boundary triangulation (`positions`/`indices`, base64) plus `nodeCount`/`elementCount` stats and `elementGroups` (`MeshElementGroup[]` — per-part contiguous triangle ranges, from physical-group resolution; see [Parts → physical groups](#parts--physical-groups-b-rep-only)) after a successful generate. |
| `meshingError` | host → webview | A human-readable failure message (bad geometry, GMSH exception, missing STL data) rendered in the panel's status line. |
| `meshingChanged` | webview → host | A `MeshOptions` patch to persist (`<model>.mesh.json` + `<model>.geo`). |
| `meshingGenerate` | webview → host | Request to run `generateMesh` now; carries the current options and, for mesh-format documents, a base64 `stl` snapshot. |
| `meshingExport` | webview → host | Request to write the mesh (or, for `"geoUnrolled"`, the unrolled geometry; or, for `"mdpaElements"`/`"mdpaGeometries"`, hand-serialized Kratos MDPA — see [Export formats](#export-formats)) to disk in the format picked in the panel's export `<select>`, via a save dialog; `target` is a `MeshExportFormatId`, same options/`stl` payload as `meshingGenerate`. |

## Export formats

The FE Mesh panel's export `<select>` is populated from `MESH_EXPORT_FORMATS`
in `src/meshExportFormats.ts` — a single, vscode-free registry (`{id, label,
extension, filterLabel}[]`) imported by both the host (`gmshService.ts`/
`provider.ts`, to pick the MEMFS write extension and the save-dialog filter)
and the webview (`meshingPanel.ts`, to build the `<option>` list), the same
"shared, kernel-agnostic" convention `meshOptions.ts` already established. This
replaces the original one-button-per-format design (`📤 .msh`, `📤 .geo`) —
that pattern doesn't scale once more than two or three Gmsh output formats are
offered.

`gmsh.write(fileName)` dispatches purely by the output path's extension; the
registry's `extension` field doubles as both the MEMFS write extension (which
Gmsh writer gets selected) and the save-dialog's default extension/filter.
Since neither `gmsh.d.ts` nor the package README enumerate which formats a
given WASM build actually supports, the full set Gmsh's writer-dispatch table
recognizes was probed directly against the live `gmsh-core.wasm`
(`gmsh.write("/out.<ext>")` for every extension in Gmsh's own `Mesh.Format`
option-string enumeration, found via a `strings` scan of the `.wasm` binary):

| Result | Formats |
|---|---|
| Works | `msh` (v4.1, default), `msh2` (legacy v2.2 — selected purely by writing to a `.msh2` path, no `Mesh.MshFileVersion` option needed), `geo_unrolled` (existing, XAO-companion caveat below), `vtk`, `unv` (I-DEAS Universal), `inp` (Abaqus), `bdf`/`nas` (Nastran Bulk Data — same writer, only `bdf` is registered), `su2`, `mesh` (INRIA Medit), `stl`, `diff` (Diffpack), `off`, plus a few registered but not offered in the UI as redundant/niche for FE/CFD interchange: `ply2`, `wrl`, `x3d`, `dat`, `m`/`matlab`, `ir3`, `celum` |
| Compiled out | `cgns`, `med` — both extension-recognized (Gmsh's dispatch code path exists) but throw `"This version of Gmsh was compiled without CGNS support"` / `"Gmsh must be compiled with MED support to write '...'"`; both formats need HDF5-backed libraries (`libCGNS`, `libMED`) this WASM build doesn't statically link. Rebuilding `@loumalouomega/gmsh-wasm` with those libs linked in is the "fix Gmsh itself" path — not attempted; instead CAD-Preview bridges through a **second, independent** WASM module for these (and adds `xdmf`, which Gmsh's own writer table doesn't even recognize as an extension) — see "The meshio++ bridge" below. |
| Unusable for this pipeline | `p3d`, `neu` — wrote 0 bytes for a tri/tet mesh (structured-grid/quad-oriented formats); `vtk_bin`, `tochnog`, `matlab` (as a bare unrecognized extension distinct from `.m`) — not recognized as output extensions at all in this build. |

All working text formats are read back via `gmsh.FS.readFile(path, {
encoding: "utf8" })` and written UTF-8 as-is — none of the offered formats
produced binary output in this build (Gmsh defaults to ASCII output unless
`Mesh.Binary` is explicitly set, which this pipeline never does).
`src/gmshService.ts`'s `exportMeshFormat()` is the generic writer for every
format except `"msh"` (which reuses `generateMesh`'s `mshText` side product),
`"geoUnrolled"` (which has its own XAO-companion handling, see above), and
`"mdpaElements"`/`"mdpaGeometries"` (hand-serialized, see below — never a
`gmsh.write()` call at all) — a thin `loadGeometryAndApplyOptions` →
`mesh.generate(options.dimension)` → `gmsh.write("/out.<extension>")` →
read-back-as-text, since none of the remaining formats need anything beyond a
generated mesh.

### Kratos MDPA (hand-written, not a `gmsh.write()` format)

[Kratos Multiphysics](https://github.com/KratosMultiphysics/Kratos)' `.mdpa`
format is not one of the formats in the probe table above — Gmsh has no MDPA
writer at all, so it can't be reached through `exportMeshFormat()`. It's
serialized entirely by hand: `src/mdpaWriter.ts` (pure, vscode/WASM-free, unit
tests in `mdpaWriter.test.ts`) builds the ASCII text from a plain `MdpaMesh`
(`{nodes, tets, triangles, groups}`); `src/gmshService.ts`'s `exportMdpa()` +
private `extractMdpaMesh()` pull that data off the live gmsh model after
`mesh.generate()` (via `getNodes()`/per-entity-tag `getElements(dim, tag)`
loops, the same pattern `extractBoundaryFaces`/`appendTriangles2D` already use
for the display triangulation) and hand it to `writeMdpa()`. No MEMFS
write/read-back round trip exists for this format.

Two mutually exclusive modes, each its own registry entry rather than a
sub-toggle (`mdpaElements`/`mdpaGeometries` in `meshExportFormats.ts`,
deliberately listed **first** so `mdpaElements` is the default-selected export
format):

- **`mdpaElements` ("Elements + Conditions")** — the solver-ready shape.
  Volume cells → `Begin Elements <ElementName>`, surface cells → `Begin Conditions <ConditionName>`,
  both `<id> <prop_id> <n1> ... <nk>` with `prop_id` always `0` under a single
  `Begin Properties 0` block — this codebase has no material/property data of
  any kind, so there's never a second property id to reference.
- **`mdpaGeometries` ("Geometries")** — volume cells → `Begin Geometries <GeometryName>`,
  surface cells → `Begin Geometries <GeometryName>`, `<id> <n1> ... <nk>` with
  **no property id** (the structural difference from the other mode) and no
  `Properties` block. Kratos's `Geometries` is a single container, so **all**
  kinds **share one id space** — volume kinds get `1..V`, surface kinds
  continue `V+1..V+S`, not restarting at 1.

**Supported cell kinds** (linear + quadratic), each mapped by the shared
`gmshElementTypes.ts` table to its Kratos block name and gmsh→Kratos node
permutation:

| family | linear (geometry / element·condition) | quadratic |
|---|---|---|
| tetrahedron | `Tetrahedra3D4` / `Element3D4N` | `Tetrahedra3D10` / `Element3D10N` |
| hexahedron | `Hexahedra3D8` / `Element3D8N` | `Hexahedra3D27` / `Element3D27N` |
| prism | `Prism3D6` / `Element3D6N` | `Prism3D15` / `Element3D15N` |
| pyramid | `Pyramid3D5` / `Element3D5N` | `Pyramid3D13` / `Element3D13N` |
| triangle | `Triangle3D3` / `SurfaceCondition3D3N` | `Triangle3D6` / `SurfaceCondition3D6N` |
| quadrilateral | `Quadrilateral3D4` / `SurfaceCondition3D4N` | `Quadrilateral3D9` / `SurfaceCondition3D9N` |

The **geometry** names are certain; the **element/condition** names for the
newer kinds (everything but `Element3D4N`/`SurfaceCondition3D3N`) are best-effort
transcriptions from Kratos's registered types and still want a Kratos-core-dev
confirmation. Until then, `"elements"` mode runs a pre-flight that throws an
actionable *"export in Geometries mode instead"* error if the generated mesh
contains a kind whose element/condition name is unset — `"geometries"` mode is
always safe. (In the current table every name is filled in, so the guard only
fires if a name is later reset to `null` pending review.)

A complete order-2 **prism** (gmsh PRI18, 18 nodes) and **pyramid** (PYR14, 14)
are **truncated** to Kratos's `Prism3D15` / `Pyramid3D13` — verified against the
live WASM that PRI18's first 15 / PYR14's first 13 reference-node coordinates
coincide with the shorter element's, so dropping the extra face nodes is exact.
The dropped nodes remain in `Begin Nodes` (possibly unreferenced). This only
matters for a hex-dominant order-2 mesh, which this WASM build can't produce
anyway (see Known limitations).

Both a kind's root block and its `SubModelPart*` sub-block are **omitted when
empty** — never an empty `Begin`/`End` pair. A genuinely unmapped element type
throws an actionable error in `extractMdpaMesh()` (defensive backstop).

**Node ordering.** The gmsh→Kratos node permutation for every kind was
**derived by coordinate-matching** `getElementProperties().localNodeCoord`
against transcribed Kratos reference-element local coordinates (linear cells,
`tri6`, and `quad9` are identity; `tet10`, `hex20`, `hex27`, `prism15`,
`pyramid13` are non-trivial). Applied during extraction so `mdpaWriter.ts`
always receives Kratos-ordered nodes. As a defensive backstop, `orientCell()`
recomputes each cell's signed volume (divergence theorem over the kind's
outward boundary faces) and, for a negative tetrahedron, applies the
well-defined `tet4`/`tet10` re-orientation swap; a negative hex/prism/pyramid
(which gmsh shouldn't emit) is passed through unchanged with an `onWarning`
callback rather than an unsafe reshuffle.

**SubModelParts** map 1:1 to `Part[]` (B-rep sources only — mesh/STL
documents get `parts: []` before reaching `gmshService.ts`, same as every
other parts-preservation feature, so their MDPA export has root blocks only,
no SubModelParts). `Part[]` has no nesting concept anywhere in this codebase,
so SubModelParts are always flat — one top-level `Begin SubModelPart <name>`
per part, never nested. `extractMdpaMesh()`'s private `groupPartsAcrossDims()`
(the 4-map generalization of `buildIndices`'s existing `groupTagsByPart`)
reuses `PartGroupMaps` from `applyPartsToGmshModel` — already computed as a
side effect of `loadGeometryAndApplyOptions`, never recomputed — to bucket
each part's tets/triangles by owning volume/surface tag, plus resolve its
`lines`/`points` selections to extra node ids via `getNodes(1, curveTag,
/*includeBoundary*/ true)`/`getNodes(0, pointTag)` (a part's edges/points
contribute *only* to `SubModelPartNodes`, never their own element/condition/
geometry entries — this exporter's cell scope is strictly linear tets and
triangles). Each SubModelPart's `SubModelPartNodes` is the **union** of those
explicit selections and every node its grouped cells reference — never just
the explicit selection, so a reader never needs to backfill implied nodes.
SubModelPart names are sanitized (anything but `[A-Za-z0-9_]` → `_`, a
non-letter/underscore start gets a `Part_` prefix) and de-duplicated among
siblings with a `_2`, `_3`, … suffix. Output is fully deterministic: node ids
are assigned by sorting on source tag ascending, and element/condition/
geometry ids by sorting each cell's own (already-renumbered) node-id tuple
ascending — byte-identical output for the same geometry regardless of gmsh's
internal (not contractually stable) enumeration order. Node coordinates are
always written in scientific notation (`x.toExponential()`, e.g. `8e+0`,
`9.769962616701e-14`) rather than plain decimal, at full round-trip precision
(no fixed digit count — exactly as many digits as the double needs).

Verified end-to-end against the live WASM build on `examples/STP/angle1.stp`
with a 2-part `Part[]` (one volume-scoped, one surface-scoped): 1899 tets /
988 boundary triangles generated; the volume-scoped SubModelPart's
`SubModelPartElements` claimed all 1899 tets and none of the conditions; the
surface-scoped one claimed the matching triangles and none of the elements;
every connectivity line had the expected column count with no node id
outside `[1, nodeCount]`; Mode B's triangle geometry ids all came out strictly
after its tet geometry ids (confirming the shared id space).

Re-verified end-to-end after the element-shape/order extension, on
`angle1.stp` across all four `{simplex, subdivided} × {order 1, 2}` combos
(`Mesh.Algorithm3D=1`): every combo produced a **watertight** overlay (zero
odd boundary edges — `simplex` → tet4/tri3 & tet10/tri6, `subdivided` →
hex8/quad4 & hex27/quad9), no `orientCell` warnings, no negative tets, and
both MDPA modes emitted every expected block name with all connectivity ids in
range. Corner-only overlay display makes the boundary-triangle count identical
between order 1 and order 2 of the same shape.

### The meshio++ bridge (MED, CGNS, XDMF — not `gmsh.write()` formats either)

Like MDPA above, MED/CGNS/XDMF export never calls `gmsh.write()` — but unlike
MDPA, they're not hand-serialized either. `src/meshioService.ts`'s
`exportViaMeshio()` re-encodes an already-generated mesh through a **second,
independent** WASM module, [`@meshioplusplus/wasm`](https://github.com/loumalouomega/meshioplusplus)
(MIT-licensed; see the README's Licensing section), which this gmsh-wasm build
simply doesn't have writers for at all.

**Bridge mechanics.** `generateMesh()`'s own `mshText` (modern MSH 4.1,
Gmsh's default output version) is handed straight to `exportViaMeshio()`,
which writes those bytes into meshio++'s own MEMFS and calls its
`convert()`/`readMesh()`+`writeMesh()` (see below), bridging the two
modules' independent virtual filesystems via a plain buffer round trip — no
browser, no shared memory.

**MSH 4.1 input requires `@meshioplusplus/wasm` ≥ 9.7.0 — before that, the
bridge needed a legacy MSH 2.2 detour (kept here as the historical record,
per this doc's convention).** Against 9.4.1, feeding MSH 4.1 text into
meshio++'s `convert(..., {inFormat: "gmsh"})` threw
`"Gmsh $Entities not supported by the C++ reader"` immediately — that
build's C++ Gmsh reader only understood the older MSH 2.2 schema, so the
bridge routed through `exportMeshFormat(..., "msh2")` first. 9.7.0 parses
`$Entities` natively (ascii and binary), and — the genuinely valuable part —
resolves **physical-group membership** from it: a 4.1 read now yields named
`regions` (one per physical group, i.e. one per CAD-Preview part), which the
2.2 path never produced (re-verified: a 2.2 read of the same mesh yields no
regions — `$PhysicalNames` alone isn't enough; 4.1's `$Entities` is where
membership lives). The bridge input was switched back to `generateMesh()`'s
own 4.1 `mshText` accordingly, dropping the extra `gmsh.write()` round trip.

**MED still needs a MED-specific two-step, re-verified against the live
9.7.0 WASM — but it's now group-PRESERVING, where the 9.4.1-era workaround
was group-dropping.** Two independent obstacles remain on the direct
`convert(..., {outFormat: "med"})` path:
1. It still throws `"MED: gmsh physical groups handled by Python fallback"`
   whenever `cell_data` carries gmsh's own `"gmsh:physical"`/
   `"gmsh:geometrical"` tags, which `readMesh(..., "gmsh")` **always**
   attaches to a gmsh-sourced mesh (this meshio++ build's MED writer defers
   that case to Python, unavailable in WASM).
2. MED separately rejects MSH 4.1's natural one-block-per-*entity* cell
   layout with `"MED files cannot have two sections of the same cell type"`
   (a meshed unit box arrives as 27 blocks: 8 vertex + 12 line + 6 triangle
   + 1 tetra).
The fix for both at once: `readMesh()` the 4.1 text, run the result through
**`merge([mesh])`** — meshio++'s own merge consolidates same-type cell
blocks into one (MED's requirement) *and* remaps every named region's
block-major cell indices onto the merged layout (verified: region entry
counts survive exactly) — then hand-build a **brand-new plain JS object**
containing only `{points, dim, cells, regions}` (no `cell_data`/
`point_data`/`field_data` key at all — dropping them is what dodges obstacle
1; scalar field data is a theoretical loss only, this pipeline's generated
meshes never carry any) and `writeMesh()` **that** to MED. meshio++ 9.6.0's
MED writer synthesizes MED families from the regions, so **parts/physical
groups now round-trip into MED as named groups** — verified end-to-end: a
box with `MyVolume`/`MySurface` physical groups wrote a MED whose read-back
listed both regions with identical entry counts (90 surface triangles, 1101
tets). Under 9.4.1 this path silently dropped all groups. CGNS/XDMF/VTK need
none of this; plain `convert()` works directly on the 4.1 text.

**CGNS has one more, narrower limitation — verified on 9.4.1 and
RE-verified unchanged on 9.7.0**: exporting a **pure-surface** mesh
(triangle/quad only, no volume cells — i.e. every 2D-dimension FE-mesh
generate) produces a CGNS file this same WASM build's own reader can't read
back (`"HDF5: missing dataset ' data'"`). Confirmed via a controlled pair of
probes: a volume (tet) mesh round-trips through `convert()`+`readMesh()`
correctly; a triangle-only mesh fails on read-back with that exact error.
MED and XDMF have **no** such gap (verified: both round-trip a pure-surface
mesh correctly). CAD-Preview still writes the CGNS file in this case (the
failure is on *read*, not *write*, and `exportViaMeshio()` never reads its
own output back) — a 2D-dimension CGNS export may therefore produce a file
some *other* downstream CGNS reader also rejects; there is no
CAD-Preview-side workaround for this one. (All three remaining upstream
gaps — the MED Python-fallback trip, the MED same-type-blocks rejection,
and this CGNS read-back failure — are written up with exact reproductions
in a ready-to-run prompt at the meshio++ repo:
`PROMPT_close_wasm_gmsh_bridge_gaps.md`.)

**XDMF writes an HDF5 companion file**, confirmed against the live WASM:
`convert(..., "/out.xdmf", ...)` also writes `/out.h5` (same MEMFS basename,
swapped extension) and the `.xdmf` XML's `<DataItem Format="HDF">` elements
reference it by that bare filename (e.g. `out.h5:/data0`). `exportViaMeshio()`
returns `bytes`/`companion` separately so the caller can write both under the
*user-chosen save filename's* basename and rewrite the embedded reference to
match — `provider.ts`'s `meshingExport` handler (and `mcpTools.ts`'s
`exportMeshTool`) do this the same way they already rewrite `.geo_unrolled`'s
`Merge "...xao"` stub for B-rep sources.

**Loading order / packaging.** `@meshioplusplus/wasm` is ESM-only with no
`require` condition at all (unlike gmsh-wasm, which is dual CJS/ESM) —
`meshioService.ts` loads it via a dynamic `await import(...)`, not a static
top-of-file import, and it must stay `external` in `esbuild.mjs` for that
reason (plus the same eager-pthread-worker-spawn risk gmsh-wasm's own comment
documents, if it were ever bundled). It's always loaded with
`{ variant: "seq" }` explicitly — **never** `"auto"`, since the package's own
`resolveVariant()` picks the threaded build whenever
`typeof crossOriginIsolated === "undefined"`, which is unconditionally true
under Node, so `"auto"` would always pick the eager-worker-spawning threaded
build here. `.vscodeignore` carves out only the sequential variant's four
files (`package.json`, `src/index.mjs`, `dist/meshioplusplus_wasm.mjs`,
`dist/meshioplusplus_wasm.wasm`) — the threaded variant's files are dead
weight given `"seq"` is always forced.

**Same module also powers document import** for VTK/VTU/MED/CGNS/Exodus/
XDMF/MDPA — see `doc/getting-started.md`'s Supported Formats note and
`meshioService.ts`'s `convertToStlBoundary()` (the reverse direction:
source file → STL boundary surface, via `convertSurface` rather than
`convert`, so multi-component data survives inside meshio++'s C++ core for
as long as it's there — though the STL output format itself still can't
carry it out).

**Verified end-to-end against the live WASM build** via `npm run mcp:smoke`:
a hand-built tetrahedron `.vtk` file is loaded (`load_model` routes it
through meshio, reports it as headlessly meshable — unlike `.obj`/`.ply`/
`.gltf`, which aren't), meshed (`generate_mesh`, real node/element counts),
and exported to MED, CGNS (3D, since the 2D limitation above doesn't apply),
and XDMF (confirming the `.h5` companion is written and its embedded
reference correctly rewritten to the chosen output filename) — all through
the real `dist/mcp-server.js` process, not a mocked pipeline.

## Webview: panel, model, and overlay display

- **`src/webview/meshingModel.ts`** (`MeshingModel`) — a DOM-free store for the
  current `MeshOptions`, mirroring `EditsModel`/`PartsModel`'s pattern but simpler:
  since options are a flat bag rather than a list, there is no undo/redo, just
  `load()` (hydrate without firing `onChange`, used for the initial host→webview
  sync) and `update()` (patch + fire `onChange`, used for user edits).
- **`src/webview/meshingPanel.ts`** (`MeshingPanel`) — the DOM, top to bottom:
  a large-mesh warning strip (`#meshing-warning`, shown when the element-count
  estimate exceeds ~1M); the primary size control (Coarse/Medium/Fine preset
  buttons, the coarser→finer slider, and a `Size: X · ~N elements` readout —
  the slider refreshes the readout locally on `input` and only commits the new
  `sizeMax` on `change`/release, so dragging never spams `meshingChanged`
  messages); a "Part sizes" section (`renderParts(parts)`, hidden while no
  parts exist) mirroring the Parts panel's per-part `meshSize` inputs; and a
  collapsed-by-default "Advanced settings" section holding the raw options form
  (dimension, size min/max, 2D/3D algorithm dropdowns, element order, optimize
  checkbox, and the STL angle field — disabled for B-rep documents via
  `setSourceKind`, mirroring `editsPanel.setBRepOnly`). Plus a Generate button,
  an export-format `<select>` (populated from `MESH_EXPORT_FORMATS`, see
  [Export formats](#export-formats) above) with a single Export button, a Clear
  button, and a status line that shows either `Nodes: N · Elements: M · 3.2 s`
  (the time is `meshingResult.elapsedMs`, measured host-side around the
  generate call) or an error string. Pure DOM, no business logic (all size
  math delegates to `meshSizeHeuristics.ts`), no `prompt()`/`alert()` (VS Code
  webviews block those — same constraint documented for the Parts/Edits
  panels).
- **`src/webview/meshSizeHeuristics.ts`** — the pure math behind the size
  control: bbox-derived default size, log-scale slider↔size mapping, preset
  divisors, and the order-of-magnitude element-count estimate (see
  [Options, sidecars, and the `.geo` script](#options-sidecars-and-the-geo-script)
  above). Plain numbers in/out — vscode-free, THREE-free, gmsh-free — and
  unit-tested headless. The panel gets the bounding box it needs via
  `Viewer.getModelExtents()`, pushed in by `main.ts` on each model load
  (`setModelExtents`).
- **`src/webview/geometryBuilder.ts`**'s `buildFEMesh(positionsB64, indicesB64,
  edgesB64, elementGroups)` decodes the base64 buffers from a `meshingResult`
  message into a `THREE.Group` containing a shaded, multi-material
  `MeshBasicMaterial` mesh (unlit — see the code comment for why) plus a
  `LineSegments` wireframe, tagged `userData.entityType = "mesh"`. Each
  `elementGroups` entry becomes one `geometry.addGroup(indexStart, indexCount,
  materialIndex)` range and its own material — `part.color` for a resolved part,
  or the default blue `0x4ea1ff` for the trailing ungrouped range (or the single
  implicit range when `elementGroups` is empty, e.g. an STL source or a document
  with no parts) — so the overlay reads per-part just like the model's own faces
  do. **The wireframe is built from the host's `edges` buffer (true element edges),
  not `THREE.WireframeGeometry` of the triangulated fill** — otherwise a
  recombined hex mesh (quad faces split into 2 fill triangles) would show the
  quad-splitting diagonal and look identical to a tet mesh. `gmshElementTypes.ts`'s
  `boundaryEdges`/`surfaceEdges` emit only polygon perimeters (deduplicated), so
  hexes draw as quads and tets as triangles. It's unaffected by grouping and stays
  a single `LineBasicMaterial`.
- **`src/webview/viewer.ts`**'s `Viewer.setMeshOverlay(obj)` adds/replaces that
  group as a **sibling of `model`** in the scene (never a child) and disposes the
  previous overlay's geometries/materials before swapping — so toggling the FE
  Mesh overlay off leaves the original tessellated/loaded geometry completely
  untouched. It also toggles the model's shaded faces (`entityType ===
  "surface"`) invisible while an overlay is shown, and visible again once it's
  cleared — two overlapping opaque solids (the model's faces and the mesh
  overlay) are unreadable layered on top of each other; edges/points stay
  visible throughout as a feature-line reference. Display-only
  (`Object3D.visible`), never touches geometry.
- **`src/webview/main.ts`** wires the panel's callbacks to `post()` calls
  (`meshingChanged`/`meshingGenerate`/`meshingExport`), snapshots an STL via
  `currentStlIfMeshSource()` for mesh-source documents, and handles the
  `meshingOptions`/`meshingResult`/`meshingError` messages coming back from the
  host, calling `viewer.setMeshOverlay(buildFEMesh(...))` on a successful result
  and `meshingPanel.render(..., { error })` on failure. The toolbar's **🔬 FE Mesh**
  toggle (`meshingToggle`) shows/hides the panel and clears the overlay when
  switched off.
- **Generate feedback:** `onGenerate` calls `meshingPanel.setBusy(true)` before
  posting `meshingGenerate`, and the `meshingResult`/`meshingError` handlers call
  `setBusy(false)`. `setBusy` disables `#meshing-generate` (so the WASM call
  can't be re-triggered mid-flight) and shows an indeterminate progress bar
  (`#meshing-progress`, a CSS keyframe sweep) plus a `"Generating…"` status line —
  indeterminate because `gmsh.model.mesh.generate()` is one opaque blocking call
  with no progress hook to report a real percentage from (`GmshLogger` only
  offers post-hoc wall/CPU time, not a streaming callback). **📤 Export** (any
  format) is not wired to `setBusy`; its save-dialog flow already surfaces
  completion/failure via the generic toolbar status bar.

## Licensing

Bundling gmsh-wasm changes CAD-Preview's own license. See the README's
[Licensing](../README.md#licensing) section for the full statement; in short:

> Gmsh statically links (and is itself linked with) OpenCASCADE, Netgen, METIS, and
> ParaView into a single WASM binary, and is distributed under the
> **GPL-2.0-or-later** (with a linking exception covering those dependencies).
> Because CAD-Preview ships that compiled binary, **CAD-Preview itself is
> distributed under the GPL-2.0-or-later** — see [LICENSE](../LICENSE).

This is a strictly stronger copyleft than OCCT's own LGPL-2.1-with-exception (used
directly for the B-rep read/export pipeline via `opencascade.js`, and indirectly a
second time inside gmsh-wasm's bundled OCCT). The GPL obligation is triggered by
gmsh-wasm's presence in the extension bundle, not by whether a given user ever
opens the FE Mesh panel.

`@meshioplusplus/wasm` (the meshio++ bridge, see above) is **MIT**-licensed,
including its compiled `.wasm` binary — bundling it doesn't change
CAD-Preview's overall license (already GPL-2.0-or-later because of gmsh-wasm),
it's simply an additional MIT dependency alongside `@modelcontextprotocol/sdk`/
`zod`/`fflate`. See the README's Licensing section for the full attribution list.

## Known limitations

- **The meshio++ MED/CGNS export bridge has two narrow, verified gaps** — see
  "The meshio++ bridge" above for the full write-up: MED needs a
  strip-to-`{points,dim,cells}`-before-writing workaround (drops any point/
  cell scalar field data, which this pipeline's generated meshes never carry
  anyway); CGNS export of a pure-2D (surface-only) mesh produces a file this
  same WASM build's own reader can't read back (3D volume meshes are
  unaffected). Neither is a CAD-Preview bug to fix — both are confirmed
  limitations of the bundled `@meshioplusplus/wasm` build itself.

- **No working 3D recombination (hex-dominant meshing) in the bundled WASM build
  — TRUE for `@loumalouomega/gmsh-wasm` 0.2.x, SUPERSEDED in 0.3.0 (see the
  update below).** The all-hex `subdivided` shape works (via
  `Mesh.SubdivisionAlgorithm=2`), but a hex-*dominant* mixed mesh
  (tets+prisms+pyramids+hexes via `Mesh.Recombine3DAll`) was completely
  non-functional in 0.2.x: every variant probed at the time —
  `Recombine3DAll=1` alone, combined with `RecombineAll`, with
  `Recombine3DConformity`/`Recombine3DLevel`, under Delaunay or Frontal —
  produced **pure tetrahedra** (no recombination at all) or threw *"Cannot use
  frontal 3D algorithm with quadrangles on boundary"*. **That probing pass never
  tried `Mesh.Algorithm3D=9` (RTree)** — the specific algorithm Gmsh's hex-tet
  hybrid recombiner is gated behind (confirmed by re-probing, see below) — so the
  0.2.x "compiled without 3D recombination support" conclusion was itself
  incomplete, not just a since-fixed build limitation. So `elementShape` was
  restricted to `simplex`/`subdivided` and no hex-dominant option was offered
  (`validateMeshOptions` still rejects `"hexDominant"`, unchanged as of this
  writing — see `doc/roadmap.md`'s "Hex-dominant FE meshing" candidate for what
  adding it properly would need). The `gmshElementTypes.ts` table still carries
  prism/pyramid rows (their permutations are verified) so the pipeline is ready
  if this is ever implemented — they remain unreachable today, by choice, not by
  WASM limitation. `Mesh.Algorithm3D=10` (HXT) was also broken in 0.2.x (empty
  mesh) — see the update below, same root cause as the 3D Delaunay bug two
  bullets down.

  **Update, `@loumalouomega/gmsh-wasm` 0.3.0, verified against the live WASM on
  `examples/STP/block.stp`:** re-probing with `Mesh.Algorithm3D=9` (RTree) +
  `Mesh.Recombine3DAll=1` — the exact combination the 0.2.x pass never tried —
  now produces a genuine hex-dominant mesh: element types `[4, 5, 140]` (702
  tetrahedra, 165 hexahedra, 366 type-140 "trihedron" connector elements
  stitching the tet/hex interface), completing in 482ms with no error. Gmsh's
  own upstream framing (relayed via GMSH-JS's README/docs) still calls the
  RTree path "experimental" and recommends Delaunay/HXT for production meshes,
  and CAD-Preview does **not** currently expose it (no UI, no `elementShape`
  value) — but the underlying capability is confirmed present, changing this
  from a hard WASM-build non-goal to an unimplemented feature candidate. One
  concrete blocker for wiring it up cleanly: `gmsh.model.mesh.
  getElementProperties(140)` **throws** (`"Size of basis incompatible with
  element type"`) — the coordinate-matching method every other element kind's
  Kratos node permutation in `gmshElementTypes.ts` was derived from doesn't
  extend to the trihedron connector, so that element's geometry needs a
  different verification source before it could be added to the shared table
  with the same confidence every other row has. Also confirmed in this same
  0.3.0 re-probe: HXT (`Algorithm3D=10`) on the same OCC-imported geometry
  completed correctly (37ms, 1254 tets, no hang/empty-mesh) — see the 3D
  Delaunay bug entry below, which covers HXT's identical root cause and fix.

Per the original goal of this integration — flag anything GMSH-JS is missing so it
can be reported upstream — five real gaps were found while building this feature
(two of them only surfaced once parts-preserving meshing was exercised end-to-end,
after the rest of this doc had already been written and manually verified — see the
addendum at the end of this section), plus one explicit "everything else worked"
confirmation:

- **No direct `.geo` writer — only `.geo_unrolled`.** GMSH-JS exposes `gmsh.write()`,
  which can produce a `.geo_unrolled` file (Gmsh's fully-expanded, non-parametric
  script format) but has no API to emit a clean, hand-editable `.geo` script from
  in-memory model state. CAD-Preview works around this by templating its **own**
  `.geo` file directly from the `MeshOptions` JSON (`generateGeoScript` in
  `src/meshOptionsSidecar.ts`) rather than asking GMSH-JS to produce one. The
  practical, user-facing consequence: **hand-edits made to `<model>.geo` are never
  read back by the extension.** The file is regenerated wholesale from
  `<model>.mesh.json` on every options change, so any manual changes to the `.geo`
  text are silently overwritten on the next edit in the FE Mesh panel. The
  generated file says as much in its own header comment (`// Auto-generated by
  CAD-Preview. Edits here are not read back by the extension...`), but this is
  worth stating plainly here too: it is a one-way generation, not a round-trip.

- **`.geo_unrolled` output for OCC-imported (B-rep) geometry is a dangling
  reference, not standalone text — a companion XAO file must be bundled with it.**
  Confirmed against the live WASM: for every B-rep source (the STEP re-export every
  `.step`/`.iges`/`.brep` document goes through before `gmsh.model.occ.importShapes`),
  `gmsh.write("*.geo_unrolled")` does **not** inline the shape as native GEO
  primitives — OCC B-rep geometry has no general textual GEO representation. It
  instead writes a single-line stub:

  ```
  Merge "/out.geo_unrolled.xao";
  ```

  referencing a companion **XAO** file (Gmsh's own OCC-preserving exchange format —
  it round-trips shapes, physical groups, *and* mesh-size fields) that `gmsh.write()`
  additionally wrote to the same MEMFS directory as a side effect, under a path this
  code never originally read back. Saving only the `.geo_unrolled` text to disk
  therefore produced a file that pointed at a MEMFS-only path with no corresponding
  file on the user's disk — reopening it in real Gmsh would fail outright. Fixed:
  `gmshService.ts`'s `exportGeoUnrolled` now also reads back the `<outPath>.xao`
  MEMFS file (`null` if absent — the STL/GEO-kernel path has no such companion,
  since `addSurfaceLoop`/`addVolume` unroll to real inline Point/Curve/Surface/Volume
  commands) and returns `{ text, xao }`; `provider.ts`'s `meshingExport` "geo"
  branch writes the XAO bytes as a sibling of the user's chosen save path and
  rewrites the stub's `Merge` reference to that sibling's relative filename before
  writing the `.geo_unrolled` text itself, so the pair is self-contained and
  actually reopens. Verified end-to-end: reopening the rewritten pair in a fresh
  Gmsh model (`gmsh.open(...)`) restored the exact same volume/surface counts, the
  same physical groups, and — after re-running `mesh.generate()` — the exact same
  node count as the original generate that had a per-part sizing field active,
  confirming physical groups and mesh-size fields both survive the XAO round trip,
  not just the raw shape.

- **`Mesh.SaveAll` defaults to `0`, which silently drops every entity not in a
  physical group from `gmsh.write()` output the instant any physical group
  exists.** This is documented Gmsh behavior, not a WASM-build-specific gap, but it
  is an easy footgun for exactly this feature: once parts-preserving meshing started
  creating `gmsh.model.addPhysicalGroup(...)` calls, `.msh`/`.geo_unrolled` exports
  for a document with even one part assigning even one face silently stopped
  containing the rest of the model. Confirmed against the live WASM
  (`examples/STP/angle1.stp`, one part covering 1 of 15 surfaces): the written
  `.msh`'s `$Elements` section contained exactly one entity block (that surface's 88
  triangles) — the other 14 surfaces and the volume were entirely absent, while the
  **live** overlay (built from `getNodes()`/`getElements()` calls directly against
  Gmsh's in-memory model, not from re-reading the written file) was unaffected and
  showed the full, correct mesh, since those query APIs are not gated by
  `Mesh.SaveAll` — only `gmsh.write()` is. Fixed: `loadGeometryAndApplyOptions` now
  unconditionally sets `gmsh.option.setNumber("Mesh.SaveAll", 1)`, since physical
  groups in this feature are always meant to be an additional tag on top of a full
  mesh, never a filter. Verified: the same model's `.msh` now contains 92 entity
  blocks (the whole model) while still correctly listing the part in
  `$PhysicalNames`.

- **`gmsh.model.mesh.setSizeCallback` is unsupported in this WASM build.** Verified
  directly against the GMSH-JS source, not just the shipped `.d.ts`: the API
  definition (`generated/gmsh-api.json`) declares `setSizeCallback` with a
  `callback` argument of kind `isizefun` (a native function-pointer callback,
  invoked once per mesh vertex from inside the C++ meshing loop). The binding
  generator (`scripts/gen_js.py`) special-cases exactly this argument kind:

  ```python
  if kind in ("isizefun",):
      unsupported = True  # function-pointer callback: skip wrapper
  ```

  and functions marked `unsupported` are excluded both from the emitted JS
  wrapper and from the generated `.d.ts` (`if fn["unsupported"]: continue`) —
  which is exactly why `setSizeCallback` is entirely absent from
  `dist/gmsh.d.ts`, while its sibling `removeSizeCallback` (no callback argument)
  is present. The generated descriptor (`dist/gmsh-descriptor.mjs`) confirms this
  at the data level too: the `setSizeCallback` entry is the only one of the two
  with `"unsupported": true`. In short, this WASM build has no mechanism to
  marshal a JavaScript function into the native mesh-sizing callback — only
  declarative, field-based sizing (`Mesh.MeshSizeMin/Max`, background mesh size
  fields, etc.) is available. **This does not affect the current feature** —
  CAD-Preview's options panel only ever needs declarative sizing — but it would
  block any future adaptive or local (per-region, per-curvature) mesh sizing UI
  that wanted to compute sizes in JS on the fly.

- **The WASM build had a known 3D Delaunay boundary-recovery failure on
  re-imported CAD geometry — FIXED upstream in `@loumalouomega/gmsh-wasm`
  0.3.0; kept here as the historical record + verification trail, per this
  doc's convention of not deleting superseded findings.** Documented in
  GMSH-JS's own README under "Known issues" at the time: the default 3D
  algorithm (Delaunay) could fail boundary recovery — producing zero
  tetrahedra, or hanging — specifically for geometry that had round-tripped
  through STEP/IGES import in this Emscripten target. Since every B-rep
  source CAD-Preview meshes has, by definition, just been imported via
  `gmsh.model.occ.importShapes`, this failure mode was directly in the
  feature's hot path — not a corner case. That is why
  `DEFAULT_MESH_OPTIONS.algorithm3D` in `src/meshOptions.ts` was set to **`4`
  (Frontal)** instead of Gmsh's own default, matching the workaround
  GMSH-JS's README recommended at the time
  (`gmsh.option.setNumber('Mesh.Algorithm3D', 4)`).

  **Root cause and fix, per GMSH-JS's own 0.3.0 changelog/CLAUDE.md
  (`loumalouomega/GMSH-JS` commit `0cd8b24`):** not an algorithm-correctness
  bug at all — a wasm32 stack-overflow. Gmsh's tetgen-derived 3D boundary
  recovery (used by both the default Delaunay algorithm and HXT) recurses
  deeply; at `-O3` with no stack checks, overflowing Emscripten's 64 KiB
  default stack (shared by the main thread and every pthread) silently
  corrupted adjacent linear memory instead of trapping — surfacing as a hang
  or an empty mesh, reproducible even on small, non-degenerate geometry, not
  just pathological inputs. Fixed by raising
  `-sSTACK_SIZE=4MB`/`-sDEFAULT_PTHREAD_STACK_SIZE=2MB` in GMSH-JS's own
  `scripts/build-wasm.sh` — a real fix to the actual defect, not a
  CAD-Preview-side workaround.

  **Re-verified against the live 0.3.0 WASM** (`examples/STP/block.stp`, the
  exact `gmsh.model.occ.importShapes` re-import path CAD-Preview always
  uses): `Algorithm3D=1` (Delaunay) completed in 88ms producing 1282
  tetrahedra — no hang, no empty mesh; `Algorithm3D=10` (HXT, sharing the
  same tetgen-derived recursion and therefore the same bug/fix) completed in
  37ms producing 1254 tetrahedra. Both fully fixed, not merely improved.
  **`DEFAULT_MESH_OPTIONS.algorithm3D` was updated from `4` back to `1`**
  (Gmsh's own default) accordingly — existing documents are unaffected
  (they already have their own explicit value persisted in
  `<model>.mesh.json`; this only changes the seed for new documents that
  have never saved mesh options). Frontal (`4`) and HXT (`10`) both remain
  fully selectable from the 3D algorithm dropdown, and both still work
  correctly — there was never a reason to remove them, only to stop forcing
  one of them as the default.

- **Parts → physical groups + per-part sizing fields: verified working against
  the live WASM** (`examples/STP/angle1.stp`, one volume-scoped part with
  `meshSize: 0.5` and one surface-scoped part, `dimension: 3`): the standard Gmsh
  `Constant`/`Min` field option name strings (`PointsList`/`CurvesList`/
  `SurfacesList`/`VolumesList`/`VIn`/`FieldsList`), `addPhysicalGroup`, and the
  bbox-centre correlation (`bboxCenter` vs. `getBoundingBox`, tolerance `1e-3 ×
  model bbox diagonal`) all resolved correctly — a no-parts baseline generate
  produced 499 nodes, the identical geometry with the sized part produced 235,088
  nodes (clear, correctly-directed local refinement, not a silent no-op), and the
  resulting `.msh`'s `$PhysicalNames` section listed both parts by name at the
  right dimension (`3 1 "PartA"`, `2 2 "PartB"`). See the surface-scoped-part
  overlay-colouring caveat in [Parts → physical groups](#parts--physical-groups-b-rep-only)
  above for the one confirmed gap (3D-mode overlay colouring only, not physical
  groups or sizing) found during this same verification pass. **This pass only
  checked live query results (`getNodes`/`getElements`) and the `$PhysicalNames`
  section's presence — not whether the written `.msh`'s `$Elements` section
  actually contained every entity, or whether `.geo_unrolled` output was
  reopenable.** Those two additional, narrower checks are what caught the
  `Mesh.SaveAll` and XAO-companion gaps documented above; both are now fixed and
  covered by the end-to-end reopen-and-regenerate verification described there.

- **Everything else this feature needed is present and worked correctly.**
  `gmsh.model.occ.importShapes`, the STL remesh sequence
  (`merge`→`classifySurfaces`→`createGeometry`→`addSurfaceLoop`→`addVolume`→
  `synchronize`), `gmsh.model.mesh.generate`, and `getNodes`/`getElements` all
  behaved exactly as documented against the live WASM build, with no binding gaps
  beyond the five points above. Every one of those five was a real *default Gmsh
  option/output-format behavior* CAD-Preview had to account for (`Mesh.SaveAll`,
  the XAO-stub `.geo_unrolled` output, `setSizeCallback`, the 3D Delaunay
  boundary-recovery bug, and the templated-not-generated `.geo`) — not a missing
  or broken binding — so there is no other GMSH-JS functionality gap to report
  upstream for this feature beyond what's already listed.

  **Addendum:** that statement is scoped to GMSH-JS's own API surface, and it
  still stands — but it shouldn't be read as "the whole feature shipped bug-free
  on the first try." Four integration issues surfaced after initial
  implementation and were fixed, all in **CAD-Preview's own** bundling/
  integration code, not in GMSH-JS itself: (a) an esbuild ESM→CJS bundling quirk
  where gmsh-wasm's use of `import.meta.url` needed a `banner`+`define` shim to
  survive the CJS conversion (see `esbuild.mjs`); (b) an undocumented MEMFS
  path-length limit in the OCCT WASM build that affected `exportBRep()`'s
  generated temp file names (see `src/occtService.ts`); (c) the missing
  `Mesh.SaveAll` override that silently dropped non-part geometry from
  `.msh`/`.geo_unrolled` writes once any part existed; and (d) the unbundled XAO
  companion that left `.geo_unrolled` exports for B-rep sources pointing at a
  MEMFS-only path. (c) and (d) only surfaced once parts-preserving meshing was
  exercised against real multi-surface geometry with a resolved part — the
  earlier verification pass above predates that feature and didn't have physical
  groups active yet to trip either default.
