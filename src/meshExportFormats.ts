/**
 * The mesh-export format registry — a single source of truth shared by the
 * host (`gmshService.ts`/`provider.ts`, picks the MEMFS write extension and
 * the save-dialog filter) and the webview (`meshingPanel.ts`, populates the
 * export `<select>`). Pure, vscode-free, mirrors `meshOptions.ts`'s
 * "kernel-agnostic, importable by both processes" convention.
 *
 * Gmsh's `gmsh.write(fileName)` dispatches purely by the file extension, and
 * this WASM build (`@loumalouomega/gmsh-wasm`) was probed directly against
 * every format Gmsh's writer table recognizes (see `doc/gmsh-integration.md`).
 * CGNS and MED are extension-recognized but throw `"...compiled without CGNS
 * support"` / `"...must be compiled with MED support..."` in this build (both
 * need HDF5-backed libs this build doesn't link) — excluded here rather than
 * offered as a format that always fails. `p3d`/`neu` wrote 0 bytes for a
 * tri/tet mesh (structured-grid/quad-only formats) — excluded as unusable for
 * this pipeline's element types.
 *
 * **`via` is the single dispatch discriminator `provider.ts`'s
 * `meshingExport` handler and `mcpTools.ts`'s `exportMeshTool` both switch
 * on** — replacing what used to be a hardcoded `msg.target === "med" ||
 * "cgns" || "xdmf"` triple (independently duplicated in both files, along
 * with its own copy of the `.h5`-companion-write-and-reference-rewrite
 * logic) with a registry lookup, so a NEW meshio-routed format never needs a
 * second code change beyond adding it here:
 * - `"gmsh"` — the generic `gmsh.write()`-based `exportMeshFormat()` path.
 * - `"mdpa"` — hand-serialized by `mdpaWriter.ts`/`gmshService.ts`'s
 *   `exportMdpa()` (Kratos MDPA has no `gmsh.write()` support at all).
 *   `mdpaElements`/`mdpaGeometries` share this `via` but still need their own
 *   id-keyed branch (the "elements" vs. "geometries" mode parameter), so
 *   `via` alone doesn't fully collapse their dispatch — it's still the
 *   correct discriminator, just not sufficient on its own for these two.
 * - `"meshio"` — `meshioService.ts`'s `exportViaMeshio()`: Gmsh's own
 *   writers can't produce this format at all (verified live against the
 *   installed `@loumalouomega/gmsh-wasm` build for every id below — see the
 *   per-group comments). `generateMesh()`'s own MSH 4.1 `mshText` is handed
 *   to meshio++, which re-encodes it host-side (no browser, no shared
 *   memory — a plain buffer round trip between the two WASM modules'
 *   independent virtual filesystems).
 *
 * `msh`/`msh2`/`geoUnrolled` are marked `"gmsh"` for documentation accuracy
 * (they ARE Gmsh-native output) but are still dispatched by id BEFORE the
 * `via` switch even runs — each calls a different pipeline function
 * (`generateMesh`'s own `mshText`, `exportGeoUnrolled`) with its own
 * companion-file handling (`.xao` for `geoUnrolled`), not the generic
 * `exportMeshFormat()` every other `"gmsh"` id uses.
 *
 * `med`/`cgns`/`xdmf` preserve parts/physical groups as named groups (MED's
 * own family mechanism — see `exportViaMeshio`'s doc comment). **Known
 * limitation, re-verified against the live 9.7.0 WASM**: CGNS export of a
 * pure-2D/surface mesh (triangles/quads only, no volume elements) used to
 * produce a file this same WASM build's own reader couldn't read back — this
 * was fixed upstream in meshio++ 9.8.0 (currently installed: 10.14.0), see
 * `doc/gmsh-integration.md`'s "The meshio++ bridge" section.
 *
 * **The 8 non-bridge meshio-only writers below (`vtu`/`hmf`/`avsucd`/
 * `mphtxt`/`netgen`/`flac3d`/`wkt`/`flux`) were added after a live,
 * end-to-end verification pass, not from meshio++'s format table alone.**
 * Two things were checked independently, both against the ACTUAL
 * `generateMesh()`-shaped MSH 4.1 input (a tetrahedralized box, `Mesh.
 * SaveAll` forced on — which, verified, includes 0-D "vertex" cell elements
 * for the model's geometric points, not just the volume mesh): (1) that
 * `gmsh.write()` genuinely has NO writer for the extension at all (every one
 * threw `"gmshWrite: Unknown output file format"`, not merely "unsupported
 * for this mesh shape" — confirming these are additive, not a second path to
 * something Gmsh could already produce); (2) that meshio++'s writer for the
 * format accepts THIS pipeline's actual vertex-cell-bearing input and the
 * result round-trips back through meshio++'s OWN reader for that format with
 * matching point/cell counts. Several plausible-looking candidates FAILED
 * step (2) and are deliberately excluded, not merely unconsidered: `vtp`
 * (`"PolyData cannot hold 'tetra' cells"`), `vti` (needs a regular
 * hexahedral lattice, which a tet mesh isn't), `h5m`/`ugrid`/`tecplot`/
 * `ansys`/`ansysinp`/`freefem` (all reject the 0-D vertex cells this
 * pipeline's `Mesh.SaveAll` mode always includes), and `dex`/`ip`/`mff`/
 * `mfm` (each either lost all cell connectivity or failed outright on
 * round-trip — not genuinely usable as a document-preview export target).
 */

