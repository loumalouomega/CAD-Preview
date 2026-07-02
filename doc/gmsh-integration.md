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
`Mesh.Algorithm3D`, `Mesh.ElementOrder`, `Mesh.Optimize`, all via
`gmsh.option.setNumber`), then `generateMesh` calls `gmsh.model.mesh.generate
(options.dimension)` and reads the result back with `gmsh.model.mesh.getNodes()` /
`gmsh.model.mesh.getElements()`.

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
a min/max range) — set via the Parts panel's per-row numeric field. For every part
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
  optimize: boolean;
  stlAngle: number; // classifySurfaces angle, degrees
}
```

`validateMeshOptions` is the single tolerance gate: an individually invalid field
(wrong type, out-of-range, or `sizeMin > sizeMax`) falls back to
`DEFAULT_MESH_OPTIONS` for that field alone, rather than rejecting the whole
options object — the same graceful-degradation philosophy `EditOp`/`Part` sidecars
use elsewhere in this codebase.

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
  Mesh.Algorithm3D = 4;
  Mesh.ElementOrder = 1;
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
| `meshingExport` | webview → host | Request to write the mesh (or, for `"geoUnrolled"`, the unrolled geometry) to disk in the format picked in the panel's export `<select>`, via a save dialog; `target` is a `MeshExportFormatId`, same options/`stl` payload as `meshingGenerate`. |

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
| Compiled out | `cgns`, `med` — both extension-recognized (Gmsh's dispatch code path exists) but throw `"This version of Gmsh was compiled without CGNS support"` / `"Gmsh must be compiled with MED support to write '...'"`; both formats need HDF5-backed libraries (`libCGNS`, `libMED`) this WASM build doesn't statically link. Not a CAD-Preview limitation — would need `@loumalouomega/gmsh-wasm` rebuilt with those libs linked in. |
| Unusable for this pipeline | `p3d`, `neu` — wrote 0 bytes for a tri/tet mesh (structured-grid/quad-oriented formats); `vtk_bin`, `tochnog`, `matlab` (as a bare unrecognized extension distinct from `.m`) — not recognized as output extensions at all in this build. |

All working text formats are read back via `gmsh.FS.readFile(path, {
encoding: "utf8" })` and written UTF-8 as-is — none of the offered formats
produced binary output in this build (Gmsh defaults to ASCII output unless
`Mesh.Binary` is explicitly set, which this pipeline never does).
`src/gmshService.ts`'s `exportMeshFormat()` is the generic writer for every
format except `"msh"` (which reuses `generateMesh`'s `mshText` side product)
and `"geoUnrolled"` (which has its own XAO-companion handling, see above) — a
thin `loadGeometryAndApplyOptions` → `mesh.generate(options.dimension)` →
`gmsh.write("/out.<extension>")` → read-back-as-text, since none of these
formats need anything beyond a generated mesh.

## Webview: panel, model, and overlay display

- **`src/webview/meshingModel.ts`** (`MeshingModel`) — a DOM-free store for the
  current `MeshOptions`, mirroring `EditsModel`/`PartsModel`'s pattern but simpler:
  since options are a flat bag rather than a list, there is no undo/redo, just
  `load()` (hydrate without firing `onChange`, used for the initial host→webview
  sync) and `update()` (patch + fire `onChange`, used for user edits).
- **`src/webview/meshingPanel.ts`** (`MeshingPanel`) — the DOM: a form
  (dimension, size min/max, 2D/3D algorithm dropdowns, element order, optimize
  checkbox) plus a Generate button, an export-format `<select>` (populated from
  `MESH_EXPORT_FORMATS`, see [Export formats](#export-formats) above) with a
  single Export button, a Clear button, and a status line that shows either
  `Nodes: N · Elements: M` or an error string. Pure DOM, no business logic, no
  `prompt()`/`alert()` (VS Code webviews block those — same constraint
  documented for the Parts/Edits panels).
- **`src/webview/geometryBuilder.ts`**'s `buildFEMesh(positionsB64, indicesB64,
  elementGroups)` decodes the base64 buffers from a `meshingResult` message into a
  `THREE.Group` containing a shaded, multi-material `MeshBasicMaterial` mesh
  (unlit — see the code comment for why) plus a `WireframeGeometry` overlay of the
  same triangulation, tagged `userData.entityType = "mesh"`. Each `elementGroups`
  entry becomes one `geometry.addGroup(indexStart, indexCount, materialIndex)`
  range and its own material — `part.color` for a resolved part, or the default
  blue `0x4ea1ff` for the trailing ungrouped range (or the single implicit range
  when `elementGroups` is empty, e.g. an STL source or a document with no parts) —
  so the overlay reads per-part just like the model's own faces do. The wireframe
  is unaffected by grouping (`WireframeGeometry` is pure line topology) and stays a
  single `LineBasicMaterial`.
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

## Known limitations

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

- **The WASM build has a known 3D Delaunay boundary-recovery failure on
  re-imported CAD geometry**, documented in GMSH-JS's own README under "Known
  issues": the default 3D algorithm (Delaunay) can fail boundary recovery —
  producing zero tetrahedra — specifically for geometry that has round-tripped
  through STEP/IGES import in this Emscripten target (native Gmsh builds recover
  reliably; the issue is tracked upstream for a future fix). Since every B-rep
  source CAD-Preview meshes has, by definition, just been imported via
  `gmsh.model.occ.importShapes`, this failure mode is directly in the feature's
  hot path — not a corner case. That is why `DEFAULT_MESH_OPTIONS.algorithm3D` in
  `src/meshOptions.ts` is set to **`4` (Frontal)** instead of Gmsh's own default,
  matching the workaround GMSH-JS's README recommends verbatim
  (`gmsh.option.setNumber('Mesh.Algorithm3D', 4)`). Users can still pick Delaunay
  (`1`) from the 3D algorithm dropdown for native `geo`/`occ` solids or STL
  remeshes where it isn't affected — the default just avoids the failure mode for
  the common case (opening a STEP/IGES/BREP file) out of the box.

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
