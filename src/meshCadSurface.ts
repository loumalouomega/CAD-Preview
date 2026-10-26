/**
 * B-rep → conforming surface mesh with no CAD kernel: meshio++ 17.9's
 * `meshCadSurface` (`mesh_cad_surface` MCP tool).
 *
 * The input is a B-rep's exact faces as meshio++ reads them — a Kratos CAD JSON
 * model, or (FULL artifact) a STEP/IGES file, whose read attaches the same
 * `format: "cad_json"` side channel the `iga_*` tools use (`meshIga.ts`).
 * Every edge is sampled ONCE and shared by its two faces, so the triangles of
 * neighbouring faces meet node-for-node: the result is watertight whenever the
 * B-rep is, with `cad:face` / `cad:edge` cell data carrying the source ids.
 * That is the opposite trade to `brepSkinStlBytes`' tessellate-and-weld (which
 * needs OCCT and a welding tolerance): measured, `block.stp` at 0.5 mm closes
 * with 0 open edges and encloses exactly 60, `bull.stp` (36 faces) meshes in
 * ~100 ms with 0 open edges and no failed face.
 *
 * Facts only. A face that cannot be meshed is listed with its upstream status
 * and reason, never meshed wrong (`strict` throws instead). The side channel
 * (`CadJsonInfo` carries `BigInt64Array`) never crosses the IPC boundary: this
 * runs entirely inside the kernel worker on raw file bytes, like `meshIga.ts`.
 */

import { getMeshio, wrapMeshioFault } from "./meshioService";

export interface MeshCadSurfaceOptions {
  /** Target edge length, in the model's units. Required, > 0. */
  targetSize: number;
  /** Cap on a boundary segment's sagitta; 0 (default) is off. */
  maxChordalDeviation?: number;
  /** At least this many points inside every edge (default 0). */
  minPointsPerEdge?: number;
  /** Geometric tolerance; 0 (default) is 1e-7 of the control nets' diagonal. */
  tolerance?: number;
  /** Also write a line block of the B-rep edges with `cad:edge` (default true; forced off for OBJ). */
  edges?: boolean;
  /** Throw when any face cannot be meshed instead of listing it (default false). */
  strict?: boolean;
  /** The most points in the result (default 50 000 000 upstream; capped here at 5 000 000). */
  maxPoints?: number;
  /** Refine until every triangle's smallest angle is at least this (degrees, 0 ≤ x < 60); 0 (default) keeps the unrefined mesh. A bound a sharp corner makes impossible is reported (`numFacesBelowBound`), never promised. */
  minAngle?: number;
  /** Passes of guarded smoothing (integer, default 0). */
  smoothIterations?: number;
  /** How smoothing moves a point (default laplacian). */
  smoothMethod?: "laplacian" | "odt";
  /** 1 (default) linear triangles; 2 / 3 curved `triangle6` / `triangle10` elements — only the `.msh`, `.vtk` and `.vtu` writers can hold them. */
  order?: 1 | 2 | 3;
  /** Largest growth of the size, `|grad h| ≤ grading − 1`; 0 (default) is upstream's 1.5. Acts only with `curvatureDeviation` or `cellsAcrossGaps`. */
  grading?: number;
  /** Size each region so a chord sits at most this far from the surface; 0 (default) is off. */
  curvatureDeviation?: number;
  /** Size each region so at least this many elements span its local feature size (a wall's thickness); 0 (default) is off. */
  cellsAcrossGaps?: number;
  /** Rings of points seeded around each pole (integer 0–8; default 0). */
  poleRings?: number;
  /** Size per face, `{faceIndex: size}` (0-based indices into the B-rep's faces, as meshio++ reads them). */
  faceSizes?: Record<number, number>;
  /** The same per edge. */
  edgeSizes?: Record<number, number>;
  /** `mean` (default) meshes each face in its mean metric; `varying` follows its metric. */
  metric?: "mean" | "varying";
  /** Sample chains of short edges meeting smoothly as one (default false). */
  virtualEdges?: boolean;
  /** Mesh a sliver face together with the neighbour it meets tangentially (default false). */
  virtualFaces?: boolean;
  /** Accept the gaps the model itself declares in its edges (default false). */
  modelTolerances?: boolean;
  /** Mesh a face whose metric's condition number passes this in a flattening of its coarse mesh; 0 (default) is off, otherwise above 1; order 1 only. */
  reparamConditionNumber?: number;
  /** Lop acute corners in place of concentric shells (default false); needs `minAngle`. */
  lopCorners?: boolean;
}

