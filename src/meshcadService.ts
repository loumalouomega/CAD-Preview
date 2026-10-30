import { getMeshio, wrapMeshioFault } from "./meshioService";
import { buildMeshCadCall, readCadInfo, summarizeMeshCad, type RawMeshCadResult } from "./meshCadSurface";
import { SIZE_MAX_SENTINEL, type MeshCadStats, type MeshPrismLayers } from "./meshOptions";
import { buildPrismCall, summarizePrismLayers, wedgesToMsh41 } from "./prismLayers";

export type { MeshCadStats };

// meshio++ `meshCadSurface` as a fifth meshing engine
// (`MeshOptions.engine: "meshcad"`): a B-rep's exact faces are triangulated
// WITHOUT a CAD kernel — every edge is sampled once and shared by its faces, so
// neighbouring faces meet node-for-node. It runs on the meshio++ singleton
// (`getMeshio`), so a WASM abort resets THAT kernel through `wrapMeshioFault`
// and no new `Pipeline` function exists. The ASCII MSH 4.1 text built here is
// merged by `gmshService.ts`'s `populateMeshedModel` exactly like fTetWild's
// and the octrees', so every downstream reader works unchanged.
//
// Fixed on purpose (probe `scripts/probe/examples/meshio-meshcad-1721.ts`):
// * The MSH is hand-written ASCII with every cell on the ONE surface entity
//   (dim 2, tag 1) — meshio++'s own `gmsh` writer emits BINARY 4.1 with an
//   8-byte size_t, which Gmsh's 32-bit WASM refuses to read, and an MSH with no
//   `$Entities` only lets `gmsh.merge` create entity 1.
// * `triangle6` / `triangle10` nodes already follow Gmsh's reference order
//   (every edge node sits on the straight edge of a planar face to ~1e-15), so
//   NO permutation is applied.
// * meshio++'s STEP read gives millimetres like host OCCT (bull.stp, declared
//   INCH, has the same bounding box in both), so no unit conversion exists.
// * The edge line block is never requested: a surface mesh's boundary is not a
//   separate entity here.

export interface MeshCadEngineParams {
  /** `MeshOptions.sizeMax`; the {@link SIZE_MAX_SENTINEL} means "unset" and resolves to bbox diagonal / 20. */
  sizeMax: number;
  order: 1 | 2;
  minAngle: number;
  smoothIterations: number;
  curvatureDeviation: number;
  cellsAcrossGaps: number;
  grading: number;
  /** Grow prism layers over the surface (order 1 only); the result is the wedge shell. */
  prismLayers?: MeshPrismLayers;
}

export interface MeshCadEngineResult {
  mshText: string;
  stats: MeshCadStats;
}

/** The `diagonal / 20` seed the panel's size slider uses (`syncMeshSizeSeed`) when Max size is unset. */
export const MESHCAD_AUTO_DIVISOR = 20;

/** meshio++ cell type -> [Gmsh element type, nodes per cell]. */
const SURFACE_CELLS: Record<string, { gmshType: number; nodes: number }> = {
  triangle: { gmshType: 2, nodes: 3 },
  triangle6: { gmshType: 9, nodes: 6 },
  triangle10: { gmshType: 21, nodes: 10 },
};

export interface SurfaceBlock {
  type: string;
  data: ArrayLike<number | bigint>;
}

/**
 * Serializes a surface mesh to ASCII MSH 4.1 — pure, WASM-free. One element
 * block per cell class, ALL on the one surface entity (dim 2, tag 1). Node and
 * element tags are 1-based and sequential across blocks. A block of a type the
 * mesher should never emit (a line block, a volume cell) throws: silently
 * dropping it would hand back a mesh with a hole in it.
 */
