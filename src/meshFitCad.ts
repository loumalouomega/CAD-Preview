/**
 * Mesh → analytic CAD: meshio++ `fitCad` over a segmented, primitive-fitted
 * closed skin (`fit_mesh_to_cad`).
 *
 * The whole chain, host-side: weld the triangle soup the four mesh parsers
 * produce (exactly `segment_mesh_surface`'s input path) → `segment`
 * (region growing at feature edges) → `fitPrimitives` (per-patch plane /
 * sphere / cylinder / cone / torus) → `fitCad`, which trims one analytic face
 * per accepted patch, adds rolling-ball fillets and blends, chamfers, vertex
 * blends, threads (tapered and variable-pitch included) and freeform B-spline
 * faces where nothing else fits, sews them and has the OpenCASCADE linked
 * into the FULL WASM artifact check the B-rep.
 *
 * **One-shot export, facts only.** Returns the STEP bytes (and optionally the
 * solid's `cad_json` B-rep) for the caller to write to a NEW file — the source
 * mesh is never touched and never reclassified. The report is upstream's own
 * counters (`valid`, volumes, the symmetric Hausdorff deviation, face counts
 * by kind, exact/approx edges) plus the segmentation's own fit counts; nothing
 * is judged here. A skin that is not closed throws upstream's own error
 * (naming the open edges) — `check_mesh_health` reads those facts first and
 * `repair_mesh` can rebuild a watertight skin.
 *
 * Needs the full artifact (`getMeshio` loads it): the lean pair has no
 * OpenCASCADE and `fitCad` itself would throw naming `{full: true}`.
 */

import { getMeshio, componentMesh, wrapMeshioFault } from "./meshioService";
import { parseToWeldedMesh } from "./meshHeal";
import type { GltfExternalBuffers } from "./gltfParser";
import type { MeshParseFormat } from "./fileRouter";
import { FIT_PRIMITIVE_TYPES, type FitPrimitiveType } from "./meshSegment";

/**
 * `fit_mesh_to_cad`'s own knobs: `segment` + `fitPrimitives` first (the same
 * vocabulary `segment_mesh_surface` publishes — a FIT here is vertex-based and
 * per patch), then `fitCad` itself (`cad*`-prefixed where the stages would
 * otherwise share a word). `tolerance`/`types` belong to the fit stage;
 * `cadTolerance`/`cadTypes` to the CAD build.
 */
export interface FitMeshToCadOptions {
  // --- segment + fitPrimitives (feeds the fitted skin) ----------------------
  /** Dihedral angle (degrees) above which an edge bounds a patch. Default 30. */
  featureAngle?: number;
  /** Patches smaller than this many triangles are merged into a neighbour. Default 1. */
  minPatchCells?: number;
  /** The FIT tolerance; relative to the patch size unless `absoluteTolerance`. Default 0.01 relative. */
  tolerance?: number;
  absoluteTolerance?: boolean;
  /** Fraction of a patch's vertices that must lie within `tolerance`. Default 0.9. */
  minInlierFraction?: number;
  /** Primitive kinds a patch may be fitted with. Default all five. */
  types?: FitPrimitiveType[];
  // --- fitCad (builds the solid) --------------------------------------------
  /** Largest distance an analytic face may lie from the skin; ≤ 0 is automatic. */
  cadTolerance?: number;
  /** Try the exact intersection of two analytic surfaces first (default true). */
  exactEdges?: boolean;
  /** Fitted patch kinds that become analytic faces (default all five). */
  cadTypes?: FitPrimitiveType[];
  /** The re-meshed solid's chordal deflection; ≤ 0 takes cadTolerance / 4. */
  meshDeflection?: number;
  /** Rounds of demoting failed faces before every patch is faceted (default 8). */
  maxDemotionRounds?: number;
  /** Try a freeform B-spline face where no primitive fits (default true). */
  freeform?: boolean;
  /** Freeform B-spline's highest degree, 3..8 (default 3). */
  freeformDegree?: number;
  /** Most grid points per direction a freeform fit samples (default 64). */
  freeformMaxControl?: number;
  /** Split a freeform patch that folds over every flattening (default true). */
  freeformSplit?: boolean;
  /** Try fillets, blends, chamfers and vertex blends (default true). */
  fillets?: boolean;
  /** Try thread faces, tapered and variable-pitch included (default true). */
  threads?: boolean;
  /** Also serialize the solid's B-rep (`cad_json`) into the result. */
  cadJson?: boolean;
}

