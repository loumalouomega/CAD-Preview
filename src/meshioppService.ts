import { getMeshio, wrapMeshioFault } from "./meshioService";
import { MESHCAD_AUTO_DIVISOR, meshcadSurfaceData } from "./meshcadService";
import { octreeMeshRawFromSkin, type OctreeSkin } from "./octreeMeshService";
import { octreeToMsh41, type OctreeBlock } from "./octreeService";
import { SIZE_MAX_SENTINEL, type MeshioppStats, type MeshioppSurfaceStats } from "./meshOptions";

// meshio++ 20.1 as a full volume engine (`MeshOptions.engine: "meshiopp"`):
// exact B-rep surface (or a mesh-format skin) -> octree tets -> `adaptVolume`.
// The surface stage is `meshCadSurface` for a B-rep (the same kernel-free exact
// faces the `meshcad` engine uses) and the source's own skin for a mesh source;
// the octree stage is the `octreemesh` engine's, called in memory; the final
// stage is the 20.1 graded remesher, which coarsens the interior towards
// `sizeMax × 2^levels` while holding the boundary within its Hausdorff bound.
//
// Fixes and defaults, measured (probe `scripts/probe/examples/meshiopp-engine.ts`):
// * `minSize` is the FINEST size (`sizeMax`, or bbox diagonal / 20), `maxSize`
//   the coarsest (`minSize × 2^levels`). The octree therefore starts graded and
//   `adaptVolume` only improves/coarsens it — its `hmin`/`hmax` match those two
//   sizes exactly.
// * `hgrad` reuses `meshcadGrading` when above 1, else upstream's 1.3.
// * `hausd` is left to meshio++ (1e-3 of the diagonal) so the octree's own
//   boundary is held, not the CAD skin (the octree already measured its
//   `hausdorffToSkin`).
// * The closure gate is the B-rep surface report: a failed face or any
//   open/non-manifold/misoriented edge is refused by name. A mesh-format skin
//   is gated on the same edge counts computed from its triangles.
// * Parts, physical groups and periodic faces are never preserved.

export interface MeshioppParams {
  /** `MeshOptions.sizeMax`: target/finest edge length; 0 or the sentinel means bbox diagonal / 20. */
  sizeMax: number;
  /** `MeshOptions.octreeMeshLevels`: coarsest size = finest × 2^levels. */
  levels: number;
  /** Surface sizing shared with the `meshcad` engine. */
  minAngle: number;
  smoothIterations: number;
  curvatureDeviation: number;
  cellsAcrossGaps: number;
  grading: number;
  /** `adaptVolume` iteration cap; 0/undefined = upstream's 10. */
  maxIterations?: number;
}

export type MeshioppInput =
  | { kind: "brep"; stepBytes: Uint8Array }
  | { kind: "mesh"; stlBytes: Uint8Array };

export interface MeshioppResult {
  mshText: string;
  stats: MeshioppStats;
}

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

/** Resolves the target size the same way the `meshcad` engine does. */
function resolveTarget(points: ArrayLike<number>, sizeMax: number): number {
  if (sizeMax > 0 && sizeMax < SIZE_MAX_SENTINEL) return sizeMax;
  const diagonal = bboxDiagonal(points);
  if (!(diagonal > 0)) {
    throw new Error("meshiopp: the model has no extent to derive a target size from — set an explicit Max size.");
  }
  return diagonal / MESHCAD_AUTO_DIVISOR;
}

export interface SkinTopology {
  numTriangles: number;
  numOpenEdges: number;
  numNonManifoldEdges: number;
  numMisorientedEdges: number;
}

/**
 * Counts a triangle skin's edge closure. Vertices are shared by exact
 * coordinate (an STL's repeated vertices weld losslessly), then every edge
 * counts its incident triangles; two incident triangles that traverse it in
 * the same direction make it misoriented. Pure — no WASM.
 */