/** Writable surface-mesh formats: output extension → meshio++ format name. */
export const MESH_CAD_SURFACE_FORMATS: Readonly<Record<string, string>> = {
  ".stl": "stl",
  ".obj": "obj",
  ".ply": "ply",
  ".vtk": "vtk",
  ".vtu": "vtu",
  ".msh": "gmsh",
};

/** Writers that can hold a curved `triangle6` / `triangle10` block. */
export const MESH_CAD_CURVED_EXTENSIONS: readonly string[] = [".msh", ".vtk", ".vtu"];

export interface MeshCadFaceFact {
  face: number;
  id: number;
  status: string;
  reason: string;
  numTriangles: number;
  numInteriorPoints: number;
  minAngleDeg: number;
  maxAngleDeg: number;
  /** Points the `minAngle` refinement added on this face. */
  numRefinementPoints: number;
  numSmoothed: number;
  /** The refinement bound could not be met here (a sharp corner forces smaller angles). */
  belowBound: boolean;
  /** The smallest angle of this face's triangles no corner forces; 0 when unrefined. */
  boundDeg: number;
  /** Corners under 60° (or poles) that keep triangles under `minAngle`. */
  cornerCount: number;
  /** Edges finer than the face's given size allows (first {@link MAX_DETAIL_LISTED}). */
  limitedByEdges: number[];
}

export interface MeshCadSurfaceReport {
  targetSize: number;
  numPoints: number;
  numTriangles: number;
  numEdgeSegments: number;
  numFaces: number;
  numFailed: number;
  numEdges: number;
  /** Boundary edges used once / three or more times / traversed the same way twice — 0/0/0 is a watertight, consistently wound surface. */
  numOpenEdges: number;
  numNonManifoldEdges: number;
  numMisorientedEdges: number;
  numDegenerateDropped: number;
  tolerance: number;
  minAngleDeg: number;
  maxAngleDeg: number;
  minEdge: number;
  maxEdge: number;
  /** Largest gap between two faces' copies of a shared edge. */
  maxEdgeGap: number;
  /** Faces that did not come back `ok` first, then up to `maxFaces` of the rest. */
  faces: MeshCadFaceFact[];
  facesTruncated: boolean;
  /** Points added by `minAngle` refinement, faces whose bound could not be met, points moved by smoothing. */
  numRefinementPoints: number;
  numFacesBelowBound: number;
  numSmoothed: number;
  /** Curved elements whose Jacobian was not positive everywhere, kept straight-sided (order > 1). */
  numCurvedStraightened: number;
  /** Every triangle angle on the surface, in 18 bins of 10 degrees. */
  angleHistogram: number[];
  /** Chains of edge indices sampled as one (`virtualEdges`). */
  virtualEdges: number[][];
  /** Faces over `reparamConditionNumber` and what became of each. */
  reparametrised: Array<Record<string, unknown>>;
  /** Sliver faces found and whether each merged (`virtualFaces`). */
  mergedFaces: Array<Record<string, unknown>>;
  /** Where a declared tolerance accepted a gap (`modelTolerances`). */
  toleranceUses: Array<Record<string, unknown>>;
  /** Corners lopped (`lopCorners`). */
  loppedCorners: Array<Record<string, unknown>>;
  /** True when any of the five detail lists above was cut to {@link MAX_DETAIL_LISTED}. */
  detailTruncated: boolean;
  warnings: string[];
}

export interface MeshCadSurfaceResult {
  /** The surface mesh serialized in the requested format. */
  outputBytes: Uint8Array;
  report: MeshCadSurfaceReport;
}

const MAX_POINTS_CEILING = 5_000_000;
const MAX_FACES_LISTED = 200;
/** Cap on each detail list (virtual edges, reparametrised faces, …) and on a face's `limitedByEdges`. */
export const MAX_DETAIL_LISTED = 50;
// Host-side MEMFS paths: always ≤ 10 characters (see meshioService.ts).
const IN_PATH = "/mcs.in";
const OUT_PATH = "/mcs.out";

function positive(name: string, v: number | undefined, allowZero = false): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isFinite(v) || (allowZero ? v < 0 : v <= 0)) throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} number (got ${v})`);
  return v;
}

function integerInRange(name: string, v: number | undefined, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer from ${min} to ${max} (got ${v})`);
  return v;
}

