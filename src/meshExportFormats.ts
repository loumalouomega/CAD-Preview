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
 * `mdpaElements`/`mdpaGeometries` are the one exception to all of the above —
 * Kratos MDPA has no `gmsh.write()` support at all, so these two are
 * hand-serialized by `mdpaWriter.ts`/`gmshService.ts`'s `exportMdpa()`
 * instead of the generic `gmsh.write()`-based `exportMeshFormat()` every
 * other id here goes through. They're listed first so `mdpaElements` is the
 * default-selected `<select>` option (array order = option order).
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
}

export const MESH_EXPORT_FORMATS = [
  {
    id: "mdpaElements",
    label: "Kratos MDPA — Elements + Conditions (.mdpa)",
    extension: "mdpa",
    filterLabel: "Kratos MDPA (Elements + Conditions)",
  },
  {
    id: "mdpaGeometries",
    label: "Kratos MDPA — Geometries (.mdpa)",
    extension: "mdpa",
    filterLabel: "Kratos MDPA (Geometries)",
  },
  { id: "msh", label: "Gmsh Mesh (.msh)", extension: "msh", filterLabel: "GMSH Mesh" },
  { id: "msh2", label: "Gmsh Mesh v2, Legacy (.msh2)", extension: "msh2", filterLabel: "GMSH Mesh v2 (Legacy)" },
  {
    id: "geoUnrolled",
    label: "Gmsh Geometry (.geo_unrolled)",
    extension: "geo_unrolled",
    filterLabel: "GMSH Unrolled Geometry",
  },
  { id: "vtk", label: "VTK (.vtk)", extension: "vtk", filterLabel: "VTK Mesh" },
  { id: "unv", label: "I-DEAS Universal (.unv)", extension: "unv", filterLabel: "I-DEAS Universal Mesh" },
  { id: "inp", label: "Abaqus (.inp)", extension: "inp", filterLabel: "Abaqus Input" },
  { id: "bdf", label: "Nastran Bulk Data (.bdf)", extension: "bdf", filterLabel: "Nastran Bulk Data" },
  { id: "su2", label: "SU2 (.su2)", extension: "su2", filterLabel: "SU2 Mesh" },
  { id: "mesh", label: "INRIA Medit (.mesh)", extension: "mesh", filterLabel: "INRIA Medit Mesh" },
  { id: "stl", label: "STL Mesh (.stl)", extension: "stl", filterLabel: "STL Mesh" },
  { id: "diff", label: "Diffpack (.diff)", extension: "diff", filterLabel: "Diffpack Mesh" },
  { id: "off", label: "OFF (.off)", extension: "off", filterLabel: "OFF Mesh" },
] as const satisfies readonly MeshExportFormat[];

export type MeshExportFormatId = (typeof MESH_EXPORT_FORMATS)[number]["id"];

const BY_ID = new Map<string, MeshExportFormat>(MESH_EXPORT_FORMATS.map((f) => [f.id, f]));

export function meshExportFormat(id: string): MeshExportFormat | undefined {
  return BY_ID.get(id);
}
