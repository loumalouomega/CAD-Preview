/**
 * STL-side half of "Compare Models" — resolves an STL file's connected
 * components ("solids", in the same sense `collectSolids` walks a B-rep
 * shape's `TopAbs_SOLID`s) into `SolidSignature[]` for `modelDiff.ts`'s pure
 * matcher, the mesh-format sibling of `modelDiffHost.ts`'s OCCT-side
 * extraction. Pure, vscode/OCCT-free — `stlParser.ts` + `meshComponents.ts`
 * do all the real work; this module just wires them together and shapes the
 * result to match what `compareModels()` needs from either side.
 */

import { parseStl } from "./stlParser";
import { weldTriangleSoup, connectedComponents, boundsOfTriangles, boundsCenter, boundsDiagonal, volumeOfTriangles } from "./meshComponents";
import type { SolidSignature } from "./modelDiff";

export function extractStlSolidSignatures(bytes: Uint8Array): { signatures: SolidSignature[]; diagonal: number } {
  const soup = parseStl(bytes);
  const { positions, indices } = weldTriangleSoup(soup);
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