function indexSizes(name: string, v: Record<number, number> | undefined): Record<string, number> | undefined {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(`${name} must be an object of {index: size}`);
  const out: Record<string, number> = {};
  for (const [k, size] of Object.entries(v)) {
    if (!/^\d+$/.test(k)) throw new Error(`${name} key "${k}" must be a non-negative integer index`);
    if (!Number.isFinite(size) || size <= 0) throw new Error(`${name}[${k}] must be a positive size (got ${size})`);
    out[k] = size;
  }
  return out;
}

export interface MeshCadCall {
  /** The options object handed to `m.meshCadSurface` — only defined keys. */
  call: Record<string, unknown>;
  targetSize: number;
  order: 1 | 2 | 3;
  warnings: string[];
}

/**
 * Validates caller options and builds the meshio++ call. Pure and WASM-free, so
 * the tool, the `meshcad` engine and the unit tests share one gate. Only
 * defined keys cross into meshio++ — a default call stays byte-identical to
 * what 17.13 received. `writerFormat` is the meshio++ writer the result will go
 * to (null for the engine, which writes MSH itself).
 */
export function buildMeshCadCall(options: MeshCadSurfaceOptions, writerFormat: string | null, extension?: string): MeshCadCall {
  const targetSize = positive("targetSize", options.targetSize);
  if (targetSize === undefined) throw new Error("targetSize is required (a positive edge length in model units).");
  const maxChordalDeviation = positive("maxChordalDeviation", options.maxChordalDeviation, true);
  const tolerance = positive("tolerance", options.tolerance, true);
  if (options.minPointsPerEdge !== undefined && !(Number.isInteger(options.minPointsPerEdge) && options.minPointsPerEdge >= 0)) {
    throw new Error(`minPointsPerEdge must be a non-negative integer (got ${options.minPointsPerEdge})`);
  }
  const maxPoints = Math.min(MAX_POINTS_CEILING, Math.floor(positive("maxPoints", options.maxPoints) ?? MAX_POINTS_CEILING));

  const minAngle = positive("minAngle", options.minAngle, true);
  if (minAngle !== undefined && minAngle >= 60) throw new Error(`minAngle must be below 60 degrees (got ${minAngle}) — no surface triangulation can guarantee more.`);
  const smoothIterations = integerInRange("smoothIterations", options.smoothIterations, 0, 1000);
  if (options.smoothMethod !== undefined && options.smoothMethod !== "laplacian" && options.smoothMethod !== "odt") {
    throw new Error(`smoothMethod must be "laplacian" or "odt" (got ${String(options.smoothMethod)})`);
  }
  if (options.metric !== undefined && options.metric !== "mean" && options.metric !== "varying") {
    throw new Error(`metric must be "mean" or "varying" (got ${String(options.metric)})`);
  }
  const order = options.order ?? 1;
  if (order !== 1 && order !== 2 && order !== 3) throw new Error(`order must be 1, 2 or 3 (got ${String(options.order)})`);
  const grading = positive("grading", options.grading, true);
  if (grading !== undefined && grading !== 0 && grading <= 1) throw new Error(`grading must be 0 (default) or above 1 (got ${grading}) — |grad h| ≤ grading − 1.`);
  const curvatureDeviation = positive("curvatureDeviation", options.curvatureDeviation, true);
  const cellsAcrossGaps = positive("cellsAcrossGaps", options.cellsAcrossGaps, true);
  const poleRings = integerInRange("poleRings", options.poleRings, 0, 8);
  const faceSizes = indexSizes("faceSizes", options.faceSizes);
  const edgeSizes = indexSizes("edgeSizes", options.edgeSizes);
  const reparam = positive("reparamConditionNumber", options.reparamConditionNumber, true);
  if (reparam !== undefined && reparam !== 0 && reparam <= 1) throw new Error(`reparamConditionNumber must be 0 (off) or above 1 (got ${reparam}).`);
  if (reparam !== undefined && reparam > 0 && order !== 1) throw new Error("reparamConditionNumber works with order 1 only.");
  if (options.lopCorners && !(minAngle !== undefined && minAngle > 0)) throw new Error("lopCorners acts on the minAngle refinement — set minAngle above 0.");
  if (order > 1 && extension !== undefined && !MESH_CAD_CURVED_EXTENSIONS.includes(extension.toLowerCase())) {
    throw new Error(`order ${order} writes curved triangle6/triangle10 elements, which only ${MESH_CAD_CURVED_EXTENSIONS.join(", ")} can hold (got "${extension}").`);
  }

  const warnings: string[] = [];
  let edges = options.edges ?? true;
  if (edges && writerFormat === "obj") {
    edges = false;
    warnings.push("OBJ holds no line cells — the B-rep edge block was dropped (the triangles keep their cad:face ids only in formats that carry cell data).");
  }

  // Only defined keys cross into meshio++, which validates names and kinds.
  const o: Record<string, unknown> = { targetSize, edges, maxPoints };
  const set = (k: string, v: unknown): void => {
    if (v !== undefined) o[k] = v;
  };
  set("maxChordalDeviation", maxChordalDeviation);
  set("tolerance", tolerance);
  set("minPointsPerEdge", options.minPointsPerEdge);
  set("strict", options.strict);
  set("minAngle", minAngle);
  set("smoothIterations", smoothIterations);
  set("smoothMethod", options.smoothMethod);
  if (options.order !== undefined) set("order", options.order);
  set("grading", grading);
  set("curvatureDeviation", curvatureDeviation);
  set("cellsAcrossGaps", cellsAcrossGaps);
  set("poleRings", poleRings);
  set("faceSizes", faceSizes);
  set("edgeSizes", edgeSizes);
  set("metric", options.metric);
  set("virtualEdges", options.virtualEdges);
  set("virtualFaces", options.virtualFaces);
  set("modelTolerances", options.modelTolerances);
  set("reparamConditionNumber", reparam);
  set("lopCorners", options.lopCorners);
  return { call: o, targetSize, order, warnings };
}

