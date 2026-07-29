# Roadmap

Candidate features for future CAD-Preview releases, prioritized by value versus
effort given what the extension already ships: an OCCT kernel, a Gmsh kernel,
and a meshio++ kernel live in the extension host, a full picking/selection
pipeline in the webview, a sidecar persistence model, and an MCP server
mirroring the pipeline headless. Many high-value features are cheap precisely
because that infrastructure exists.

This page is aspirational, not a commitment — items may be re-ordered, re-scoped,
or dropped. Effort is a rough order of magnitude: **S** (a day or two), **M**
(roughly a week), **L** (multi-week).

Everything previously listed here (mass properties, measurement tools,
screenshot, settings, clipping planes, FE mesh quality stats, per-part
isolate/hide + tree search, appearance controls incl. an orthographic camera,
drag-and-drop open, a live exploded-view slider, the meshio++ import/export
bridge, units handling, and model comparison) has shipped — see `CLAUDE.md`'s
per-feature sections for the verified implementation details and CHANGELOG.md
for release notes.

## Candidate ideas

### Hex-dominant FE meshing — M

`@loumalouomega/gmsh-wasm` 0.3.0 fixed the wasm32 stack-overflow bug that used
to make the default 3D Delaunay algorithm hang/produce an empty mesh on
re-imported CAD geometry (root cause: Gmsh's tetgen-derived boundary recovery
recurses past Emscripten's 64 KiB default stack; fixed upstream by raising
`-sSTACK_SIZE`/`-sDEFAULT_PTHREAD_STACK_SIZE`). As a verified side effect, the
RTree hex-tet hybrid recombiner (`Mesh.Algorithm3D = 9` +
`Mesh.Recombine3DAll = 1`) now also produces valid meshes — previously
non-functional in this build (see `CLAUDE.md`'s "Meshing (GMSH-JS)" section
for the verification trail). This was a hard non-goal before; it's now
technically feasible, but not yet implemented.

- **Why:** a genuine gap versus other meshers — CAD-Preview currently offers
  only all-simplex (`Mesh.Algorithm3D` default) or all-subdivided (all-quad/
  all-hex via `SubdivisionAlgorithm`) element shapes, never a hex-dominant
  mix, which many FE workflows prefer for better element quality at lower
  count.
- **What it needs:** GMSH-JS's own docs mark the RTree path "experimental"
  (upstream Gmsh's own framing) and note the hybrid output mixes tet (type 4)
  and hex (type 5) elements stitched by **type-140 "trihedron" connector
  elements** at the tet/hex interface — a genuinely new element kind
  `gmshElementTypes.ts`'s table doesn't cover yet (only tet/hex/prism/pyramid
  today). Adding this cleanly needs: a new `"hexDominant"` `elementShape`
  value (`meshOptions.ts`'s `validateMeshOptions` currently rejects it),
  `gmshShapeOptions` wiring `Algorithm3D=9`+`Recombine3DAll=1`, a trihedron
  entry in `gmshElementTypes.ts` (stride/boundary-face decomposition/Kratos
  mapping — MDPA export has no Kratos geometry for a tet/hex transition
  element today, so that mapping needs real design work, not just a table
  row), and a UI option alongside the existing Triangles/Tetrahedra and
  Quads/Hexahedra choices.
- **Notes:** confirmed live against 0.3.0 on `examples/STP/block.stp` — a
  hex-dominant generate produced element types `[4, 5, 140]` (702 tets, 165
  hexes, 366 trihedron connectors), so the feature genuinely works end to
  end. But `gmsh.model.mesh.getElementProperties(140)` — the coordinate-
  matching method every other element kind's node permutation in
  `gmshElementTypes.ts` was derived from — **throws** (`"Size of basis
  incompatible with element type"`), so that verification method doesn't
  extend to the trihedron connector. Its node ordering/geometry would need a
  different source (Gmsh's own C++ element-type headers, or a from-scratch
  geometric derivation) before it could be added to the shared table with
  the same confidence every other row has.

## Non-goals / known constraints

- **Writing the CAD source file** — never. The read-only invariant (sidecar
  persistence, export-only baking) is architectural, not a missing feature.
- **OCCT in the webview** — the kernel stays in the extension host; the webview
  runs only Three.js (architecture invariant).
