/**
 * Whole-surface segmentation into smooth patches plus per-patch primitive
 * fitting, via meshio++ `segment` + `fitPrimitives` (`segment_mesh_surface`).
 *
 * **Facts only.** Every patch is published with its fit type, residuals and raw
 * parameters; nothing is stored and no verdict is drawn. Complements
 * `fitMeshRegion` (one region grown from a user seed, pure TypeScript) — this
 * covers the whole surface in one call.
 *
 * Fits are VERTEX-based and `types` selects the allowed subset, not a priority
 * order: a cylinder whose only vertices are two end rings also lies on a sphere
 * and is reported as one unless `types` omits "sphere".
 */

import { getMeshio, componentMesh, wrapMeshioFault } from "./meshioService";
import { parseToWeldedMesh } from "./meshHeal";
import type { GltfExternalBuffers } from "./gltfParser";
import type { MeshParseFormat } from "./fileRouter";

export const FIT_PRIMITIVE_TYPES = ["plane", "sphere", "cylinder", "cone", "torus"] as const;
export type FitPrimitiveType = (typeof FIT_PRIMITIVE_TYPES)[number];

export interface SegmentMeshOptions {
  /** Dihedral angle (degrees) above which an edge bounds a patch. Default 30. */
  featureAngle?: number;
  /** Patches smaller than this many triangles are merged into a neighbour. Default 1. */
  minPatchCells?: number;
  /** Fit tolerance; relative to the patch size unless `absoluteTolerance`. Default 0.01 relative. */
  tolerance?: number;
  absoluteTolerance?: boolean;
  /** Fraction of a patch's vertices that must lie within tolerance. Default 0.9. */
  minInlierFraction?: number;
  /** Primitive kinds a patch may be fitted with. Default all five. */
  types?: FitPrimitiveType[];
  /** Cap on patches listed in `patches`; the true count stays in `numPatches`. Default 200. */
  maxPatches?: number;
}

export interface SegmentPatch {
  patch: number;
  triangleCount: number;
  /** "none" when no allowed primitive fitted. */
  fitType: FitPrimitiveType | "none";
  rms: number | null;
  max: number | null;
  /** Fraction of the patch's vertices within tolerance. */
  inlierFraction: number | null;
  /** Raw meshio++ parameter row (10 values). plane: point(3), normal(3); sphere: centre(3), radius at [6]; cylinder: point(3), axis(3), radius at [6]. */
  params: number[];
}

export interface SegmentMeshReport {
  numPatches: number;
  numMerged: number;
  numFeatureEdges: number;
  numBoundaryEdges: number;
  numNonManifoldEdges: number;
  fitCounts: Record<FitPrimitiveType | "unfitted", number>;
  patches: SegmentPatch[];
  /** Pairs of adjacent patches and their shared edge count. */
  adjacency: Array<{ a: number; b: number; sharedEdges: number }>;
  truncated: boolean;
  warnings: string[];
}

// meshio++ `fit:patch_type` codes, in `fitPrimitives`' documented order (0 = none).
const TYPE_BY_CODE: Array<FitPrimitiveType | "none"> = ["none", "plane", "sphere", "cylinder", "cone", "torus"];
const PARAMS_WIDTH = 10;

function toNumbers(a: ArrayLike<number | bigint> | undefined): number[] {
  return a ? Array.from(a as ArrayLike<number | bigint>, (v) => Number(v)) : [];
}

