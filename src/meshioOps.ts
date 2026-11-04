// Declarative meshio++ mesh-operation specs for the interactive Mesh Ops
// panel (roadmap Tier 1 "Mesh-operations panel for meshio sources").
//
// Pure, vscode/WASM/DOM-free — shared by the webview panel (which builds a
// spec from its form) and `provider.ts` (which validates before calling the
// kernel). The kernel itself (`meshioService.ts`'s `runMeshioOps`) stays the
// single executor; this module is only the vocabulary + validation gate, the
// same split `opCatalog.ts` provides for edit ops. Deliberately NOT imported
// from `meshioService.ts` as a value (that module pulls in the WASM graph);
// `meshioService.ts` keeps its own `MeshioOpSpec` interface and this file
// mirrors it structurally — kept in lockstep by the test below.

/** The operations `transform_mesh` (and the panel) support. */
export const MESHIO_OP_IDS = [
  "clean",
  "decimate",
  "smooth",
  "subdivide",
  "refine",
  "agglomerate",
  "convertCells",
  "tetToPoly",
  "polyToTet",
  "optimizeVolume",
  "adapt",
  "discretizeLevelset",
  // meshio++ 18.1
  "untangle",
  "prepareMetric",
  "morph",
  "convexHull",
  "delaunay2d",
  "convertCoordinates",
  "estimateNormals",
  "reconstructSurface",
  "geodesicDistance",
  "parameterize",
  "laplacianEigenmodes",
] as const;

export type MeshioOpId = (typeof MESHIO_OP_IDS)[number];

/** Plain-JSON operation spec — crosses the host↔webview protocol untouched. */
export interface MeshioOpSpec {
  op: MeshioOpId;
  ratio?: number;
  iterations?: number;
  levels?: number;
  method?: string;
  mode?: string;
  targetGroupSize?: number;
  /** `optimizeVolume`: `"worst"` (default) or `"energy"`. */
  objective?: string;
  maxRingSize?: number;
  /** `adapt`: constant target edge size; `hausd` Hausdorff bound (both source units). */
  hsiz?: number;
  hausd?: number;
  /** `discretizeLevelset`: the point-data array and its isovalue. */
  levelSet?: string;
  isovalue?: number;
  /** `prepareMetric` / `convertCoordinates`: the point-data arrays to read; `morph`: `array` is the displacement. */
  arrays?: string[];
  array?: string;
  /** `prepareMetric`: the output array name, target vertex count, size bounds and gradation (source units). */
  output?: string;
  targetVertices?: number;
  hmin?: number;
  hmax?: number;
  gradation?: number;
  /** `untangle`/`morph`: keep boundary points fixed (default true). `morph`: load steps, stiffening, tolerate inverted cells. */
  fixBoundary?: boolean;
  steps?: number;
  stiffening?: number;
  allowInverted?: boolean;
  /** `convexHull`: 2, 3, or 0 to decide from the points. */
  dimension?: number;
  /** `convertCoordinates`: system, axis/origin (3 numbers each), and the inverse direction. */
  system?: string;
  axis?: number[];
  origin?: number[];
  inverse?: boolean;
  /** `estimateNormals`: neighbourhood size and orientation rule. */
  neighbours?: number;
  orientation?: string;
  /** `reconstructSurface`: Hoppe `k`, lattice `cellSize` and `maxDistance` (0/omitted = automatic). */
  k?: number;
  cellSize?: number;
  maxDistance?: number;
  /** `geodesicDistance`: 0-based source point ids and/or a named point region. */
  sources?: number[];
  sourceRegion?: string;
  /** `parameterize`: chart padding, split depth, stretch limit. */
  padding?: number;
  maxDepth?: number;
  maxStretch?: number;
  /** `laplacianEigenmodes`: how many lowest modes. */
  numModes?: number;
}

