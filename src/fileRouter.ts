/**
 * Maps a file to the pipeline used to render it.
 *
 * - `occt`: B-rep formats parsed + tessellated by OpenCascade.js in the extension host.
 * - `three`: already-triangulated mesh formats loaded by native Three.js loaders.
 */
export type RenderStrategy = "occt" | "three";

export type CadFormat = "step" | "iges" | "brep" | "stl" | "obj" | "ply" | "gltf";

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
