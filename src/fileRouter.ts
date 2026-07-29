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
  | "vtk" | "vtu" | "med" | "cgns" | "exodus" | "xdmf" | "mdpa";

/** `CadFormat` members routed through meshio++ — kept as one list so every
 * place that needs to enumerate them (package.json's generation, docs) has a
 * single source of truth to check against. */
export const MESHIO_FORMATS: readonly CadFormat[] = ["vtk", "vtu", "med", "cgns", "exodus", "xdmf", "mdpa"];

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