export function skinTopology(points: ArrayLike<number>, blocks: ReadonlyArray<{ type: string; data: ArrayLike<number | bigint> }>): SkinTopology {
  const vertexIndex = new Map<string, number>();
  const canonical = (i: number): number => {
    const key = `${points[i * 3]}\u0000${points[i * 3 + 1]}\u0000${points[i * 3 + 2]}`;
    const found = vertexIndex.get(key);
    if (found !== undefined) return found;
    const id = vertexIndex.size;
    vertexIndex.set(key, id);
    return id;
  };
  const edges = new Map<string, { count: number; sign: number }>();
  let numTriangles = 0;
  for (const block of blocks) {
    if (block.type !== "triangle") continue;
    const count = Math.floor(block.data.length / 3);
    numTriangles += count;
    for (let t = 0; t < count; t++) {
      const a = canonical(Number(block.data[t * 3]));
      const b = canonical(Number(block.data[t * 3 + 1]));
      const c = canonical(Number(block.data[t * 3 + 2]));
      for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
        const key = u < v ? `${u}:${v}` : `${v}:${u}`;
        const sign = u < v ? 1 : -1;
        const edge = edges.get(key);
        if (!edge) {
          edges.set(key, { count: 1, sign });
        } else {
          if (edge.count === 1 && edge.sign === sign) edge.count = -2; // misoriented marker
          else if (edge.count === -2) edge.count = 3;
          else if (edge.count < 0) edge.count = 3;
          else edge.count++;
        }
      }
    }
  }
  let numOpenEdges = 0;
  let numNonManifoldEdges = 0;
  let numMisorientedEdges = 0;
  for (const edge of edges.values()) {
    if (edge.count === 1) numOpenEdges++;
    else if (edge.count === -2) numMisorientedEdges++;
    else if (edge.count > 2) numNonManifoldEdges++;
  }
  return { numTriangles, numOpenEdges, numNonManifoldEdges, numMisorientedEdges };
}

/**
 * Runs the whole meshio++ volume chain and returns the adapted tets as ASCII
 * MSH 4.1 plus the facts. Plain errors (a non-closed surface, no tets, a tool
 * refusal) do not reset the kernel; a WASM abort resets the meshio++ singleton
 * via `wrapMeshioFault`.
 */
