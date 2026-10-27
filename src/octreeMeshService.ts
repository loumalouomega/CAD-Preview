import { getMeshio, wrapMeshioFault } from "./meshioService";
import { octreeToMsh41, type OctreeBlock } from "./octreeService";
import type { OctreeMeshOutput, OctreeMeshStats } from "./meshOptions";

export type { OctreeMeshStats };

// meshio++ 17.13 `octreeMesh` as a fourth volume engine
// (`MeshOptions.engine: "octreemesh"`): a tessellated skin goes in, a
// conforming graded tetrahedral mesh fitted to it (`output: "tet"`, stuffing)
// or an all-hexahedra mesh (`output: "hex"`, the octree dual) comes out. It is
// a separate operation from `octree` (`octreeService.ts`, the hex-dominant
// templates mesher) with an OPTIONS OBJECT instead of a positional call. It
// runs on the meshio++ singleton, so a WASM abort resets THAT kernel through
// `wrapMeshioFault` and no new `Pipeline` function exists. The MSH 4.1 text is
// built by `octreeToMsh41` and merged by `gmshService.ts`'s
// `populateMeshedModel` exactly like fTetWild's and the octree's.
//
// Fixed on purpose (probe `scripts/probe/examples/meshio-octreemesh.ts`):
// `castellated` is NOT offered — it carries hanging nodes and surrogate
// boundary faces, so it is not a conforming mesh for any downstream reader
// (the hanging nodes WITH constraints are `engine: "octree"`'s `hanging`
// transition, `hangingConstraints.ts`).
// meshio++'s own sizing default is far too fine (a 10 mm cube → 516 432 tets
// in 33 s; all-hex block.stp → `std::bad_alloc`), so the sizes are always
// derived here from the skin's bounding box and the cell caps always passed.

export interface OctreeMeshParams {
  output: OctreeMeshOutput;
  /** Largest leaf edge in mm; 0 = automatic (see {@link octreeMeshSizes}). */
  maxSize: number;
  /** Refinement levels below `maxSize` (smallest leaf = maxSize / 2^levels). */
  levels: number;
}

/** Leaf-count and output-cell ceilings handed to meshio++ so an over-fine
 * request ends in its plain "more leaves than maxCells" error, not an OOM. */
export const OCTREE_MESH_MAX_LEAVES = 2_000_000;
export const OCTREE_MESH_MAX_CELLS = 4_000_000;

/** One eighth of the bounding-box diagonal: the automatic `maxSize`. */
export const OCTREE_MESH_AUTO_DIVISOR = 8;

/** Pure: the leaf-size bounds for a skin whose bbox diagonal is `diagonal`. */
export function octreeMeshSizes(diagonal: number, maxSize: number, levels: number): { maxSize: number; minSize: number } {
  const resolved = maxSize > 0 ? maxSize : diagonal / OCTREE_MESH_AUTO_DIVISOR;
  return { maxSize: resolved, minSize: resolved / Math.pow(2, levels) };
}

export interface OctreeMeshResult {
  mshText: string;
  stats: OctreeMeshStats;
}

const CELL_TYPE: Record<OctreeMeshOutput, string> = { tet: "tetra", hex: "hexahedron" };

function bboxDiagonal(points: ArrayLike<number>): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < points.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = points[i + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  const d = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  return Number.isFinite(d) ? d : 0;
}

/**
 * Runs meshio++'s `octreeMesh` over an STL skin and returns the MSH 4.1 text
 * plus the facts the report carries. Throws a plain error for an empty or
 * degenerate skin, a tree beyond `OCTREE_MESH_MAX_LEAVES` or an output beyond
 * `OCTREE_MESH_MAX_CELLS` (none of those reset the kernel); a WASM abort resets
 * the meshio++ singleton via `wrapMeshioFault`.
 */
export async function octreeMeshVolume(stlBytes: Uint8Array, params: OctreeMeshParams): Promise<OctreeMeshResult> {
  const m = await getMeshio();
  const path = "/ocm.stl"; // ≤10-char MEMFS path, like every staged meshio++ file
  m.FS.writeFile(path, stlBytes);
  try {
    const skin = m.readMesh(path, "stl");
    const diagonal = bboxDiagonal(skin.points as ArrayLike<number>);
    if (!(diagonal > 0)) throw new Error("octree-mesh: the skin is empty or degenerate.");
    const { maxSize, minSize } = octreeMeshSizes(diagonal, params.maxSize, params.levels);
    const r = m.octreeMesh(skin, {
      output: params.output,
      maxSize,
      minSize,
      maxCells: OCTREE_MESH_MAX_LEAVES,
      maxTets: OCTREE_MESH_MAX_CELLS,
    });
    const wanted = CELL_TYPE[params.output];
    const blocks = (r.mesh.cells as OctreeBlock[]).filter((b) => b.type === wanted);
    if (blocks.every((b) => b.data.length === 0)) {
      throw new Error(
        "octree-mesh produced no cells — the skin may be open or smaller than one leaf at this size; lower octreeMeshMaxSize / raise octreeMeshLevels or check the mesh's health."
      );
    }
    return {
      mshText: octreeToMsh41(r.mesh.points as ArrayLike<number>, blocks),
      stats: {
        output: params.output,
        maxSize,
        minSize,
        numLeaves: r.numLeaves,
        numTetrahedra: r.numTetrahedra,
        numHexahedra: r.numHexahedra,
        numInverted: r.numInverted,
        minDihedral: r.minDihedral,
        maxDihedral: r.maxDihedral,
        minScaledJacobian: r.minScaledJacobian,
        hausdorffToSkin: r.hausdorffToSkin,
        numFeatureChains: r.numFeatureChains,
        numFeatureChainsMissed: r.numFeatureChainsMissed,
        numWarpRefused: r.numWarpRefused,
        warnings: [...r.warnings],
      },
    };
  } catch (err) {
    throw wrapMeshioFault(err);
  } finally {
    try {
      m.FS.unlink(path);
    } catch {
      /* ignore */
    }
  }
}
