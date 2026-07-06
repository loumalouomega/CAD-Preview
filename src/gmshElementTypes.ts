/**
 * The single source of truth for every Gmsh finite-element type this project
 * understands — pure and vscode/WASM-free so it unit-tests headless, mirroring
 * `mdpaWriter.ts`/`editOps.ts`'s "pure logic module" convention.
 *
 * Both the display-overlay builders (`gmshService.ts`'s `appendTriangles2D`/
 * `extractBoundaryFaces`, now thin wrappers over {@link surfaceTriangles}/
 * {@link boundaryTriangles} here) AND the Kratos MDPA extractor
 * (`extractMdpaMesh`) resolve element types through this one table, so the
 * overlay's triangulation and MDPA's connectivity can never drift apart.
 *
 * Gmsh MSH element-type ids (the map keys) and their reference-node local
 * coordinates, node-orderings, and the gmsh→Kratos node-order permutations
 * below were all **verified against the live gmsh-wasm build** via
 * `getElementProperties()` coordinate matching — see `doc/gmsh-integration.md`'s
 * "Element types & node ordering" section for the probe trail. The higher-order
 * hex/prism/pyramid Kratos orderings are matched against transcribed Kratos
 * reference-element coordinates and still want a Kratos-core-dev double-check.
 */

export type MdpaCellKind =
  // volume kinds
  | "tet4"
  | "tet10"
  | "pyramid5"
  | "pyramid13"
  | "prism6"
  | "prism15"
  | "hex8"
  | "hex20"
  | "hex27"
  // surface kinds
  | "tri3"
  | "tri6"
  | "quad4"
  | "quad8"
  | "quad9";

export interface GmshElementTypeInfo {
  /** Gmsh MSH element-type id (the {@link GMSH_ELEMENT_TYPES} key). */
  type: number;
  name: string;
  dim: 2 | 3;
  /** Node stride in `getElements`' flat `nodeTags[t]` array. */
  numNodes: number;
  numCorners: number;
  order: 1 | 2;
  /**
   * dim 3: the cell's boundary faces, each a ring of *corner* local indices
   * (length 3 = triangle, 4 = quad) — winding is irrelevant (the overlay uses
   * `THREE.DoubleSide`), only the corner set (for shared-face dedup) and the
   * ring order (for planar quad triangulation) matter.
   * dim 2: the cell's own corner triangulation (each entry length 3).
   */
  faces: ReadonlyArray<readonly number[]>;
  /** Kratos-side mapping. `permutation` is 0-based gmsh→Kratos and may be
   *  SHORTER than `numNodes` — a complete order-2 prism18/pyramid14/hex27 maps
   *  to Kratos's shorter Prism3D15/Pyramid3D13/Hexahedra3D20 by keeping only
   *  the first N nodes (verified: their leading local coords coincide). */
  mdpa: { kind: MdpaCellKind; permutation: readonly number[] };
}

// --- boundary-face corner rings (gmsh corner ordering) ---
// Every ring is OUTWARD-wound (CCW seen from outside the cell), verified against
// the gmsh reference corner coordinates. Winding is irrelevant to the overlay
// (which uses THREE.DoubleSide) and to the shared-face dedup (which keys on
// *sorted* corners), but a consistent outward winding lets `orientCell` compute
// a reliable signed volume via the divergence theorem.
const TET_FACES = [
  [0, 2, 1],
  [0, 1, 3],
  [1, 2, 3],
  [0, 3, 2],
] as const;
// hex corners: 0-3 bottom (z=-1) CCW, 4-7 top (z=1) CCW.
const HEX_FACES = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
] as const;
// prism corners: 0-2 bottom tri, 3-5 top tri; verticals 0-3,1-4,2-5.
const PRISM_FACES = [
  [0, 2, 1],
  [3, 4, 5],
  [0, 1, 4, 3],
  [1, 2, 5, 4],
  [2, 0, 3, 5],
] as const;
// pyramid corners: 0-3 base quad (z=0), 4 apex.
const PYRAMID_FACES = [
  [0, 3, 2, 1],
  [0, 1, 4],
  [1, 2, 4],
  [2, 3, 4],
  [3, 0, 4],
] as const;
const TRI_TRIANGULATION = [[0, 1, 2]] as const;
const QUAD_TRIANGULATION = [
  [0, 1, 2],
  [0, 2, 3],
] as const;

