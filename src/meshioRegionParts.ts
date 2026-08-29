/**
 * Builds `Part[]` from a meshio++-imported document's region correlation
 * (`src/meshioService.ts`'s `convertToStlBoundaryWithRegions`) — the piece
 * that actually turns a region into a selectable/colourable Part, closing
 * the remaining half of roadmap item 7 ("Richer meshio++ import — auto-
 * converting regions into Parts"). Pure and WASM-free (only `parseStl` +
 * `segmentCoplanarFacets`, both already DOM/WASM-free), so it runs
 * identically host-side (`provider.ts`'s `handleMeshio`) and headlessly
 * (`mcpTools.ts`'s `load_model`) — one implementation, not two that could
 * drift.
 *
 * **Ids must match what the webview will actually display.** `node-0` is
 * hardcoded as the volume id because a meshio++ import always produces
 * exactly one root `THREE.Mesh` (the STL boundary `convertToStlBoundary`
 * always yields), and `tagMeshEntities` (`src/webview/main.ts`) assigns that
 * single root id `node-0` by traversal order — verified, not assumed, by
 * `splitMeshesIntoFacets`'s own "Root-is-mesh" branch (`src/webview/
 * meshFacets.ts`). `face-K` ids come from `segmentCoplanarFacets` run
 * region-aware (same algorithm, same triangle order — `parseStl`'s STL
 * parse order — the webview's own facet split reproduces when it's given
 * the SAME `regionAssignment.triangleRegionIndex`, see `protocol.ts`'s
 * `loadMeshBytes` doc comment), so the ids created here resolve to real,
 * highlightable facets in the live 3D view from the very first load.
 *
 * **Degrades to "create nothing" whenever the ids wouldn't be trustworthy**,
 * mirroring `buildMeshFacetGroup`'s own "too few or too many facets, keep
 * the mesh whole" rule (`facetCount <= 1 || > MAX_FACETS`): a single
 * combined facet can't distinguish regions, and an organic/huge facet count
 * means the mesh is kept whole in the webview too (`face-0` for
 * everything), so region-scoped ids would silently not exist there. Empty
 * output is not an error — callers treat it as "nothing to auto-create",
 * same graceful-skip convention as every other unresolved-input path in
 * this codebase.
 */
import * as THREE from "three";
import { parseStl } from "./stlParser";
import { clean } from "./untrustedText";
import { segmentCoplanarFacets, MAX_FACETS, FACET_ANGLE_TOLERANCE } from "./webview/meshFacets";
import { PALETTE } from "./webview/partsModel";
import type { MeshioRegionAssignment } from "./meshioService";
import type { Part } from "./protocol";

const VOLUME_ID = "node-0";

/** Cap applied to region-derived Part names — a region name is document-
 * derived text (attacker-influenced from the MCP caller's point of view), so
 * it goes through `clean()` before it persists into the parts sidecar. */
const MAX_PART_NAME_LENGTH = 100;

/**
 * Builds one `Part` per named region that owns ≥1 facet, assigning that
 * region's facet ids (`node-0/face-K`) as `surfaces`. Returns `[]` (never
 * throws) when the STL/region-assignment pairing doesn't line up, or the
 * region-aware segmentation would collapse to a single/oversized facet set
 * — see this module's doc comment.
 */
export function buildPartsFromMeshioRegions(stlBytes: Uint8Array, regions: MeshioRegionAssignment): Part[] {
  const positions = parseStl(stlBytes);
  const triCount = positions.length / 9;
  if (triCount === 0 || triCount !== regions.triangleRegion.length) return [];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const facetOf = segmentCoplanarFacets(geometry, FACET_ANGLE_TOLERANCE, regions.triangleRegion);
  const facetCount = facetOf.length ? Math.max(...facetOf) + 1 : 0;
  if (facetCount <= 1 || facetCount > MAX_FACETS) return [];

  // Every triangle in a facet shares the same region by construction (that's
  // what the region-aware segmentation guarantees) — one lookup per facet.
  const facetRegion = new Array<number>(facetCount).fill(-1);
  for (let t = 0; t < triCount; t++) facetRegion[facetOf[t]] = regions.triangleRegion[t];

  const surfacesByRegion = new Map<number, string[]>();
  for (let f = 0; f < facetCount; f++) {
    const r = facetRegion[f];
    if (r < 0) continue; // unassigned facet — no Part for "no region"
    const list = surfacesByRegion.get(r);
    const id = `${VOLUME_ID}/face-${f}`;
    if (list) list.push(id); else surfacesByRegion.set(r, [id]);
  }

  const parts: Part[] = [];
  for (const [regionIdx, surfaces] of surfacesByRegion) {
    // The name is document-derived text — clean it (control/format chars
    // stripped, line breaks flattened, truncated) before it persists into
    // the parts sidecar, where MCP-facing responses would resurface it.
    // See src/untrustedText.ts.
    const name = regions.regionNames[regionIdx];
    if (!name) continue;
    const cleanedName = clean(name, MAX_PART_NAME_LENGTH);
    if (!cleanedName) continue;
    parts.push({
      name: cleanedName,
      color: PALETTE[parts.length % PALETTE.length],
      volumes: [],
      surfaces,
      lines: [],
      points: [],
    });
  }
  return parts;
}