export async function segmentMeshSurface(
  bytes: Uint8Array,
  format: MeshParseFormat,
  options: SegmentMeshOptions = {},
  external?: GltfExternalBuffers
): Promise<SegmentMeshReport> {
  const featureAngle = options.featureAngle ?? 30;
  if (!(Number.isFinite(featureAngle) && featureAngle >= 0 && featureAngle <= 180)) {
    throw new Error(`featureAngle must be within 0..180 degrees (got ${options.featureAngle})`);
  }
  const types = options.types ?? [...FIT_PRIMITIVE_TYPES];
  for (const t of types) {
    if (!FIT_PRIMITIVE_TYPES.includes(t)) throw new Error(`Unknown primitive type "${t}" — valid: ${FIT_PRIMITIVE_TYPES.join(", ")}.`);
  }
  if (types.length === 0) throw new Error("types must name at least one primitive kind.");
  const maxPatches = Math.max(1, Math.floor(options.maxPatches ?? 200));

  const { positions, indices } = parseToWeldedMesh(bytes, format, external);
  const triCount = indices.length / 3;
  if (triCount === 0) throw new Error("The mesh has no triangles to segment.");

  const m = await getMeshio();
  try {
    const { mesh } = componentMesh(positions, indices, Array.from({ length: triCount }, (_, i) => i));
    const seg = m.segment(mesh, featureAngle, 0, 0, options.minPatchCells ?? 1, "", "patch");
    const fit = m.fitPrimitives(
      seg.mesh,
      "segment:patch",
      options.tolerance ?? 0.01,
      !options.absoluteTolerance,
      options.minInlierFraction ?? 0.9,
      types,
      20
    );
    const fd = fit.mesh.field_data ?? {};
    const cellPatch = toNumbers(fit.mesh.cell_data?.["segment:patch"]?.[0]);
    const counts = new Map<number, number>();
    for (const p of cellPatch) counts.set(p, (counts.get(p) ?? 0) + 1);

    const ids = toNumbers(fd["fit:patch_id"]);
    const typeCodes = toNumbers(fd["fit:patch_type"]);
    const rms = toNumbers(fd["fit:patch_rms"]);
    const max = toNumbers(fd["fit:patch_max"]);
    const fraction = toNumbers(fd["fit:patch_fraction"]);
    const params = toNumbers(fd["fit:patch_params"]);
    const adj = toNumbers(seg.mesh.field_data?.["segment:adjacency"]);

    const all: SegmentPatch[] = ids.map((id, k) => {
      const f = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : null);
      return {
        patch: id,
        triangleCount: counts.get(id) ?? 0,
        fitType: TYPE_BY_CODE[typeCodes[k]] ?? "none",
        rms: f(rms[k]),
        max: f(max[k]),
        inlierFraction: f(fraction[k]),
        params: params.slice(k * PARAMS_WIDTH, (k + 1) * PARAMS_WIDTH),
      };
    });
    const adjacency: SegmentMeshReport["adjacency"] = [];
    for (let i = 0; i + 2 < adj.length; i += 3) adjacency.push({ a: adj[i], b: adj[i + 1], sharedEdges: adj[i + 2] });

    const warnings: string[] = [];
    const truncated = all.length > maxPatches;
    if (truncated) warnings.push(`Listing capped at ${maxPatches} of ${all.length} patches (maxPatches); counts above cover every patch.`);
    if (types.includes("sphere") && types.includes("cylinder")) {
      warnings.push("Fits are vertex-based: a cylinder whose vertices lie only on its end rings also fits a sphere and is reported as one — pass types without \"sphere\" to rule it out.");
    }
    if (seg.numNonManifoldEdges > 0 || seg.numBoundaryEdges > 0) {
      warnings.push(`The surface is not closed/manifold (${seg.numBoundaryEdges} boundary, ${seg.numNonManifoldEdges} non-manifold edges); patches are still reported.`);
    }
    return {
      numPatches: seg.numPatches,
      numMerged: seg.numMerged,
      numFeatureEdges: seg.numFeatureEdges,
      numBoundaryEdges: seg.numBoundaryEdges,
      numNonManifoldEdges: seg.numNonManifoldEdges,
      fitCounts: {
        plane: fit.numPlane,
        sphere: fit.numSphere,
        cylinder: fit.numCylinder,
        cone: fit.numCone,
        torus: fit.numTorus,
        unfitted: fit.numUnfitted,
      },
      patches: all.slice(0, maxPatches),
      adjacency: adjacency.slice(0, maxPatches * 4),
      truncated,
      warnings,
    };
  } catch (err) {
    throw wrapMeshioFault(err);
  }
}