const IDENTITY = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

// Verified permutations (P1b coordinate match). See PROBE_FINDINGS / doc.
const PERM_TET10 = [0, 1, 2, 3, 4, 5, 6, 7, 9, 8];
const PERM_HEX20 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 13, 9, 10, 12, 14, 15, 16, 18, 19, 17];
const PERM_HEX27 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 13, 9, 10, 12, 14, 15, 16, 18, 19, 17, 20, 21, 23, 24, 22, 25, 26];
const PERM_PRISM15 = [0, 1, 2, 3, 4, 5, 6, 9, 7, 8, 10, 11, 12, 14, 13];
const PERM_PYRAMID13 = [0, 1, 2, 3, 4, 5, 8, 10, 6, 7, 9, 11, 12];

export const GMSH_ELEMENT_TYPES: ReadonlyMap<number, GmshElementTypeInfo> = new Map([
  // --- surface elements ---
  [2, { type: 2, name: "tri3", dim: 2, numNodes: 3, numCorners: 3, order: 1, faces: TRI_TRIANGULATION, mdpa: { kind: "tri3", permutation: IDENTITY(3) } }],
  [9, { type: 9, name: "tri6", dim: 2, numNodes: 6, numCorners: 3, order: 2, faces: TRI_TRIANGULATION, mdpa: { kind: "tri6", permutation: IDENTITY(6) } }],
  [3, { type: 3, name: "quad4", dim: 2, numNodes: 4, numCorners: 4, order: 1, faces: QUAD_TRIANGULATION, mdpa: { kind: "quad4", permutation: IDENTITY(4) } }],
  [16, { type: 16, name: "quad8", dim: 2, numNodes: 8, numCorners: 4, order: 2, faces: QUAD_TRIANGULATION, mdpa: { kind: "quad8", permutation: IDENTITY(8) } }],
  [10, { type: 10, name: "quad9", dim: 2, numNodes: 9, numCorners: 4, order: 2, faces: QUAD_TRIANGULATION, mdpa: { kind: "quad9", permutation: IDENTITY(9) } }],
  // --- volume elements ---
  [4, { type: 4, name: "tet4", dim: 3, numNodes: 4, numCorners: 4, order: 1, faces: TET_FACES, mdpa: { kind: "tet4", permutation: IDENTITY(4) } }],
  [11, { type: 11, name: "tet10", dim: 3, numNodes: 10, numCorners: 4, order: 2, faces: TET_FACES, mdpa: { kind: "tet10", permutation: PERM_TET10 } }],
  [5, { type: 5, name: "hex8", dim: 3, numNodes: 8, numCorners: 8, order: 1, faces: HEX_FACES, mdpa: { kind: "hex8", permutation: IDENTITY(8) } }],
  [17, { type: 17, name: "hex20", dim: 3, numNodes: 20, numCorners: 8, order: 2, faces: HEX_FACES, mdpa: { kind: "hex20", permutation: PERM_HEX20 } }],
  [12, { type: 12, name: "hex27", dim: 3, numNodes: 27, numCorners: 8, order: 2, faces: HEX_FACES, mdpa: { kind: "hex27", permutation: PERM_HEX27 } }],
  [6, { type: 6, name: "prism6", dim: 3, numNodes: 6, numCorners: 6, order: 1, faces: PRISM_FACES, mdpa: { kind: "prism6", permutation: IDENTITY(6) } }],
  // complete order-2 prism (18 nodes) → Kratos Prism3D15 (first 15 nodes)
  [18, { type: 18, name: "prism15", dim: 3, numNodes: 15, numCorners: 6, order: 2, faces: PRISM_FACES, mdpa: { kind: "prism15", permutation: PERM_PRISM15 } }],
  [13, { type: 13, name: "prism18", dim: 3, numNodes: 18, numCorners: 6, order: 2, faces: PRISM_FACES, mdpa: { kind: "prism15", permutation: PERM_PRISM15 } }],
  [7, { type: 7, name: "pyramid5", dim: 3, numNodes: 5, numCorners: 5, order: 1, faces: PYRAMID_FACES, mdpa: { kind: "pyramid5", permutation: IDENTITY(5) } }],
  [19, { type: 19, name: "pyramid13", dim: 3, numNodes: 13, numCorners: 5, order: 2, faces: PYRAMID_FACES, mdpa: { kind: "pyramid13", permutation: PERM_PYRAMID13 } }],
  // complete order-2 pyramid (14 nodes) → Kratos Pyramid3D13 (first 13 nodes)
  [14, { type: 14, name: "pyramid14", dim: 3, numNodes: 14, numCorners: 5, order: 2, faces: PYRAMID_FACES, mdpa: { kind: "pyramid13", permutation: PERM_PYRAMID13 } }],
]);