/** The raw object `m.meshCadSurface` returns (the fields this module reads). */
export interface RawMeshCadResult {
  mesh: { points: ArrayLike<number>; cells: Array<{ type: string; data: ArrayLike<number | bigint> }>; [k: string]: unknown };
  faces: Array<Record<string, unknown>>;
  warnings: string[];
  [k: string]: unknown;
}

const detail = (list: unknown): Array<Record<string, unknown>> => (Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []);

/** Summarises meshio++'s raw result into the facts the tool and the engine report. */
export function summarizeMeshCad(r: RawMeshCadResult, targetSize: number, warnings: string[]): MeshCadSurfaceReport {
  const n = (k: string): number => Number(r[k] ?? 0);
  const all: MeshCadFaceFact[] = r.faces.map((f) => ({
    face: Number(f.face),
    id: Number(f.id),
    status: String(f.status),
    reason: String(f.reason ?? ""),
    numTriangles: Number(f.numTriangles),
    numInteriorPoints: Number(f.numInteriorPoints),
    minAngleDeg: Number(f.minAngleDeg),
    maxAngleDeg: Number(f.maxAngleDeg),
    numRefinementPoints: Number(f.numRefinementPoints ?? 0),
    numSmoothed: Number(f.numSmoothed ?? 0),
    belowBound: Boolean(f.belowBound),
    boundDeg: Number(f.boundDeg ?? 0),
    cornerCount: Array.isArray(f.corners) ? f.corners.length : 0,
    limitedByEdges: Array.isArray(f.limitedByEdges) ? (f.limitedByEdges as unknown[]).slice(0, MAX_DETAIL_LISTED).map(Number) : [],
  }));
  // Failures first, then faces whose angle bound was missed, so a cap never hides one.
  const rank = (f: MeshCadFaceFact): number => (f.status !== "ok" ? 0 : f.belowBound ? 1 : 2);
  const ordered = all
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .map((x) => x.f);
  const facesTruncated = ordered.length > MAX_FACES_LISTED;
  if (facesTruncated) warnings.push(`Face listing capped at ${MAX_FACES_LISTED} of ${ordered.length} (failures first); the counts cover every face.`);
  for (const w of r.warnings ?? []) warnings.push(String(w));
  const numFailed = n("numFailed");
  if (numFailed > 0) warnings.push(`${numFailed} of ${n("numFaces")} faces could not be meshed — see faces[] for each status and reason; the surface is open there.`);
  if (n("numOpenEdges") > 0 || n("numNonManifoldEdges") > 0 || n("numMisorientedEdges") > 0) {
    warnings.push(
      `The surface is not a closed, consistently wound manifold (${n("numOpenEdges")} open, ${n("numNonManifoldEdges")} non-manifold, ${n("numMisorientedEdges")} misoriented edges).`
    );
  }
  if (n("numFacesBelowBound") > 0) {
    warnings.push(`${n("numFacesBelowBound")} face(s) could not reach the requested minAngle (a sharp corner forces smaller angles there) — see faces[].belowBound and boundDeg; the smallest triangle angle is ${n("minAngleDeg").toFixed(2)}°.`);
  }
  if (n("numCurvedStraightened") > 0) {
    warnings.push(`${n("numCurvedStraightened")} curved element(s) had a Jacobian that is not positive everywhere and were kept straight-sided.`);
  }
  let detailTruncated = false;
  const cap = <T,>(list: T[]): T[] => {
    if (list.length > MAX_DETAIL_LISTED) detailTruncated = true;
    return list.slice(0, MAX_DETAIL_LISTED);
  };
  const virtualEdges = cap(Array.isArray(r.virtualEdges) ? (r.virtualEdges as unknown[][]).map((c) => c.map(Number)) : []);
  const reparametrised = cap(detail(r.reparametrised));
  const mergedFaces = cap(detail(r.mergedFaces));
  const toleranceUses = cap(detail(r.toleranceUses));
  const loppedCorners = cap(detail(r.loppedCorners));
  if (detailTruncated) warnings.push(`Detail lists capped at ${MAX_DETAIL_LISTED} entries each; the counts cover every entry.`);

  return {
    targetSize,
    numPoints: n("numPoints"),
    numTriangles: n("numTriangles"),
    numEdgeSegments: n("numEdgeSegments"),
    numFaces: n("numFaces"),
    numFailed,
    numEdges: n("numEdges"),
    numOpenEdges: n("numOpenEdges"),
    numNonManifoldEdges: n("numNonManifoldEdges"),
    numMisorientedEdges: n("numMisorientedEdges"),
    numDegenerateDropped: n("numDegenerateDropped"),
    tolerance: n("tolerance"),
    minAngleDeg: n("minAngleDeg"),
    maxAngleDeg: n("maxAngleDeg"),
    minEdge: n("minEdge"),
    maxEdge: n("maxEdge"),
    maxEdgeGap: n("maxEdgeGap"),
    faces: ordered.slice(0, MAX_FACES_LISTED),
    facesTruncated,
    numRefinementPoints: n("numRefinementPoints"),
    numFacesBelowBound: n("numFacesBelowBound"),
    numSmoothed: n("numSmoothed"),
    numCurvedStraightened: n("numCurvedStraightened"),
    angleHistogram: Array.isArray(r.angleHistogram) ? (r.angleHistogram as unknown[]).map(Number) : [],
    virtualEdges,
    reparametrised,
    mergedFaces,
    toleranceUses,
    loppedCorners,
    detailTruncated,
    warnings,
  };
}