/** Short human-readable label per operation, for the panel `<select>`. */
export const MESHIO_OP_LABELS: Record<MeshioOpId, string> = {
  clean: "Clean (weld + drop degenerate/duplicate)",
  decimate: "Decimate (quadric edge-collapse)",
  smooth: "Smooth (Taubin/Laplacian)",
  subdivide: "Subdivide once",
  refine: "Refine (levels)",
  agglomerate: "Agglomerate (coarsen)",
  convertCells: "Convert cells (linearize/simplexify/elevate)",
  tetToPoly: "Tets → polyhedral dual (one cell per vertex)",
  polyToTet: "Polyhedra → tets",
  optimizeVolume: "Optimize tets (raise the worst dihedral angle)",
  adapt: "MMG adapt (remesh to a target size)",
  discretizeLevelset: "MMG level set (insert an isovalue interface)",
  untangle: "Untangle (fix inverted tets/hexes)",
  prepareMetric: "Prepare metric (intersect, normalise, grade)",
  morph: "Morph (displace the boundary, relax the interior)",
  convexHull: "Convex hull of the points",
  delaunay2d: "Delaunay triangulation in the x-y plane",
  convertCoordinates: "Cylindrical / spherical components",
  estimateNormals: "Estimate point-cloud normals",
  reconstructSurface: "Reconstruct a surface from an oriented point cloud",
  geodesicDistance: "Geodesic distance from source points",
  parameterize: "UV parameterization (atlas)",
  laplacianEigenmodes: "Laplace-Beltrami eigenmodes",
};

/** Ops whose result is a derived mesh or a data array rather than an edit of the source's cells. */
export const MESHIO_DATA_OPS: readonly MeshioOpId[] = [
  "prepareMetric", "convertCoordinates", "estimateNormals", "geodesicDistance", "parameterize", "laplacianEigenmodes",
];

/**
 * Validates an untrusted op spec (panel draft or protocol payload). Returns
 * the clean spec, or `null` when the op id is unknown. Numeric params are
 * range-checked only where `runMeshioOps` would otherwise throw unconditionally
 * (the `(0,1]` rule for decimate's `ratio`); everything else degrades
 * gracefully kernel-side per that function's own per-step report, so this
 * stays a shape gate, not a second executor.
 */