export interface MdpaKindInfo {
  numNodes: number;
  numCorners: number;
  /** Kratos `Element` name for "elements" mode (volume kinds); null = surface. */
  elementName: string | null;
  /** Kratos `Condition` name for "elements" mode (surface kinds); null = volume. */
  conditionName: string | null;
  /** Kratos `Geometry` name for "geometries" mode — always known/certain. */
  geometryName: string;
}

export const MDPA_KIND_INFO: Readonly<Record<MdpaCellKind, MdpaKindInfo>> = {
  // volume kinds
  tet4: { numNodes: 4, numCorners: 4, elementName: "Element3D4N", conditionName: null, geometryName: "Tetrahedra3D4" },
  tet10: { numNodes: 10, numCorners: 4, elementName: "Element3D10N", conditionName: null, geometryName: "Tetrahedra3D10" },
  pyramid5: { numNodes: 5, numCorners: 5, elementName: "Element3D5N", conditionName: null, geometryName: "Pyramid3D5" },
  pyramid13: { numNodes: 13, numCorners: 5, elementName: "Element3D13N", conditionName: null, geometryName: "Pyramid3D13" },
  prism6: { numNodes: 6, numCorners: 6, elementName: "Element3D6N", conditionName: null, geometryName: "Prism3D6" },
  prism15: { numNodes: 15, numCorners: 6, elementName: "Element3D15N", conditionName: null, geometryName: "Prism3D15" },
  hex8: { numNodes: 8, numCorners: 8, elementName: "Element3D8N", conditionName: null, geometryName: "Hexahedra3D8" },
  hex20: { numNodes: 20, numCorners: 8, elementName: "Element3D20N", conditionName: null, geometryName: "Hexahedra3D20" },
  hex27: { numNodes: 27, numCorners: 8, elementName: "Element3D27N", conditionName: null, geometryName: "Hexahedra3D27" },
  // surface kinds
  tri3: { numNodes: 3, numCorners: 3, elementName: null, conditionName: "SurfaceCondition3D3N", geometryName: "Triangle3D3" },
  tri6: { numNodes: 6, numCorners: 3, elementName: null, conditionName: "SurfaceCondition3D6N", geometryName: "Triangle3D6" },
  quad4: { numNodes: 4, numCorners: 4, elementName: null, conditionName: "SurfaceCondition3D4N", geometryName: "Quadrilateral3D4" },
  quad8: { numNodes: 8, numCorners: 4, elementName: null, conditionName: "SurfaceCondition3D8N", geometryName: "Quadrilateral3D8" },
  quad9: { numNodes: 9, numCorners: 4, elementName: null, conditionName: "SurfaceCondition3D9N", geometryName: "Quadrilateral3D9" },
};

/** Canonical deterministic block order for MDPA output (see `mdpaWriter.ts`). */
export const VOLUME_KIND_ORDER: readonly MdpaCellKind[] = [
  "tet4",
  "tet10",
  "pyramid5",
  "pyramid13",
  "prism6",
  "prism15",
  "hex8",
  "hex20",
  "hex27",
];
export const SURFACE_KIND_ORDER: readonly MdpaCellKind[] = ["tri3", "tri6", "quad4", "quad8", "quad9"];

const FAMILY_FACES: Record<string, ReadonlyArray<readonly number[]>> = {
  tet: TET_FACES,
  hex: HEX_FACES,
  prism: PRISM_FACES,
  pyramid: PYRAMID_FACES,
};
const KIND_FAMILY: Record<MdpaCellKind, keyof typeof FAMILY_FACES | null> = {
  tet4: "tet",
  tet10: "tet",
  hex8: "hex",
  hex20: "hex",
  hex27: "hex",
  prism6: "prism",
  prism15: "prism",
  pyramid5: "pyramid",
  pyramid13: "pyramid",
  tri3: null,
  tri6: null,
  quad4: null,
  quad8: null,
  quad9: null,
};

