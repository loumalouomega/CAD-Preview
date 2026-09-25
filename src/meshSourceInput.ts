/**
 * Host-side FE-meshing input for MESH-format sources (STL/OBJ/PLY/glTF and
 * the meshio++ formats), shared by the MCP server and the extension host.
 *
 * This used to be the non-B-rep half of `mcpTools.ts`'s
 * `resolveMeshInputHeadless`, reachable only headlessly. The
 * `cad-preview.exportMesh` command refused every mesh-format source because
 * the extension got that geometry from the webview's serialized STL (roadmap
 * Tier 1 "Parity gaps"). Moving it here — with the file reads and the two
 * meshio conversions injected — lets both layers resolve it the same way:
 * `mcpTools.ts` passes `node:fs` readers and its pipeline, `provider.ts`
 * passes `vscode.workspace.fs` readers and the document-scoped kernel client.
 *
 * WASM-free and vscode-free on purpose: the parse is `meshParse.ts`'s pure
 * `parseToWeldedMesh`, and the meshio conversions go through the injected
 * (kernel-worker) functions, so `provider.ts` can import this without
 * bundling a kernel.
 *
 * Pending mesh edits are NOT baked in — mesh edits replay only in the
 * webview. Every caller gets the same named warning, never a silent raw-file
 * mesh.
 */

import type { FileRoute, MeshParseFormat } from "./fileRouter";
import type { MeshGenerationInput } from "./gmshService";
import type { MeshioCompanion } from "./meshioService";
import type { GltfExternalBuffers } from "./gltfParser";
import { parseToWeldedMesh } from "./meshParse";
import { weldedMeshToStlBytes } from "./meshComponents";
import { scaleStlBytes } from "./stlParser";
import { unitScaleFactor, type DisplayUnit } from "./lengthUnits";

export interface MeshSourceInputDeps {
  /** The source file's bytes. */
  readBytes: () => Promise<Uint8Array>;
  /** A glTF's external `.bin` buffers (only called for glTF). */
  resolveGltfBuffers: (bytes: Uint8Array) => Promise<GltfExternalBuffers | undefined>;
  /** A meshio source's sibling files (XDMF `.h5`, GiD `.post.res`, …). */
  resolveMeshioCompanions: (bytes: Uint8Array) => Promise<MeshioCompanion[]>;
  convertToStlBoundary: (bytes: Uint8Array, format: string, sourceName: string, companions: MeshioCompanion[]) => Promise<Uint8Array>;
  convertFoamCaseToStlBoundary: (markerPath: string) => Promise<Uint8Array>;
}

/** True for a route this module can resolve (everything but a B-rep source). */
export function isMeshSourceRoute(route: FileRoute): boolean {
  return route.strategy === "meshio" || route.format === "stl" || route.format === "obj" || route.format === "ply" || route.format === "gltf";
}

/**
 * Resolves a mesh-format source to STL meshing input, scaled by `unit`
 * (default native mm). `sourcePath` is the source's filesystem path — its
 * basename is the meshio staging name, and for OpenFOAM it is the `.foam`
 * marker the case is staged from. `pendingOps` is the count of unbaked edit
 * ops, only used to word the not-baked warning. Throws for a B-rep route —
 * callers resolve those through the kernel's STEP re-export instead.
 */
export async function resolveMeshSourceInput(
  route: FileRoute,
  sourcePath: string,
  pendingOps: number,
  deps: MeshSourceInputDeps,
  warnings: string[],
  unit: DisplayUnit = "mm"
): Promise<MeshGenerationInput> {
  if (!isMeshSourceRoute(route)) {
    throw new Error(`${route.format} is not a mesh-format source — resolve it through the B-rep STEP re-export.`);
  }
  if (pendingOps > 0) {
    warnings.push(
      route.strategy === "meshio"
        ? `${pendingOps} edit op(s) exist but are NOT baked into the meshed geometry — ${route.format} edits replay in the webview only; the raw file's boundary surface is meshed.`
        : `${pendingOps} edit op(s) exist but are NOT baked into the meshed geometry — ${route.format.toUpperCase()} edits replay in the webview only; the raw file bytes are meshed.`
    );
  }
  let stlBytes: Uint8Array;
  if (route.strategy === "meshio") {
    // meshio++ runs host-side: converted to an STL boundary surface and meshed
    // like a native `.stl`. OpenFOAM's `.foam` marker holds no mesh — the case
    // lives under `<parent>/constant/polyMesh/`, so it is staged from the path.
    if (route.format === "openfoam") {
      stlBytes = await deps.convertFoamCaseToStlBoundary(sourcePath);
    } else {
      const bytes = await deps.readBytes();
      const companions = await deps.resolveMeshioCompanions(bytes);
      stlBytes = await deps.convertToStlBoundary(bytes, route.format, baseName(sourcePath), companions);
    }
  } else if (route.format === "stl") {
    stlBytes = await deps.readBytes();
  } else {
    const bytes = await deps.readBytes();
    const format = route.format as MeshParseFormat;
    const external = format === "gltf" ? await deps.resolveGltfBuffers(bytes) : undefined;
    stlBytes = weldedMeshToStlBytes(parseToWeldedMesh(bytes, format, external));
  }
  const factor = unitScaleFactor(unit);
  return { kind: "stl", stlBytes: factor === 1 ? stlBytes : scaleStlBytes(stlBytes, factor) };
}

function baseName(p: string): string {
  return p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
}
