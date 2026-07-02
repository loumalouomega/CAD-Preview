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

Opening a file never triggers this — only clicking **▶ Generate** or one of the
**Export .msh / .geo** buttons in the FE Mesh panel does, exactly the same
first-use trigger discipline as OCCT's `getOcct`. Subsequent mesh generations reuse
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
| `meshingResult` | host → webview | Encoded boundary triangulation (`positions`/`indices`, base64) plus `nodeCount`/`elementCount` stats after a successful generate. |
| `meshingError` | host → webview | A human-readable failure message (bad geometry, GMSH exception, missing STL data) rendered in the panel's status line. |
| `meshingChanged` | webview → host | A `MeshOptions` patch to persist (`<model>.mesh.json` + `<model>.geo`). |
| `meshingGenerate` | webview → host | Request to run `generateMesh` now; carries the current options and, for mesh-format documents, a base64 `stl` snapshot. |
| `meshingExport` | webview → host | Request to write `.msh` or `.geo_unrolled` to disk via a save dialog; same options/`stl` payload as `meshingGenerate`. |

## Webview: panel, model, and overlay display

- **`src/webview/meshingModel.ts`** (`MeshingModel`) — a DOM-free store for the
  current `MeshOptions`, mirroring `EditsModel`/`PartsModel`'s pattern but simpler:
  since options are a flat bag rather than a list, there is no undo/redo, just
  `load()` (hydrate without firing `onChange`, used for the initial host→webview
  sync) and `update()` (patch + fire `onChange`, used for user edits).
- **`src/webview/meshingPanel.ts`** (`MeshingPanel`) — the DOM: a form
  (dimension, size min/max, 2D/3D algorithm dropdowns, element order, optimize
  checkbox) plus Generate / Export `.msh` / Export `.geo` / Clear buttons and a
  status line that shows either `Nodes: N · Elements: M` or an error string. Pure
  DOM, no business logic, no `prompt()`/`alert()` (VS Code webviews block those —
  same constraint documented for the Parts/Edits panels).
- **`src/webview/geometryBuilder.ts`**'s `buildFEMesh(positionsB64, indicesB64)`
  decodes the base64 buffers from a `meshingResult` message into a `THREE.Group`
  containing a shaded `MeshStandardMaterial` mesh (a distinct blue, `0x4ea1ff`, so
  the overlay reads as separate from the model's own face colouring) plus a
  `WireframeGeometry` overlay of the same triangulation, tagged
  `userData.entityType = "mesh"`.
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
  offers post-hoc wall/CPU time, not a streaming callback). Export
  (`.msh`/`.geo`) is not wired to `setBusy`; its save-dialog flow already
  surfaces completion/failure via the generic toolbar status bar.

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
can be reported upstream — three real gaps were found while building this feature,
plus one explicit "everything else worked" confirmation:

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

- **Everything else this feature needed is present and worked correctly.**
  `gmsh.model.occ.importShapes`, the STL remesh sequence
  (`merge`→`classifySurfaces`→`createGeometry`→`addSurfaceLoop`→`addVolume`→
  `synchronize`), `gmsh.model.mesh.generate`, `getNodes`/`getElements`,
  `gmsh.option.setNumber`, and `.geo_unrolled` writing via `gmsh.write()` all
  behaved exactly as documented against the live WASM build, with no binding gaps
  or workarounds required beyond the Frontal-algorithm default above. Beyond the
  three points above, **there is no other missing or broken GMSH-JS functionality
  to report upstream for this feature.**

  **Addendum:** that statement is scoped to GMSH-JS's own API surface, and it
  still stands — but it shouldn't be read as "the whole feature shipped bug-free
  on the first try." Two integration issues surfaced after initial implementation
  and were fixed, both in **CAD-Preview's own** bundling/OCCT-integration code,
  not in GMSH-JS: (a) an esbuild ESM→CJS bundling quirk where gmsh-wasm's use of
  `import.meta.url` needed a `banner`+`define` shim to survive the CJS conversion
  (see `esbuild.mjs`), and (b) an undocumented MEMFS path-length limit in the OCCT
  WASM build that affected `exportBRep()`'s generated temp file names (see
  `src/occtService.ts`). Neither was a gap in GMSH-JS's API — they were bugs in
  how CAD-Preview wired its own build and its separate OCCT WASM module together.
