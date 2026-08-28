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
 * unit — now every B-rep/mesh export target this codebase produces.
 *
 * STEP and IGES were originally excluded: both declare a length unit in
 * their own header that MUST match the geometry's actual scale to mean
 * anything, and scaling geometry without also fixing the header would
 * silently mislabel the file (it reopens 25.4× too small/big in any correct
 * reader, including this extension's own). That's still true, but each
 * format now has a verified, working mechanism to fix the header too:
 * - **IGES**: `IGESControl_Writer`'s alternate unit-aware constructor
 *   (`IGESControl_Writer_2(unitName, modeCreation)`) genuinely works — it was
 *   only ever reported "unconfirmed" because the original probe fed it an
 *   11+ character MEMFS output path, silently hitting this OCCT WASM build's
 *   undocumented path-length limit (see `exportBRep`'s doc comment), not a
 *   real writer limitation. Re-probed with a correctly short path: it both
 *   scales the geometry AND declares the header unit correctly for all five
 *   `DisplayUnit`s, round-tripped through this codebase's own reader to
 *   recover the source model's exact bounding box in every case.
 * - **STEP**: still has no writer-level unit API at all in this build
 *   (`Interface_Static`'s `"write.step.unit"` parameter never registers, even
 *   via the full real-OCCT init sequence; no writer/actor class exposes a
 *   unit setter either) — so `stepUnitPatch.ts`'s `patchStepUnitDeclaration`
 *   does the labeling as a text-only rewrite of the writer's own always-mm
 *   header, applied AFTER the geometry has already been correctly scaled (so
 *   every raw number in the file is already correct — only the label needed
 *   fixing). See that module's doc comment for the full mechanism and the
 *   live-WASM round-trip verification.
 *
 * BREP has no unit metadata at all (nothing to mismatch); the mesh formats
 * (STL/OBJ/PLY/glTF) enforce no unit metadata either, so scaling their raw
 * numbers is complete and correct on its own.
 */
export const UNIT_CONVERTIBLE_FORMATS: ReadonlySet<CadFormat> = new Set(["step", "iges", "brep", "stl", "obj", "ply", "gltf"]);

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
  gmsh: "msh",
  abaqus: "inp",
  unv: "unv",
  su2: "su2",
  medit: "mesh",
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
  gmsh: "Gmsh Mesh",
  abaqus: "Abaqus",
  unv: "I-DEAS Universal",
  su2: "SU2",
  medit: "INRIA Medit",
};
