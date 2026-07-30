/**
 * OBJ-side half of "Compare Models" — mirrors `stlSolidSignatures.ts`
 * exactly, just fed `objParser.ts`'s already-indexed output instead of
 * `stlParser.ts`'s unindexed triangle soup (so no `weldTriangleSoup()` pass
 * is needed here — OBJ's `f` lines already share vertex indices natively).
 * Pure, vscode/OCCT-free.
 */

import { parseObj } from "./objParser";
import { connectedComponents, boundsOfTriangles, boundsCenter, boundsDiagonal, volumeOfTriangles } from "./meshComponents";
import type { SolidSignature } from "./modelDiff";

export function extractObjSolidSignatures(bytes: Uint8Array): { signatures: SolidSignature[]; diagonal: number } {
  const { positions, indices } = parseObj(bytes);
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