/**
 * Signed volume of a cell from its first-`numCorners` corner coordinates (in
 * Kratos node order — which keeps the corner block identical to gmsh's), via
 * the divergence theorem over the kind's OUTWARD-wound boundary faces. Positive
 * for a correctly-oriented cell, negative for an inverted one. Surface kinds
 * (no volume) return 0. Used by `mdpaWriter.ts`'s `orientCell` backstop.
 */
export function signedVolume(kind: MdpaCellKind, corners: ReadonlyArray<{ x: number; y: number; z: number }>): number {
  const family = KIND_FAMILY[kind];
  if (!family) return 0;
  let v = 0;
  for (const face of FAMILY_FACES[family]) {
    for (let i = 1; i < face.length - 1; i++) {
      const a = corners[face[0]];
      const b = corners[face[i]];
      const c = corners[face[i + 1]];
      // a · (b × c)
      v +=
        a.x * (b.y * c.z - b.z * c.y) +
        a.y * (b.z * c.x - b.x * c.z) +
        a.z * (b.x * c.y - b.y * c.x);
    }
  }
  return v / 6;
}

/** getElements()-shaped input: parallel `elementTypes[t]` / `nodeTags[t]` arrays. */
export interface GmshElementsResult {
  elementTypes: number[];
  nodeTags: number[][];
}

/**
 * Surface triangulation: for every 2D element in `els`, emits its corner
 * triangles' compacted position indices (via `tagToIndex`) onto a flat buffer.
 * Order-2 elements contribute their corner triangulation only (mid-side nodes
 * ignored — the overlay shows corner geometry). Unknown / non-2D types are
 * skipped (graceful degradation).
 */
export function surfaceTriangles(els: GmshElementsResult, tagToIndex: Map<number, number>): number[] {
  const out: number[] = [];
  for (let t = 0; t < els.elementTypes.length; t++) {
    const info = GMSH_ELEMENT_TYPES.get(els.elementTypes[t]);
    if (!info || info.dim !== 2) continue;
    const tags = els.nodeTags[t];
    for (let base = 0; base + info.numNodes <= tags.length; base += info.numNodes) {
      for (const tri of info.faces) {
        for (const c of tri) out.push(tagToIndex.get(tags[base + c]) ?? 0);
      }
    }
  }
  return out;
}

/**
 * Boundary triangulation of a volume mesh: enumerates every 3D element's
 * boundary faces (as *corner*-tag rings), keys each by its sorted corner tags
 * (mid-side nodes excluded — so order-1/order-2 faces dedup identically, and a
 * triangular face can never collide with a quad face), keeps faces seen exactly
 * once (interior faces, shared by two cells, cancel), then triangulates each
 * kept face (triangle → 1, quad → 2) into compacted position indices. A quad
 * face shared by e.g. a hex and an adjacent pyramid dedups correctly (same 4
 * corners). Unknown / non-3D types are skipped.
 */
export function boundaryTriangles(els: GmshElementsResult, tagToIndex: Map<number, number>): number[] {
  // key (sorted corner tags) -> { ring (original corner tags), count }
  const faceMap = new Map<string, { ring: number[]; count: number }>();
  for (let t = 0; t < els.elementTypes.length; t++) {
    const info = GMSH_ELEMENT_TYPES.get(els.elementTypes[t]);
    if (!info || info.dim !== 3) continue;
    const tags = els.nodeTags[t];
    for (let base = 0; base + info.numNodes <= tags.length; base += info.numNodes) {
      for (const face of info.faces) {
        const ring = face.map((c) => tags[base + c]);
        const key = [...ring].sort((a, b) => a - b).join("_");
        const existing = faceMap.get(key);
        if (existing) existing.count++;
        else faceMap.set(key, { ring, count: 1 });
      }
    }
  }

  const out: number[] = [];
  for (const { ring, count } of faceMap.values()) {
    if (count !== 1) continue;
    const tris = ring.length === 3 ? TRI_TRIANGULATION : QUAD_TRIANGULATION;
    for (const tri of tris) {
      for (const c of tri) out.push(tagToIndex.get(ring[c]) ?? 0);
    }
  }
  return out;
}
