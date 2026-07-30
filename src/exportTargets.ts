import type { CadFormat, FileRoute } from "./fileRouter";

const BREP_FORMATS: CadFormat[] = ["step", "iges", "brep"];
const MESH_FORMATS: CadFormat[] = ["stl", "obj", "ply", "gltf"];

/**
 * The formats a loaded document can be exported to, excluding its own format.
 *
 * B-rep sources can export to the other B-rep formats (true CAD writers) plus any mesh
 * format (from the already-tessellated geometry). Mesh sources can only export to other
 * mesh formats — there is no path to promote a triangle soup into a B-rep.
 */
export function exportTargetsFor(route: FileRoute): CadFormat[] {
  if (route.strategy === "occt") {
    return [...BREP_FORMATS.filter((f) => f !== route.format), ...MESH_FORMATS];
  }
  return MESH_FORMATS.filter((f) => f !== route.format);
}

/** File extension to use when saving an export of the given format. */
export const EXPORT_EXTENSION: Record<CadFormat, string> = {
  step: "step",
  iges: "iges",
  brep: "brep",
  stl: "stl",
  obj: "obj",
  ply: "ply",
  // Export always produces a single-file binary glTF (.glb), not a text .gltf with
  // embedded base64 buffers — simpler and more portable for a one-shot Save As.
  gltf: "glb",
  // meshio++-only formats (below) are never reachable via `exportTargetsFor` —
  // they're import-only document formats, not export targets — but every
  // `CadFormat` member needs an entry here for `Record<CadFormat, string>` to
  // stay exhaustive.
  vtk: "vtk",
  vtu: "vtu",
  med: "med",
  cgns: "cgns",
  exodus: "exo",
  xdmf: "xdmf",
  mdpa: "mdpa",
};

/** Human-readable label for a format, used in the export quick-pick. */
export const EXPORT_LABEL: Record<CadFormat, string> = {
  step: "STEP",
  iges: "IGES",
  brep: "BREP",
  stl: "STL",
  obj: "OBJ",
  ply: "PLY",
  gltf: "glTF Binary",
  // Never offered by exportTargetsFor (see EXPORT_EXTENSION's comment) — present only for Record exhaustiveness.
  vtk: "VTK",
  vtu: "VTU",
  med: "MED",
  cgns: "CGNS",
  exodus: "Exodus",
  xdmf: "XDMF",
  mdpa: "MDPA",
};
