/**
 * PLY-side half of "Compare Models" — mirrors `objSolidSignatures.ts`
 * exactly (PLY's `vertex_indices` are already shared references, same as
 * OBJ's `f` lines, so no welding pass is needed). Pure, vscode/OCCT-free.
 */

import { parsePly } from "./plyParser";
import { connectedComponents, boundsOfTriangles, boundsCenter, boundsDiagonal, volumeOfTriangles } from "./meshComponents";
import type { SolidSignature } from "./modelDiff";

export function extractPlySolidSignatures(bytes: Uint8Array): { signatures: SolidSignature[]; diagonal: number } {
  const { positions, indices } = parsePly(bytes);
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
