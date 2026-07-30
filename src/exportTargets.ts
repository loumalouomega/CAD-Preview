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

/**
 * Formats whose export can honestly represent a converted, correctly-labeled
 * unit. **STEP and IGES are deliberately excluded** — both declare a length
 * unit in their own header that MUST match the geometry's actual scale to
 * mean anything, and this OCCT WASM build has no verified way to set that
 * declared unit on write: `Interface_Static`'s `"write.step.unit"` parameter
 * never registers (`IsPresent`/`SetCVal` both report failure even after
 * constructing a `STEPControl_Writer`, which in desktop OCCT registers it),
 * and probing `IGESControl_Writer`'s alternate unit-aware constructor
 * produced a `Write()` call that reported success but whose output could not
 * be read back to verify — neither could be trusted. Scaling STEP/IGES
 * geometry without also fixing the header would silently mislabel the file
 * (e.g. a "converted to inches" STEP file whose header still says
 * millimetres reopens 25.4× too small in any correct reader, including this
 * extension's own) — excluded here entirely rather than shipped half-correct.
 * BREP has no unit metadata at all (nothing to mismatch); the mesh formats
 * (STL/OBJ/PLY/glTF) enforce no unit metadata either, so scaling their raw
 * numbers is complete and correct on its own.
 */
export const UNIT_CONVERTIBLE_FORMATS: ReadonlySet<CadFormat> = new Set(["brep", "stl", "obj", "ply", "gltf"]);

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