type MeshioApi = Awaited<ReturnType<typeof getMeshio>>;

/** Reads a B-rep file's `cad_json` side channel (kernel-free faces); throws a plain error when it has none. */
export function readCadInfo(m: MeshioApi, path: string, meshioFormat: string): unknown {
  const selective: Record<string, unknown> = m.readMeshSelective(path, { format: meshioFormat, info: true });
  const info = selective.info as Record<string, unknown> | undefined;
  if (!info || info.format !== "cad_json") {
    throw new Error("The file has no B-rep side channel — mesh_cad_surface needs a Kratos CAD JSON model (.cad.json) or a STEP/IGES file.");
  }
  return info;
}

export async function meshCadSurfaceModel(
  bytes: Uint8Array,
  meshioFormat: string,
  outputExtension: string,
  options: MeshCadSurfaceOptions
): Promise<MeshCadSurfaceResult> {
  const writerFormat = MESH_CAD_SURFACE_FORMATS[outputExtension.toLowerCase()];
  if (!writerFormat) {
    throw new Error(`Unsupported output extension "${outputExtension}" — valid: ${Object.keys(MESH_CAD_SURFACE_FORMATS).join(", ")}.`);
  }
  const { call, targetSize, warnings } = buildMeshCadCall(options, writerFormat, outputExtension);

  const m = await getMeshio();
  try {
    m.FS.writeFile(IN_PATH, bytes);
    const info = readCadInfo(m, IN_PATH, meshioFormat);
    const r = m.meshCadSurface(info as never, call as never) as unknown as RawMeshCadResult;

    m.writeMesh(OUT_PATH, r.mesh as never, writerFormat);
    const outputBytes = new Uint8Array(m.FS.readFile(OUT_PATH));
    return { outputBytes, report: summarizeMeshCad(r, targetSize, warnings) };
  } catch (err) {
    throw wrapMeshioFault(err);
  } finally {
    for (const p of [IN_PATH, OUT_PATH]) {
      try {
        m.FS.unlink(p);
      } catch {
        /* ignore */
      }
    }
  }
}