export interface FitMeshToCadReport {
  /** Whether the sewn solid passed OpenCASCADE's B-rep check. */
  valid: boolean;
  /** The face tolerance actually used (automatic unless `cadTolerance` was given). */
  tolerance: number;
  /** The solid's volume. */
  volume: number;
  /** The closed skin's own volume (divergence theorem over its triangles). */
  skinVolume: number;
  /** `volume / skinVolume` — 1 means the fit preserved the enclosed volume. */
  volumeRatio: number;
  /** Symmetric Hausdorff distance, skin to re-meshed solid. */
  maxDeviation: number;
  numFaces: number;
  numPlane: number;
  numSphere: number;
  numCylinder: number;
  numCone: number;
  numTorus: number;
  numFacetedFaces: number;
  numPatches: number;
  /** Faces demoted to faceted (their patch's fit failed under the tolerance). */
  numDemoted: number;
  numExactEdges: number;
  numApproxEdges: number;
  numSolids: number;
  numBspline: number;
  numSplitPatches: number;
  numFillet: number;
  numHelical: number;
  numVariableFillet: number;
  numBlend: number;
  numRoundedThread: number;
  /** Vertex blends (setback corners). */
  numVertexBlend: number;
  /** Chamfers (straight-section blends). */
  numChamfer: number;
  /** Fillet faces whose section is a conic rather than a circle. */
  numConicBlend: number;
  /** Thread flanks on a tapered (conical) thread. */
  numTaperedThread: number;
  /** Thread flanks whose pitch varies along the axis. */
  numVariablePitchThread: number;
  /** The segmentation's own per-kind fitted-patch counts that fed the fit. */
  fitCounts: Record<FitPrimitiveType | "unfitted", number> & { merged: number };
  warnings: string[];
}

export interface FitMeshToCadResult {
  /** The solid as AP214 STEP bytes (upstream's own writer). */
  stepBytes: Uint8Array;
  /** The solid's B-rep, present only when `cadJson` was requested. */
  cadJsonBytes?: Uint8Array;
  report: FitMeshToCadReport;
}

// Host-side MEMFS paths: always ≤ 10 characters (see meshioService.ts's note
// on the module's path handling).
const STEP_PATH = "/f.step";
const CAD_JSON_PATH = "/c.json";

function assertTypes(name: string, types: FitPrimitiveType[] | undefined): FitPrimitiveType[] {
  const list = types ?? [...FIT_PRIMITIVE_TYPES];
  for (const t of list) {
    if (!FIT_PRIMITIVE_TYPES.includes(t)) throw new Error(`Unknown primitive type "${t}" in ${name} — valid: ${FIT_PRIMITIVE_TYPES.join(", ")}.`);
  }
  if (list.length === 0) throw new Error(`${name} must name at least one primitive kind.`);
  return list;
}

function finiteOrUndefined(name: string, value: number | undefined, extra?: (v: number) => boolean, requirement = "must be a finite number"): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || (extra && !extra(value))) throw new Error(`${name} ${requirement} (got ${value})`);
  return value;
}