export async function meshioppVolume(input: MeshioppInput, params: MeshioppParams): Promise<MeshioppResult> {
  let skin: OctreeSkin;
  let surface: MeshioppSurfaceStats;
  let targetSize: number;

  if (input.kind === "brep") {
    const data = await meshcadSurfaceData(input.stepBytes, {
      sizeMax: params.sizeMax,
      order: 1,
      minAngle: params.minAngle,
      smoothIterations: params.smoothIterations,
      curvatureDeviation: params.curvatureDeviation,
      cellsAcrossGaps: params.cellsAcrossGaps,
      grading: params.grading,
    });
    targetSize = data.targetSize;
    // `dim` is what meshio++'s own validators read; an embind Mesh carries it,
    // a plain reconstructed object must set it explicitly.
    skin = { points: data.points, cells: data.blocks, dim: 3 };
    surface = {
      source: "brep",
      targetSize,
      numTriangles: data.report.numTriangles,
      numPoints: data.report.numPoints,
      numFaces: data.report.numFaces,
      numFailed: data.report.numFailed,
      numOpenEdges: data.report.numOpenEdges,
      numNonManifoldEdges: data.report.numNonManifoldEdges,
      numMisorientedEdges: data.report.numMisorientedEdges,
      minAngleDeg: data.report.minAngleDeg,
      maxAngleDeg: data.report.maxAngleDeg,
      warnings: data.warnings,
    };
  } else {
    const m = await getMeshio();
    const path = "/mpp.stl"; // ≤10-char MEMFS path, like every staged meshio++ file
    m.FS.writeFile(path, input.stlBytes);
    try {
      skin = m.readMesh(path, "stl") as unknown as OctreeSkin;
    } catch (err) {
      throw wrapMeshioFault(err);
    } finally {
      try {
        m.FS.unlink(path);
      } catch {
        /* ignore */
      }
    }
    targetSize = resolveTarget(skin.points, params.sizeMax);
    const topo = skinTopology(skin.points, skin.cells);
    surface = {
      source: "mesh",
      targetSize,
      numTriangles: topo.numTriangles,
      numPoints: Math.floor(skin.points.length / 3),
      numOpenEdges: topo.numOpenEdges,
      numNonManifoldEdges: topo.numNonManifoldEdges,
      numMisorientedEdges: topo.numMisorientedEdges,
      warnings: [],
    };
  }

  const failed = surface.numFailed ?? 0;
  const open = surface.numOpenEdges ?? 0;
  const nonManifold = surface.numNonManifoldEdges ?? 0;
  const misoriented = surface.numMisorientedEdges ?? 0;
  if (failed > 0 || open > 0 || nonManifold > 0 || misoriented > 0) {
    const faces = failed > 0 ? `${failed} face(s) failed` : null;
    const edges = `${open} open / ${nonManifold} non-manifold / ${misoriented} misoriented surface edge(s)`;
    throw new Error(
      `engine "meshiopp" needs a closed, consistently wound surface to fill a volume (${[faces, edges].filter(Boolean).join("; ")}). ` +
        `Repair the source or switch to engine "gmsh"${surface.source === "mesh" ? ' or "ftetwild"' : ""}.`
    );
  }

  const coarseSize = targetSize * Math.pow(2, params.levels);
  const octree = await octreeMeshRawFromSkin(skin, {
    output: "tet",
    maxSize: coarseSize,
    minSize: targetSize,
    levels: params.levels,
  });

  const m = await getMeshio();
  const tets = (octree.mesh.cells as OctreeBlock[]).filter((b) => b.type === "tetra" && b.data.length > 0);
  if (tets.length === 0) {
    throw new Error('engine "meshiopp": the octree produced no tetrahedra to adapt — try a smaller Max size.');
  }
  let adapted: ReturnType<typeof m.adaptVolume>;
  try {
    // A clean mesh (points + tetra cells + dim): the octree's own cell_data
    // (octree:level, octree_mesh:shape) has no meaning after remeshing and
    // adaptVolume would only warn that it dropped it.
    adapted = m.adaptVolume(
      { points: octree.mesh.points, dim: 3, cells: tets } as never,
      {
        hmin: targetSize,
        hmax: coarseSize,
        hgrad: params.grading > 1 ? params.grading : 1.3,
        maxIterations: params.maxIterations !== undefined && params.maxIterations > 0 ? Math.floor(params.maxIterations) : 10,
        boundarySizing: "input",
      }
    );
  } catch (err) {
    throw wrapMeshioFault(err);
  }
  const outTets = (adapted.mesh.cells as OctreeBlock[]).filter((b) => b.type === "tetra" && b.data.length > 0);
  if (outTets.length === 0) {
    throw new Error('engine "meshiopp": adaptation produced no tetrahedra — try a different Max size or fewer Levels.');
  }

  const rejected =
    adapted.numRejectedByLink +
    adapted.numRejectedByInversion +
    adapted.numRejectedByQuality +
    adapted.numRejectedByLength +
    adapted.numRejectedByClass +
    adapted.numRejectedByHausdorff +
    adapted.numRejectedByNormal;

  return {
    mshText: octreeToMsh41(adapted.mesh.points as ArrayLike<number>, outTets),
    stats: {
      targetSize,
      coarseSize,
      levels: params.levels,
      surface,
      numTetrahedraBefore: octree.stats.numTetrahedra,
      numTetrahedraAfter: outTets.reduce((n, b) => n + Math.floor(b.data.length / 4), 0),
      numPointsBefore: Math.floor(octree.mesh.points.length / 3),
      numPointsAfter: Math.floor(adapted.mesh.points.length / 3),
      minDihedralBefore: adapted.minDihedralBefore,
      minDihedralAfter: adapted.minDihedralAfter,
      maxDihedralAfter: adapted.maxDihedralAfter,
      meanQualityBefore: adapted.meanQualityBefore,
      meanQualityAfter: adapted.meanQualityAfter,
      maxBoundaryDeviation: adapted.maxBoundaryDeviation,
      hausdorff: adapted.hausd,
      numCollapsed: adapted.numCollapsed,
      numSplit: adapted.numSplit,
      numSwapped: adapted.numSwapped,
      numSmoothed: adapted.numSmoothed,
      numRejected: rejected,
      iterations: adapted.iterations,
      warnings: [...surface.warnings, ...octree.stats.warnings, ...adapted.warnings],
    },
  };
}
