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
  | "openfoam";

/** `CadFormat` members routed through meshio++ — kept as one list so every
 * place that needs to enumerate them (package.json's generation, docs) has a
 * single source of truth to check against. */
export const MESHIO_FORMATS: readonly CadFormat[] = ["vtk", "vtu", "med", "cgns", "exodus", "xdmf", "mdpa", "openfoam"];

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
  // OpenFOAM polyMesh. A `.foam` file is an (usually empty) marker file — the
  // ParaView convention — whose sibling `<parent>/constant/polyMesh/` holds
  // the real mesh (`points`, `faces`, `owner`, `neighbour`, `boundary`).
  // meshio++'s reader resolves that directory itself, so the meshio route
  // stages the whole case into its MEMFS before reading (see
  // `meshioService.ts`'s foam staging).
  foam: { strategy: "meshio", format: "openfoam" },
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
