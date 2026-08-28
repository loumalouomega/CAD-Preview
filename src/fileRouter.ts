/**
 * Maps a file to the pipeline used to render it.
 *
 * - `occt`: B-rep formats parsed + tessellated by OpenCascade.js in the extension host.
 * - `three`: already-triangulated mesh formats loaded by native Three.js loaders.
 * - `meshio`: formats meshio++ (`src/meshioService.ts`) reads that neither of the
 *   above can — the host converts them to an STL boundary surface
 *   (`convertToStlBoundary`) and the webview loads that via the same STL
 *   loader a native `.stl` open uses (see `protocol.ts`'s `loadMeshBytes`).
 */
export type RenderStrategy = "occt" | "three" | "meshio";

export type CadFormat =
  | "step" | "iges" | "brep" | "stl" | "obj" | "ply" | "gltf"
  | "vtk" | "vtu" | "med" | "cgns" | "exodus" | "xdmf" | "mdpa"
  | "gmsh" | "abaqus" | "unv" | "su2" | "medit";

/** `CadFormat` members routed through meshio++ — kept as one list so every
 * place that needs to enumerate them (package.json's generation, docs) has a
 * single source of truth to check against.
 *
 * `gmsh`/`abaqus`/`unv`/`su2`/`medit` were added alongside the original
 * seven — closing a real export/import asymmetry: CAD-Preview's own FE Mesh
 * panel already WRITES `.msh`/`.inp`/`.unv`/`.su2`/`.mesh` (via
 * `gmsh.write()`, see `meshExportFormats.ts`), but until now had no way to
 * re-OPEN any of them. Each was verified end-to-end against the live WASM,
 * not just assumed from meshio++'s format table: `gmsh.write()` a real
 * tetrahedralized box to each extension, then `meshioService.getMeshio()`'s
 * `readMesh(path, meshioFormat)` on the result — all five round-tripped with
 * the correct point/cell counts. Two formats gmsh ALSO writes were tried and
 * REJECTED after the same live check: `.bdf` (Nastran) round-trips through
 * meshio++'s own reader as `"Not a meshio++-C++ Nastran file"`, and `.off`
 * as `"Expected the first line to be 'OFF'"` — gmsh's writer output for both
 * isn't shaped the way meshio++'s reader for the same nominal format
 * expects, so neither is claimed as an import format here (a real, narrower
 * finding than "meshio++ can't read OFF/Nastran" — it may well read a
 * DIFFERENT tool's output for either format correctly; this codebase simply
 * has no fixture to verify that, and CLAUDE.md's own discipline is to claim
 * only what was actually checked).
 */
export const MESHIO_FORMATS: readonly CadFormat[] = [
  "vtk", "vtu", "med", "cgns", "exodus", "xdmf", "mdpa",
  "gmsh", "abaqus", "unv", "su2", "medit",
];

/**
 * Extensions whose format cannot be determined from the extension alone,
 * mapped to a plain, human-readable caveat — `.msh` is Gmsh's own MSH format
 * (this codebase's own FE Mesh panel output, and `routeFile`'s preferred
 * default) but is also used by ANSYS and FreeFem meshes; `.inp` is Abaqus
 * (likewise this codebase's own output, likewise preferred) but also
 * ANSYS's APDL command-file `.inp`. `routeFile` stays synchronous and
 * unconditional (never blocking, never WASM-dependent, per its own
 * invariant) and always resolves to the PREFERRED format — there is
 * deliberately no content-sniffing disambiguation here: meshio++ can read
 * `ansys`/`freefem`/`ansysinp`, but this codebase has no real
 * ANSYS/FreeFem-authored fixture to verify that read against, so claiming
 * support for them would be an unverified promise, not a checked one (see
 * CLAUDE.md's "verify against the live WASM, never assume" discipline). A
 * consumer holding the actual bytes (`provider.ts`'s `handleMeshio`,
 * `mcpTools.ts`'s `loadModel`) surfaces this map's caveat as a warning
 * rather than silently guessing — an ANSYS `.msh` still opens, but as a
 * (likely wrong) Gmsh parse, with the user told why.
 */
export const AMBIGUOUS_MESHIO_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["msh", "Assumed to be a Gmsh mesh (this extension's own FE Mesh export format) — an ANSYS or FreeFem .msh file will not parse correctly."],
  ["inp", "Assumed to be an Abaqus input file (this extension's own FE Mesh export format) — an ANSYS APDL .inp file will not parse correctly."],
]);

/** The mesh formats with a pure host-side triangle parser (`stlParser.ts`,
 * `objParser.ts`, `plyParser.ts`, `gltfParser.ts`) — i.e. the ones whose
 * geometry the host can derive on its own, with no webview and no OCCT. */
export type MeshParseFormat = "stl" | "obj" | "ply" | "gltf";

/**
 * The mesh formats every host-side geometry consumer accepts: `compare_models`
 * (centroid/volume signatures), `check_mesh_health`, and `promote_mesh_to_brep`.
 *
 * This used to be declared TWICE — once in `mcpTools.ts` and once in
 * `modelComparePanel.ts` — with a comment justifying the duplication as "the
 * two files don't otherwise share an import". That premise stopped being true
 * (both already import `routeFile` from this module), and the copies were a
 * live drift hazard: adding glTF meant widening two sets and nine separate
 * `as "stl" | "obj" | "ply"` casts, two of which were runtime string
 * comparisons TypeScript could not have flagged. One declaration here, with
 * `MeshParseFormat` as the matching type, removes both problems.
 */
export const COMPARABLE_MESH_FORMATS: ReadonlySet<CadFormat> = new Set<CadFormat>(["stl", "obj", "ply", "gltf"]);

export interface FileRoute {
  strategy: RenderStrategy;
  format: CadFormat;
}

const EXTENSION_MAP: Record<string, FileRoute> = {
  step: { strategy: "occt", format: "step" },
  stp: { strategy: "occt", format: "step" },
  iges: { strategy: "occt", format: "iges" },
  igs: { strategy: "occt", format: "iges" },
  brep: { strategy: "occt", format: "brep" },
  stl: { strategy: "three", format: "stl" },
  obj: { strategy: "three", format: "obj" },
  ply: { strategy: "three", format: "ply" },
  gltf: { strategy: "three", format: "gltf" },
  glb: { strategy: "three", format: "gltf" },
  vtk: { strategy: "meshio", format: "vtk" },
  vtu: { strategy: "meshio", format: "vtu" },
  med: { strategy: "meshio", format: "med" },
  cgns: { strategy: "meshio", format: "cgns" },
  exo: { strategy: "meshio", format: "exodus" },
  e: { strategy: "meshio", format: "exodus" },
  xdmf: { strategy: "meshio", format: "xdmf" },
  mdpa: { strategy: "meshio", format: "mdpa" },
  msh: { strategy: "meshio", format: "gmsh" },
  msh2: { strategy: "meshio", format: "gmsh" }, // meshio++'s gmsh reader auto-detects the MSH schema version (2.2 vs 4.1) from the file's own header — verified live, no separate format name needed.
  inp: { strategy: "meshio", format: "abaqus" },
  unv: { strategy: "meshio", format: "unv" },
  su2: { strategy: "meshio", format: "su2" },
  mesh: { strategy: "meshio", format: "medit" },
};

/** Returns the render route for a file path, or `undefined` if the extension is unsupported. */
export function routeFile(filePath: string): FileRoute | undefined {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1 || dot === filePath.length - 1) {
    return undefined;
  }
  const ext = filePath.slice(dot + 1).toLowerCase();
  return EXTENSION_MAP[ext];
}
