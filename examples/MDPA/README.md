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
- A deck carrying a Kratos `Table`/`Properties`/`Geometries`/`Constraints`
  block is still rejected by name (CAD-Preview does not opt into
  `readMeshSelective`'s `lenient` mode) — see `doc/file-formats.md`'s
  "Kratos MDPA note".