export function surfaceToMsh41(points: ArrayLike<number>, blocks: readonly SurfaceBlock[]): string {
  const nodeCount = Math.floor(points.length / 3);
  const used = blocks.filter((b) => b.data.length > 0);
  for (const b of used) {
    if (!SURFACE_CELLS[b.type]) {
      throw new Error(`mesh-cad produced a "${b.type}" block, which a surface mesh should never carry here — refusing to drop it silently.`);
    }
  }
  const lines: string[] = ["$MeshFormat", "4.1 0 8", "$EndMeshFormat", "$Nodes"];
  if (nodeCount > 0) {
    lines.push(`1 ${nodeCount} 1 ${nodeCount}`);
    lines.push(`2 1 0 ${nodeCount}`);
    for (let i = 1; i <= nodeCount; i++) lines.push(String(i));
    for (let i = 0; i < nodeCount; i++) lines.push(`${points[i * 3]} ${points[i * 3 + 1]} ${points[i * 3 + 2]}`);
  } else {
    lines.push("0 0 0 0");
  }
  lines.push("$EndNodes", "$Elements");
  const perBlock = used.map((b) => Math.floor(b.data.length / SURFACE_CELLS[b.type].nodes));
  const total = perBlock.reduce((a, c) => a + c, 0);
  if (total > 0) {
    lines.push(`${used.length} ${total} 1 ${total}`);
    let next = 1;
    used.forEach((b, k) => {
      const { gmshType, nodes } = SURFACE_CELLS[b.type];
      lines.push(`2 1 ${gmshType} ${perBlock[k]}`);
      for (let c = 0; c < perBlock[k]; c++) {
        const row: number[] = [next++];
        // meshio++ ≥ 11.2 hands integer arrays back as BigInt64Array.
        for (let j = 0; j < nodes; j++) row.push(Number(b.data[c * nodes + j]) + 1);
        lines.push(row.join(" "));
      }
    });
  } else {
    lines.push("0 0 0 0");
  }
  lines.push("$EndElements", "");
  return lines.join("\n");
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

/**
 * Runs meshio++'s `meshCadSurface` over the STEP bytes of a B-rep (edits
 * already applied by the caller) and returns the MSH 4.1 text plus the facts
 * the report carries. Throws a plain error for a file with no B-rep side
 * channel, an unresolvable size, a tool-level refusal or an empty result (none
 * of those reset the kernel); a WASM abort resets the meshio++ singleton via
 * `wrapMeshioFault`. A face that cannot be meshed is NOT an error: it is
 * counted in `stats.numFailed` and warned about, and the surface is open there.
 */
export async function meshcadSurfaceMesh(stepBytes: Uint8Array, params: MeshCadEngineParams): Promise<MeshCadEngineResult> {
  const m = await getMeshio();
  const path = "/mce.stp"; // ≤10-char MEMFS path, like every staged meshio++ file
  m.FS.writeFile(path, stepBytes);
  try {
    let targetSize = params.sizeMax;
    if (!(targetSize > 0) || targetSize >= SIZE_MAX_SENTINEL) {
      const skin = m.readMesh(path, "step");
      const diagonal = bboxDiagonal(skin.points as ArrayLike<number>);
      if (!(diagonal > 0)) throw new Error("mesh-cad: the model has no extent to derive a target size from — set an explicit Max size.");
      targetSize = diagonal / MESHCAD_AUTO_DIVISOR;
    }
    const { call, warnings, order } = buildMeshCadCall(
      {
        targetSize,
        edges: false,
        order: params.order,
        ...(params.minAngle > 0 ? { minAngle: params.minAngle } : {}),
        ...(params.smoothIterations > 0 ? { smoothIterations: params.smoothIterations } : {}),
        ...(params.curvatureDeviation > 0 ? { curvatureDeviation: params.curvatureDeviation } : {}),
        ...(params.cellsAcrossGaps > 0 ? { cellsAcrossGaps: params.cellsAcrossGaps } : {}),
        ...(params.grading > 0 ? { grading: params.grading } : {}),
      },
      null
    );
    const info = readCadInfo(m, path, "step");
    const r = m.meshCadSurface(info as never, call as never) as unknown as RawMeshCadResult;
    const report = summarizeMeshCad(r, targetSize, warnings);
    const blocks = r.mesh.cells as SurfaceBlock[];
    if (report.numTriangles === 0 || blocks.every((b) => b.data.length === 0)) {
      throw new Error(
        `mesh-cad produced no triangles (${report.numFailed} of ${report.numFaces} faces failed${report.faces[0] ? `: ${report.faces[0].status} — ${report.faces[0].reason}` : ""}); try a smaller Max size.`
      );
    }
    let prism: ReturnType<typeof summarizePrismLayers> | undefined;
    let mshText: string;
    if (params.prismLayers) {
      if (order !== 1) throw new Error("mesh-cad: prism layers grow over linear triangles — set elementOrder 1.");
      const { call: layerCall, firstHeight, numLayers, growth } = buildPrismCall(params.prismLayers);
      const layered = (m as unknown as { boundaryLayer(mesh: unknown, o: unknown): Record<string, unknown> & { mesh: { points: ArrayLike<number>; cells: SurfaceBlock[] } } }).boundaryLayer(r.mesh, layerCall);
      prism = summarizePrismLayers(layered, { firstHeight, numLayers, growth });
      if (prism.numCells === 0) throw new Error(`mesh-cad: prism layers produced no cells${prism.warnings[0] ? ` (${prism.warnings[0]})` : ""} — the surface must be a closed triangle skin.`);
      mshText = wedgesToMsh41(layered.mesh.points, layered.mesh.cells);
    } else {
      mshText = surfaceToMsh41(r.mesh.points, blocks);
    }
    return {
      mshText,
      stats: {
        targetSize,
        order,
        numFaces: report.numFaces,
        numFailed: report.numFailed,
        numTriangles: report.numTriangles,
        numPoints: report.numPoints,
        numOpenEdges: report.numOpenEdges,
        numNonManifoldEdges: report.numNonManifoldEdges,
        numMisorientedEdges: report.numMisorientedEdges,
        minAngleDeg: report.minAngleDeg,
        maxAngleDeg: report.maxAngleDeg,
        minEdge: report.minEdge,
        maxEdge: report.maxEdge,
        numRefinementPoints: report.numRefinementPoints,
        numFacesBelowBound: report.numFacesBelowBound,
        numSmoothed: report.numSmoothed,
        numCurvedStraightened: report.numCurvedStraightened,
        ...(prism ? { prismLayers: prism } : {}),
        warnings: prism ? [...report.warnings, ...prism.warnings] : report.warnings,
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