export interface MeshExportFormat {
  id: string;
  /** Shown in the export `<select>`. */
  label: string;
  /** Both the MEMFS write path's extension (selects Gmsh's writer) and the
   * save-dialog's default file extension/filter. */
  extension: string;
  /** Save-dialog filter group label. */
  filterLabel: string;
  /** Which writer produces this format — see the file doc comment. */
  via: "gmsh" | "mdpa" | "meshio";
}

export const MESH_EXPORT_FORMATS = [
  {
    id: "mdpaElements",
    label: "Kratos MDPA — Elements + Conditions (.mdpa)",
    extension: "mdpa",
    filterLabel: "Kratos MDPA (Elements + Conditions)",
    via: "mdpa",
  },
  {
    id: "mdpaGeometries",
    label: "Kratos MDPA — Geometries (.mdpa)",
    extension: "mdpa",
    filterLabel: "Kratos MDPA (Geometries)",
    via: "mdpa",
  },
  { id: "msh", label: "Gmsh Mesh (.msh)", extension: "msh", filterLabel: "GMSH Mesh", via: "gmsh" },
  { id: "msh2", label: "Gmsh Mesh v2, Legacy (.msh2)", extension: "msh2", filterLabel: "GMSH Mesh v2 (Legacy)", via: "gmsh" },
  {
    id: "geoUnrolled",
    label: "Gmsh Geometry (.geo_unrolled)",
    extension: "geo_unrolled",
    filterLabel: "GMSH Unrolled Geometry",
    via: "gmsh",
  },
  { id: "vtk", label: "VTK (.vtk)", extension: "vtk", filterLabel: "VTK Mesh", via: "gmsh" },
  { id: "med", label: "MED (.med)", extension: "med", filterLabel: "MED Mesh", via: "meshio" },
  { id: "cgns", label: "CGNS (.cgns)", extension: "cgns", filterLabel: "CGNS Mesh", via: "meshio" },
  { id: "xdmf", label: "XDMF (.xdmf)", extension: "xdmf", filterLabel: "XDMF Mesh", via: "meshio" },
  { id: "unv", label: "I-DEAS Universal (.unv)", extension: "unv", filterLabel: "I-DEAS Universal Mesh", via: "gmsh" },
  { id: "inp", label: "Abaqus (.inp)", extension: "inp", filterLabel: "Abaqus Input", via: "gmsh" },
  { id: "bdf", label: "Nastran Bulk Data (.bdf)", extension: "bdf", filterLabel: "Nastran Bulk Data", via: "gmsh" },
  { id: "su2", label: "SU2 (.su2)", extension: "su2", filterLabel: "SU2 Mesh", via: "gmsh" },
  { id: "mesh", label: "INRIA Medit (.mesh)", extension: "mesh", filterLabel: "INRIA Medit Mesh", via: "gmsh" },
  { id: "stl", label: "STL Mesh (.stl)", extension: "stl", filterLabel: "STL Mesh", via: "gmsh" },
  { id: "diff", label: "Diffpack (.diff)", extension: "diff", filterLabel: "Diffpack Mesh", via: "gmsh" },
  { id: "off", label: "OFF (.off)", extension: "off", filterLabel: "OFF Mesh", via: "gmsh" },
  { id: "vtu", label: "VTK XML Unstructured (.vtu)", extension: "vtu", filterLabel: "VTK XML Unstructured Mesh", via: "meshio" },
  { id: "hmf", label: "HDF Mesh Format (.hmf)", extension: "hmf", filterLabel: "HDF Mesh Format", via: "meshio" },
  { id: "avsucd", label: "AVS UCD (.avs)", extension: "avs", filterLabel: "AVS UCD Mesh", via: "meshio" },
  { id: "mphtxt", label: "COMSOL Mphtxt (.mphtxt)", extension: "mphtxt", filterLabel: "COMSOL Mphtxt Mesh", via: "meshio" },
  { id: "netgen", label: "Netgen (.vol)", extension: "vol", filterLabel: "Netgen Mesh", via: "meshio" },
  { id: "flac3d", label: "FLAC3D (.f3grid)", extension: "f3grid", filterLabel: "FLAC3D Mesh", via: "meshio" },
  { id: "wkt", label: "Well-Known Text (.wkt)", extension: "wkt", filterLabel: "Well-Known Text", via: "meshio" },
  { id: "flux", label: "Flux (.pf3)", extension: "pf3", filterLabel: "Flux Mesh", via: "meshio" },
] as const satisfies readonly MeshExportFormat[];

export type MeshExportFormatId = (typeof MESH_EXPORT_FORMATS)[number]["id"];

const BY_ID = new Map<string, MeshExportFormat>(MESH_EXPORT_FORMATS.map((f) => [f.id, f]));

export function meshExportFormat(id: string): MeshExportFormat | undefined {
  return BY_ID.get(id);
}
