/**
 * The four-format mesh parse front end, WASM-free.
 *
 * `parseToWeldedMesh` used to live in `meshHeal.ts`, whose own module graph
 * pulls in OCCT — which `provider.ts` must never bundle. It moved here so the
 * extension host can resolve STL/OBJ/PLY/glTF meshing input itself (the
 * `cad-preview.exportMesh` command, via `meshSourceInput.ts`) without dragging
 * the kernel along. `meshHeal.ts` re-exports it, so every existing importer
 * keeps working.
 */

import { parseStl } from "./stlParser";
import { parseObj } from "./objParser";
import { parsePly } from "./plyParser";
import { parseGltf, type GltfExternalBuffers } from "./gltfParser";
import type { MeshParseFormat } from "./fileRouter";
import { weldTriangleSoup, type WeldedMesh } from "./meshComponents";

/**
 * Parses any of the four dirty-mesh formats into a welded `{positions,
 * indices}` triangle soup, entirely host-side, no WASM — the one place all
 * four formats funnel into it uniformly (`check_mesh_health`,
 * `promote_mesh_to_brep`, fTetWild's tetrahedralization input, and headless
 * meshing input all read it).
 */
export function parseToWeldedMesh(bytes: Uint8Array, format: MeshParseFormat, external?: GltfExternalBuffers): WeldedMesh {
  if (format === "stl") return weldTriangleSoup(parseStl(bytes));
  if (format === "obj") return parseObj(bytes);
  if (format === "gltf") return parseGltf(bytes, external); // already welded internally
  return parsePly(bytes);
}
