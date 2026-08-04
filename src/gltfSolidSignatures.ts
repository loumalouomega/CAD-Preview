/**
 * glTF-side half of "Compare Models" — mirrors `plySolidSignatures.ts`, minus
 * the welding step: unlike OBJ's `f` lines and PLY's `vertex_indices`,
 * `parseGltf` has to weld internally anyway (each primitive and node instance
 * is its own index space — see that module's doc comment), so its output is
 * already a single shared-vertex mesh. Pure, vscode/OCCT-free.
 */

import { parseGltf, type GltfExternalBuffers } from "./gltfParser";
import { connectedComponents, boundsOfTriangles, boundsCenter, boundsDiagonal, volumeOfTriangles } from "./meshComponents";
import type { SolidSignature } from "./modelDiff";

export function extractGltfSolidSignatures(
  bytes: Uint8Array,
  external?: GltfExternalBuffers
): { signatures: SolidSignature[]; diagonal: number } {
  const { positions, indices } = parseGltf(bytes, external);
  const components = connectedComponents(indices);

  const wholeTriangles = Array.from({ length: Math.floor(indices.length / 3) }, (_, i) => i);
  const wholeBounds = boundsOfTriangles(positions, indices, wholeTriangles);
  const diagonal = wholeBounds ? boundsDiagonal(wholeBounds) : 0;

  const signatures: SolidSignature[] = components.map((triangles, i) => {
    const bounds = boundsOfTriangles(positions, indices, triangles)!; // components are never empty
    return {
      id: `solid-${i}`,
      centre: boundsCenter(bounds),
      diagonal: boundsDiagonal(bounds),
      volume: volumeOfTriangles(positions, indices, triangles),
    };
  });

  return { signatures, diagonal };
}
