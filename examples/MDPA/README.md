# MDPA fixtures

`gapped-ids.mdpa` — a minimal Kratos deck with deliberately **non-sequential
node ids** (7, 23, 41, 100), one `Element3D4N` tetrahedron, element id 5.

Regression fixture for the `@meshioplusplus/wasm` 9.13.0/9.14.0 C++ reader fix:
before it, meshio++'s C++ MDPA reader threw
`"MDPA: non-sequential node ids are not supported by the C++ reader"` on any
deck whose node ids were not exactly `1..n` in file order — and gapped ids are
routine in real Kratos decks (SubModelPart extraction, entity removal and deck
merging all leave them). This deck must open via `load_model`, convert to a
4-triangle STL boundary, and mesh via `generate_mesh`; the MCP smoke script
(`scripts/mcp-smoke/run.mjs`) asserts exactly that.

Notes:

- The element name is Kratos's core-registered `Element3D4N` — the same name
  this extension's own `mdpaWriter.ts` emits for tet4 — **not**
  `"Tetrahedra3D4N"`, which is the geometry class name and is rejected by the
  reader (`"MDPA: unknown Kratos entity name …"`).
- The MDPA reader accepts no top-level comment syntax; that is why this file's
  explanation lives here rather than in the deck itself.
- A deck carrying a Kratos `Table`/`Properties`/`Geometries` block is still
  rejected by name (CAD-Preview does not opt into `readMeshSelective`'s
  `lenient` mode) — see `doc/file-formats.md`'s "Kratos MDPA note". A
  `Constraints` block is the exception: CAD-Preview strips it before meshio++
  reads the deck and reads it back itself (`src/mdpaConstraints.ts`).

`hanging-two-level.mdpa` — one coarse 2x2x2 hexahedron beside eight unit
hexahedra (a 2:1 interface), with the five hanging nodes tied by 15
`LinearMasterSlaveConstraint` rows (3 variables) and a `HangingNodes`
SubModelPart. Copied from VSCode-MDPA-Preview's fixture of the same layout. It
must open (the Constraints blocks are stripped for meshio++), report 15
constraints on 5 slave nodes, and show a 50-facet surface (25 quads — the
interface wall is removed).