export function validateMeshioOpSpec(raw: unknown): MeshioOpSpec | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.op !== "string") return null;
  if (!(MESHIO_OP_IDS as readonly string[]).includes(r.op)) return null;
  const op = r.op as MeshioOpId;
  const spec: MeshioOpSpec = { op };
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const ratio = num(r.ratio);
  if (ratio !== undefined) {
    if (!(ratio > 0 && ratio <= 1)) return null;
    spec.ratio = ratio;
  }
  const iterations = num(r.iterations);
  if (iterations !== undefined) spec.iterations = Math.max(1, Math.floor(iterations));
  const levels = num(r.levels);
  if (levels !== undefined) spec.levels = Math.max(1, Math.floor(levels));
  if (typeof r.method === "string" && (r.method === "taubin" || r.method === "laplacian")) {
    spec.method = r.method;
  }
  if (typeof r.mode === "string" && (r.mode === "linearize" || r.mode === "simplexify" || r.mode === "elevate")) {
    spec.mode = r.mode;
  }
  const targetGroupSize = num(r.targetGroupSize);
  if (targetGroupSize !== undefined) spec.targetGroupSize = Math.max(1, Math.floor(targetGroupSize));
  if (typeof r.objective === "string" && (r.objective === "worst" || r.objective === "energy")) spec.objective = r.objective;
  const maxRingSize = num(r.maxRingSize);
  if (maxRingSize !== undefined) spec.maxRingSize = Math.max(3, Math.floor(maxRingSize));
  const hsiz = num(r.hsiz);
  if (hsiz !== undefined) {
    if (!(hsiz > 0)) return null;
    spec.hsiz = hsiz;
  }
  const hausd = num(r.hausd);
  if (hausd !== undefined) {
    if (!(hausd > 0)) return null;
    spec.hausd = hausd;
  }
  if (typeof r.levelSet === "string" && r.levelSet.length > 0 && r.levelSet.length <= 256) spec.levelSet = r.levelSet;
  const isovalue = num(r.isovalue);
  if (isovalue !== undefined) spec.isovalue = isovalue;
  if (op === "discretizeLevelset" && spec.levelSet === undefined) return null;

  // meshio++ 18.1 parameters. Shape gate only: the kernel throws (and the step is reported) on
  // anything it cannot honour, so a bad value is dropped rather than failing the whole request.
  const name = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 256 ? v : undefined);
  const names = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v.map(name).filter((x): x is string => x !== undefined);
    return out.length > 0 && out.length === v.length ? out : undefined;
  };
  const vec3 = (v: unknown): number[] | undefined =>
    Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as number[]) : undefined;
  const positive = (v: unknown): number | undefined => {
    const x = num(v);
    return x !== undefined && x > 0 ? x : undefined;
  };
  const nonNegative = (v: unknown): number | undefined => {
    const x = num(v);
    return x !== undefined && x >= 0 ? x : undefined;
  };
  const arrays = names(r.arrays);
  if (arrays) spec.arrays = arrays;
  const array = name(r.array);
  if (array) spec.array = array;
  const output = name(r.output);
  if (output) spec.output = output;
  const targetVertices = positive(r.targetVertices);
  if (targetVertices !== undefined) spec.targetVertices = Math.floor(targetVertices);
  const hmin = positive(r.hmin);
  if (hmin !== undefined) spec.hmin = hmin;
  const hmax = positive(r.hmax);
  if (hmax !== undefined) spec.hmax = hmax;
  const gradation = num(r.gradation);
  if (gradation !== undefined && gradation >= 1) spec.gradation = gradation;
  if (typeof r.fixBoundary === "boolean") spec.fixBoundary = r.fixBoundary;
  const steps = positive(r.steps);
  if (steps !== undefined) spec.steps = Math.floor(steps);
  const stiffening = nonNegative(r.stiffening);
  if (stiffening !== undefined) spec.stiffening = stiffening;
  if (typeof r.allowInverted === "boolean") spec.allowInverted = r.allowInverted;
  if (r.dimension === 0 || r.dimension === 2 || r.dimension === 3) spec.dimension = r.dimension;
  if (r.system === "cylindrical" || r.system === "spherical") spec.system = r.system;
  const axis = vec3(r.axis);
  if (axis && axis.some((x) => x !== 0)) spec.axis = axis;
  const origin = vec3(r.origin);
  if (origin) spec.origin = origin;
  if (typeof r.inverse === "boolean") spec.inverse = r.inverse;
  const neighbours = num(r.neighbours);
  if (neighbours !== undefined && neighbours >= 2) spec.neighbours = Math.floor(neighbours);
  if (r.orientation === "consistent" || r.orientation === "viewpoint" || r.orientation === "none") spec.orientation = r.orientation;
  const k = positive(r.k);
  if (k !== undefined) spec.k = Math.floor(k);
  const cellSize = nonNegative(r.cellSize);
  if (cellSize !== undefined) spec.cellSize = cellSize;
  const maxDistance = nonNegative(r.maxDistance);
  if (maxDistance !== undefined) spec.maxDistance = maxDistance;
  if (Array.isArray(r.sources)) {
    const ids = r.sources.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0);
    if (ids.length > 0 && ids.length === r.sources.length) spec.sources = ids;
  }
  const sourceRegion = name(r.sourceRegion);
  if (sourceRegion) spec.sourceRegion = sourceRegion;
  const padding = nonNegative(r.padding);
  if (padding !== undefined) spec.padding = padding;
  const maxDepth = nonNegative(r.maxDepth);
  if (maxDepth !== undefined) spec.maxDepth = Math.floor(maxDepth);
  const maxStretch = positive(r.maxStretch);
  if (maxStretch !== undefined) spec.maxStretch = maxStretch;
  const numModes = positive(r.numModes);
  if (numModes !== undefined) spec.numModes = Math.floor(numModes);
  // Ops that cannot run without one specific argument are refused up front, like discretizeLevelset.
  if (op === "prepareMetric" && spec.arrays === undefined) return null;
  if (op === "morph" && spec.array === undefined) return null;
  if (op === "geodesicDistance" && spec.sources === undefined && spec.sourceRegion === undefined) return null;
  return spec;
}