export async function fitMeshToCad(
  bytes: Uint8Array,
  format: MeshParseFormat,
  options: FitMeshToCadOptions = {},
  external?: GltfExternalBuffers
): Promise<FitMeshToCadResult> {
  const featureAngle = options.featureAngle ?? 30;
  if (!(Number.isFinite(featureAngle) && featureAngle >= 0 && featureAngle <= 180)) {
    throw new Error(`featureAngle must be within 0..180 degrees (got ${options.featureAngle})`);
  }
  const types = assertTypes("types", options.types);
  const cadTypes = assertTypes("cadTypes", options.cadTypes);
  const tolerance = finiteOrUndefined("tolerance", options.tolerance, (v) => v > 0, "must be a positive number");
  const minInlierFraction = finiteOrUndefined("minInlierFraction", options.minInlierFraction, (v) => v >= 0 && v <= 1, "must be within 0..1");
  const cadTolerance = finiteOrUndefined("cadTolerance", options.cadTolerance);
  const meshDeflection = finiteOrUndefined("meshDeflection", options.meshDeflection);
  if (options.maxDemotionRounds !== undefined && !(Number.isInteger(options.maxDemotionRounds) && options.maxDemotionRounds >= 0)) {
    throw new Error(`maxDemotionRounds must be a non-negative integer (got ${options.maxDemotionRounds})`);
  }
  if (options.freeformDegree !== undefined && !(Number.isInteger(options.freeformDegree) && options.freeformDegree >= 3 && options.freeformDegree <= 8)) {
    throw new Error(`freeformDegree must be an integer within 3..8 (got ${options.freeformDegree})`);
  }
  if (options.freeformMaxControl !== undefined && !(Number.isInteger(options.freeformMaxControl) && options.freeformMaxControl >= 2)) {
    throw new Error(`freeformMaxControl must be an integer ≥ 2 (got ${options.freeformMaxControl})`);
  }

  const { positions, indices } = parseToWeldedMesh(bytes, format, external);
  const triCount = indices.length / 3;
  if (triCount === 0) throw new Error("The mesh has no triangles to fit a solid to.");

  const m = await getMeshio();
  try {
    const { mesh } = componentMesh(positions, indices, Array.from({ length: triCount }, (_, i) => i));
    const seg = m.segment(mesh, featureAngle, 0, 0, options.minPatchCells ?? 1, "", "patch");
    const fit = m.fitPrimitives(
      seg.mesh,
      "segment:patch",
      tolerance ?? 0.01,
      !options.absoluteTolerance,
      minInlierFraction ?? 0.9,
      types,
      20
    );

    // Only defined keys cross into `fitCad` — it validates option names and
    // kinds, and an explicit `undefined` is not "absent" to its checks.
    const cadOptions: Record<string, unknown> = { stepPath: STEP_PATH, types: cadTypes };
    if (cadTolerance !== undefined) cadOptions.tolerance = cadTolerance;
    if (options.exactEdges !== undefined) cadOptions.exactEdges = options.exactEdges;
    if (meshDeflection !== undefined) cadOptions.meshDeflection = meshDeflection;
    if (options.maxDemotionRounds !== undefined) cadOptions.maxDemotionRounds = options.maxDemotionRounds;
    if (options.freeform !== undefined) cadOptions.freeform = options.freeform;
    if (options.freeformDegree !== undefined) cadOptions.freeformDegree = options.freeformDegree;
    if (options.freeformMaxControl !== undefined) cadOptions.freeformMaxControl = options.freeformMaxControl;
    if (options.freeformSplit !== undefined) cadOptions.freeformSplit = options.freeformSplit;
    if (options.fillets !== undefined) cadOptions.fillets = options.fillets;
    if (options.threads !== undefined) cadOptions.threads = options.threads;

    let r: Record<string, unknown>;
    try {
      r = m.fitCad(fit.mesh, cadOptions);
    } catch (err) {
      const raw = ((err as Error)?.message ?? String(err)).trim();
      if (/not a closed, consistently wound solid/.test(raw)) {
        throw new Error(`${raw} (this server: check_mesh_health reads the per-component closure facts first, and repair_mesh writes a watertight STL from a dirty skin.)`);
      }
      throw err;
    }

    const stepBytes = new Uint8Array(m.FS.readFile(STEP_PATH));
    let cadJsonBytes: Uint8Array | undefined;
    if (options.cadJson) {
      m.writeMesh(CAD_JSON_PATH, r.mesh, "cad_json", { info: r.info });
      cadJsonBytes = new Uint8Array(m.FS.readFile(CAD_JSON_PATH));
    }

    const warnings: string[] = [];
    if (!r.valid) {
      warnings.push("The sewn solid failed OpenCASCADE's B-rep check (valid: false) — the written STEP is unverified; the counts below describe what was built.");
    }
    if (seg.numBoundaryEdges > 0 || seg.numNonManifoldEdges > 0) {
      warnings.push(`The surface is not closed/manifold (${seg.numBoundaryEdges} boundary, ${seg.numNonManifoldEdges} non-manifold edges).`);
    }
    if (fit.numUnfitted > 0) {
      warnings.push(`${fit.numUnfitted} of ${fit.numPatches} patches matched no allowed primitive — they become freeform B-spline or faceted faces.`);
    }

    const report: FitMeshToCadReport = {
      valid: Boolean(r.valid),
      tolerance: Number(r.tolerance),
      volume: Number(r.volume),
      skinVolume: Number(r.skinVolume),
      volumeRatio: Number(r.volumeRatio),
      maxDeviation: Number(r.maxDeviation),
      numFaces: Number(r.numFaces),
      numPlane: Number(r.numPlane),
      numSphere: Number(r.numSphere),
      numCylinder: Number(r.numCylinder),
      numCone: Number(r.numCone),
      numTorus: Number(r.numTorus),
      numFacetedFaces: Number(r.numFacetedFaces),
      numPatches: Number(r.numPatches),
      numDemoted: Number(r.numDemoted),
      numExactEdges: Number(r.numExactEdges),
      numApproxEdges: Number(r.numApproxEdges),
      numSolids: Number(r.numSolids),
      numBspline: Number(r.numBspline),
      numSplitPatches: Number(r.numSplitPatches),
      numFillet: Number(r.numFillet),
      numHelical: Number(r.numHelical),
      numVariableFillet: Number(r.numVariableFillet),
      numBlend: Number(r.numBlend),
      numRoundedThread: Number(r.numRoundedThread),
      numVertexBlend: Number(r.numVertexBlend),
      numChamfer: Number(r.numChamfer),
      numConicBlend: Number(r.numConicBlend),
      numTaperedThread: Number(r.numTaperedThread),
      numVariablePitchThread: Number(r.numVariablePitchThread),
      fitCounts: {
        plane: fit.numPlane,
        sphere: fit.numSphere,
        cylinder: fit.numCylinder,
        cone: fit.numCone,
        torus: fit.numTorus,
        unfitted: fit.numUnfitted,
        merged: seg.numMerged,
      },
      warnings,
    };
    return { stepBytes, ...(cadJsonBytes ? { cadJsonBytes } : {}), report };
  } catch (err) {
    throw wrapMeshioFault(err);
  }
}
