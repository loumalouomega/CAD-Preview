/**
 * Kratos CAD JSON NURBS models — meshio++ 17.2.0's `iga_sample`, `iga_refine`
 * and `iga_evaluate` (`src/meshIga.ts`, the `iga_*` MCP tools).
 *
 * A `.cad.json` file holds an exact NURBS B-rep (`CadJsonInfo`: trimmed faces
 * with loops, edges, vertices, and the surface patches themselves). The plain
 * import path linearizes its sampled cells (a quad9 renders as its 8 corner
 * points), so these three operations go back to the model itself:
 *
 * - `igaSampleModel` samples every face into Lagrange cells at
 *   `sampleSubdivisions` per knot span (0 automatic) — the model's real
 *   shape, resampled. Facts only.
 * - `igaRefineModel` refines EXACTLY — degree elevation (`elevate`) then knot
 *   insertion splitting each span (`subdivisions`) — and returns the refined
 *   model serialized back as CAD JSON for a one-shot write. Geometry, fields
 *   and a trimmed face's loops are unchanged; only the representation
 *   (degrees, knot vectors, control nets) grows.
 * - `igaEvaluateModel` evaluates one face at parametric coordinates, with
 *   first derivatives + unit normals and the inside/outside-of-trimming-loops
 *   flag on request.
 *
 * **No side channel crosses the IPC boundary**: every function takes the raw
 * file bytes, stages them itself, and does read → iga op → (serialize) →
 * delete inside the kernel worker. That is deliberate — `CadJsonInfo` carries
 * `BigInt64Array` fields (`controlPointIds`), which `kernelIpc.marshal`
 * refuses, and the info objects can be large; the tools only ever see plain
 * numbers and arrays.
 *
 * A STEP/IGES read attaches the SAME `format: "cad_json"` side channel in the
 * full artifact (upstream-verified), so `iga_sample`/`iga_evaluate` accept
 * B-rep sources too — evaluating the exact analytic faces of a STEP file.
 * `iga_refine` always writes CAD JSON: it is the representation the refined
 * model serializes to. MFEM NURBS meshes (`MfemInfo`) have the same upstream
 * operations but are NOT routed in this repo — every function refuses a
 * non-`cad_json` info by name rather than silently operating on the wrong
 * model.
 */

import { getMeshio, wrapMeshioFault } from "./meshioService";

/**
 * How a STEP/IGES source is read (meshio++ 18.3 `readMeshSelective`'s
 * `cadRead`, full artifact only). Ignored — with a warning — for `.cad.json`.
 * A length or angle of 0 or less is upstream's "automatic", not an error.
 */
export interface CadReadOptions {
  /** Linear deflection of the triangulation (a length; <= 0 automatic). */
  deflection?: number;
  /** Angular deflection in radians (upstream default 0.5). */
  angularDeflection?: number;
  /** Heal the shape (`ShapeFix_Shape`, then sewing) before it is extracted. */
  heal?: boolean;
  /** Sewing tolerance (<= 0 automatic); a positive value sews without `heal`. */
  sewTolerance?: number;
}

/** The heal report meshio++ attaches to the side channel's file-level `extra`. */
export interface CadHealReport {
  healed?: boolean;
  fixed?: boolean;
  sewTolerance?: number;
  freeEdgesBefore?: number;
  freeEdgesAfter?: number;
  multipleEdges?: number;
  degenerated?: number;
}

export interface IgaModelOptions {
  /** STEP/IGES read settings (see {@link CadReadOptions}). */
  cadRead?: CadReadOptions;
  /** Cells per knot span and direction of the sampling; 0 is automatic. */
  sampleSubdivisions?: number;
  /** Points per knot span a trimming curve is sampled at (2..4096). */
  trimSamples?: number;
  /** Sample the edges that have a 3-D curve. */
  edges?: boolean;
  /** Keep only the cells inside the trimming loops. */
  trim?: boolean;
}

export interface IgaPatchFacts {
  /** Degree per parametric direction (always 2 for a CAD JSON surface). */
  degrees: number[];
  /** Knot spans per direction (`knots[k].length - degrees[k] - 1`). */
  knotSpans: number[];
  /** Control net size (points). */
  controlPoints: number;
  /** Whether the patch is rational (NURBS rather than B-spline). */
  rational: boolean;
}

/** The B-rep's own inventory, straight from the file's side channel. */
export interface IgaModelFacts {
  format: "cad_json";
  breps: number;
  faces: number;
  trimmedFaces: number;
  rationalFaces: number;
  edges: number;
  vertices: number;
  perPatch: IgaPatchFacts[];
}

export interface IgaMeshFacts {
  dim: number;
  points: number;
  /** Cell type → cell count (meshio++ groups same-type cells into blocks). */
  cells: Record<string, number>;
  boundsMin: number[];
  boundsMax: number[];
}

export interface IgaSampleReport {
  /** Present when the read healed or sewed the shape (`cadRead`). */
  heal?: CadHealReport;
  model: IgaModelFacts;
  sampled: IgaMeshFacts;
  warnings: string[];
}

export interface IgaRefineOptions extends IgaModelOptions {
  /** Knot-insertion splits per span — one number, or one per direction. */
  subdivisions?: number | number[];
  /** Degree elevation per direction — one number, or one per direction. */
  elevate?: number | number[];
}

export interface IgaRefineReport {
  format: "cad_json";
  /** Present when the read healed or sewed the shape (`cadRead`). */
  heal?: CadHealReport;
  before: IgaModelFacts;
  after: IgaModelFacts;
  /** The refined model's own sampling (its rendered-cell inventory). */
  sampled: IgaMeshFacts;
  warnings: string[];
}

export interface IgaRefineResult {
  /** The refined model, serialized back as CAD JSON. */
  refinedBytes: Uint8Array;
  report: IgaRefineReport;
}

export interface IgaEvaluateOptions {
  /** STEP/IGES read settings (see {@link CadReadOptions}). */
  cadRead?: CadReadOptions;
  /** 1 adds first derivatives and (a surface's) unit normals. */
  derivatives?: number;
  /** Points per knot span a trimming curve is sampled at (2..4096). */
  trimSamples?: number;
}

export interface IgaEvaluateReport {
  format: "cad_json";
  face: number;
  spaceDim: number;
  /** Evaluated points, flattened (parametric-dim numbers per point). */
  pointCount: number;
  points: number[];
  derivatives?: number[];
  normals?: number[];
  /** 1 where the face's trimming loops contain the point (B-rep faces only). */
  inside?: number[];
  /** Present when the read healed or sewed the shape (`cadRead`). */
  heal?: CadHealReport;
  warnings: string[];
}

// Host-side MEMFS paths: ≤ 10 characters, fixed because the format is always
// passed explicitly (no extension sniffing, no companions, single-threaded
// handler — the same shape `stageMeshioSource`'s `/in.<format>` uses).
const READ_PATH = "/m.json";
const WRITE_PATH = "/r.json";

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Validates `cadRead` and builds the argument passed to meshio++ — only the
 * keys the caller set (a default read stays byte-identical to 18.1). `null`
 * is tolerated: `undefined` crosses `kernelIpc` as `null`. */
export function buildCadRead(cadRead: CadReadOptions | null | undefined): Record<string, unknown> | undefined {
  if (cadRead == null) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of ["deflection", "angularDeflection", "sewTolerance"] as const) {
    const v = cadRead[key];
    if (v == null) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`cadRead.${key} must be a finite number (got ${String(v)})`);
    out[key] = v;
  }
  if (cadRead.heal != null) {
    if (typeof cadRead.heal !== "boolean") throw new Error(`cadRead.heal must be a boolean (got ${String(cadRead.heal)})`);
    out.heal = cadRead.heal;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The heal report from the side channel's JSON `extra`, tolerant of absence. */
export function healReportOf(info: Record<string, unknown>): CadHealReport | undefined {
  const extra = info.extra;
  if (typeof extra !== "string") return undefined;
  let heal: Record<string, unknown> | undefined;
  try {
    heal = (JSON.parse(extra) as { heal?: Record<string, unknown> }).heal;
  } catch {
    return undefined;
  }
  if (!heal || typeof heal !== "object") return undefined;
  return {
    healed: typeof heal.healed === "boolean" ? heal.healed : undefined,
    fixed: typeof heal.fixed === "boolean" ? heal.fixed : undefined,
    sewTolerance: num(heal.sew_tolerance),
    freeEdgesBefore: num(heal.free_edges_before),
    freeEdgesAfter: num(heal.free_edges_after),
    multipleEdges: num(heal.multiple_edges),
    degenerated: num(heal.degenerated),
  };
}

/** Reads the staged file's `cad_json` side channel (shared by the three tools). */
function readIgaSideChannel(
  m: any,
  meshioFormat: string,
  cadRead: CadReadOptions | null | undefined
): { info: Record<string, unknown>; heal?: CadHealReport; warnings: string[] } {
  const warnings: string[] = [];
  const cad = buildCadRead(cadRead);
  const isBrep = meshioFormat === "step" || meshioFormat === "iges";
  if (cad && !isBrep) warnings.push("cadRead applies to STEP/IGES sources only — ignored for a CAD JSON model.");
  const readOptions: Record<string, unknown> = { format: meshioFormat, info: true };
  if (cad && isBrep) readOptions.cadRead = cad;
  const selective: Record<string, unknown> = m.readMeshSelective(READ_PATH, readOptions);
  const info = selective.info as Record<string, unknown> | undefined;
  if (!info || info.format !== "cad_json") {
    throw new Error("The file has no CAD JSON side channel — iga_* tools need a Kratos CAD JSON NURBS model (.cad.json).");
  }
  return { info, heal: healReportOf(info), warnings };
}

function perDirection(name: string, value: number | number[] | undefined): number | number[] | undefined {
  if (value === undefined) return undefined;
  const ok = (v: number) => Number.isInteger(v) && v >= 0;
  if (typeof value === "number") {
    if (!ok(value)) throw new Error(`${name} must be a non-negative integer (got ${value})`);
    return value;
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every(ok)) {
    throw new Error(`${name} must be a non-negative integer or a non-empty array of them (per direction)`);
  }
  return value;
}

function modelFacts(info: Record<string, unknown>): IgaModelFacts {
  const patches = (info.patches ?? []) as Array<{ degrees: number[]; knots: number[][]; controlPoints: ArrayLike<number>; weights: ArrayLike<number> }>;
  const faces = (info.faces ?? []) as Array<{ trimmed?: boolean; rational?: boolean }>;
  return {
    format: "cad_json",
    breps: ((info.breps ?? []) as unknown[]).length,
    faces: faces.length,
    trimmedFaces: faces.filter((f) => f.trimmed === true).length,
    rationalFaces: faces.filter((f) => f.rational === true).length,
    edges: ((info.edges ?? []) as unknown[]).length,
    vertices: ((info.vertices ?? []) as unknown[]).length,
    perPatch: patches.map((p) => ({
      degrees: [...p.degrees],
      knotSpans: p.degrees.map((d, k) => (p.knots[k]?.length ?? d + 2) - d - 1),
      controlPoints: Math.floor(p.controlPoints.length / 3),
      rational: p.weights.length > 0,
    })),
  };
}

function meshFacts(mesh: Record<string, unknown>): IgaMeshFacts {
  const dim = Number(mesh.dim ?? 3);
  const points = mesh.points as ArrayLike<number>;
  const stride = dim === 3 ? 3 : dim;
  const count = Math.floor(points.length / stride);
  const boundsMin = new Array<number>(stride).fill(Infinity);
  const boundsMax = new Array<number>(stride).fill(-Infinity);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < stride; k++) {
      const v = points[i * stride + k];
      if (v < boundsMin[k]) boundsMin[k] = v;
      if (v > boundsMax[k]) boundsMax[k] = v;
    }
  }
  const cells: Record<string, number> = {};
  for (const c of (mesh.cells ?? []) as Array<{ type: string; data: ArrayLike<number>; nodesPerCell?: number }>) {
    const per = c.nodesPerCell ?? 1;
    cells[c.type] = (cells[c.type] ?? 0) + Math.floor(c.data.length / per);
  }
  return { dim, points: count, cells, boundsMin, boundsMax };
}

/**
 * Stages the file and reads its `cad_json` side channel — `format` is the
 * file's own meshio++ format name (`cad_json`, or `step`/`iges`: the full
 * artifact attaches the same `format: "cad_json"` side channel to a STEP/IGES
 * read, upstream-verified). Refuses anything else by name — MFEM NURBS meshes
 * carry the same upstream operations but are not a routed format here, and an
 * info-less read is not a NURBS model.
 */
async function readCadJsonInfo(
  bytes: Uint8Array,
  meshioFormat: string,
  options?: IgaModelOptions
): Promise<{ info: Record<string, unknown>; sampled: IgaMeshFacts; heal?: CadHealReport; warnings: string[] }> {
  const m = await getMeshio();
  try {
    m.FS.writeFile(READ_PATH, bytes);
    const { info, heal, warnings } = readIgaSideChannel(m, meshioFormat, options?.cadRead);
    const sampledOptions: Record<string, unknown> = {};
    if (options?.sampleSubdivisions !== undefined) sampledOptions.sampleSubdivisions = options.sampleSubdivisions;
    if (options?.trimSamples !== undefined) sampledOptions.trimSamples = options.trimSamples;
    if (options?.edges !== undefined) sampledOptions.edges = options.edges;
    if (options?.trim !== undefined) sampledOptions.trim = options.trim;
    const sampled = Object.keys(sampledOptions).length > 0 ? m.igaSample(info, sampledOptions) : m.igaSample(info);
    const faces = ((info.faces ?? []) as Array<{ trimmed?: boolean }>).length;
    if (faces === 0) warnings.push("The model declares no faces — the sampled cells come from the patches alone.");
    return { info, sampled: meshFacts((sampled as { mesh: Record<string, unknown> }).mesh), heal, warnings };
  } catch (err) {
    throw wrapMeshioFault(err);
  }
}

/** `iga_sample`: facts only — the model's B-rep inventory plus its sampled
 * cell inventory at the requested density. Nothing is written. */
export async function igaSampleModel(bytes: Uint8Array, meshioFormat: string, options: IgaModelOptions = {}): Promise<IgaSampleReport> {
  if (options.trimSamples !== undefined && !(Number.isInteger(options.trimSamples) && options.trimSamples >= 2 && options.trimSamples <= 4096)) {
    throw new Error(`trimSamples must be an integer within 2..4096 (got ${options.trimSamples})`);
  }
  if (options.sampleSubdivisions !== undefined && !(Number.isInteger(options.sampleSubdivisions) && options.sampleSubdivisions >= 0)) {
    throw new Error(`sampleSubdivisions must be a non-negative integer (got ${options.sampleSubdivisions})`);
  }
  const { info, sampled, heal, warnings } = await readCadJsonInfo(bytes, meshioFormat, options);
  return { ...(heal ? { heal } : {}), model: modelFacts(info), sampled, warnings };
}

/** `iga_refine`: exact refinement (degree elevation + knot insertion) of the
 * whole model, serialized back as CAD JSON bytes for a one-shot write at a
 * NEW path. */
export async function igaRefineModel(bytes: Uint8Array, meshioFormat: string, options: IgaRefineOptions = {}): Promise<IgaRefineResult> {
  const subdivisions = perDirection("subdivisions", options.subdivisions);
  const elevate = perDirection("elevate", options.elevate);
  if (options.sampleSubdivisions !== undefined && !(Number.isInteger(options.sampleSubdivisions) && options.sampleSubdivisions >= 0)) {
    throw new Error(`sampleSubdivisions must be a non-negative integer (got ${options.sampleSubdivisions})`);
  }
  if (options.trimSamples !== undefined && !(Number.isInteger(options.trimSamples) && options.trimSamples >= 2 && options.trimSamples <= 4096)) {
    throw new Error(`trimSamples must be an integer within 2..4096 (got ${options.trimSamples})`);
  }
  const sampling: Record<string, unknown> = {};
  if (options.sampleSubdivisions !== undefined) sampling.sampleSubdivisions = options.sampleSubdivisions;
  if (options.trimSamples !== undefined) sampling.trimSamples = options.trimSamples;
  if (options.edges !== undefined) sampling.edges = options.edges;
  if (options.trim !== undefined) sampling.trim = options.trim;

  const m = await getMeshio();
  try {
    m.FS.writeFile(READ_PATH, bytes);
    const { info, heal, warnings } = readIgaSideChannel(m, meshioFormat, options.cadRead);
    const before = modelFacts(info);
    const refineOptions: Record<string, unknown> = { ...sampling };
    if (subdivisions !== undefined) refineOptions.subdivisions = subdivisions;
    if (elevate !== undefined) refineOptions.elevate = elevate;
    const refined = m.igaRefine(info, refineOptions) as { mesh: Record<string, unknown>; info: Record<string, unknown> };
    const after = modelFacts(refined.info);
    m.writeMesh(WRITE_PATH, refined.mesh, "cad_json", { info: refined.info });
    const refinedBytes = new Uint8Array(m.FS.readFile(WRITE_PATH));
    if (before.faces !== after.faces) warnings.push(`Face count changed (${before.faces} → ${after.faces}) — refinement must not change it; the written file is suspect.`);
    return { refinedBytes, report: { format: "cad_json", ...(heal ? { heal } : {}), before, after, sampled: meshFacts(refined.mesh), warnings } };
  } catch (err) {
    throw wrapMeshioFault(err);
  }
}

/** `iga_evaluate`: one face at explicit parametric coordinates. All numbers
 * come back as plain arrays (this side of the IPC boundary never sees the
 * typed-array shapes meshio++ returns). */
export async function igaEvaluateModel(
  bytes: Uint8Array,
  meshioFormat: string,
  face: number,
  params: number[],
  options: IgaEvaluateOptions = {}
): Promise<IgaEvaluateReport> {
  if (!Number.isInteger(face) || face < 0) throw new Error(`face must be a non-negative integer (got ${face})`);
  if (!Array.isArray(params) || params.length === 0 || !params.every((v) => Number.isFinite(v))) {
    throw new Error("params must be a non-empty flat array of finite numbers (parametric-dim numbers per point)");
  }
  if (options.derivatives !== undefined && options.derivatives !== 0 && options.derivatives !== 1) {
    throw new Error(`derivatives must be 0 or 1 (got ${options.derivatives})`);
  }
  if (options.trimSamples !== undefined && !(Number.isInteger(options.trimSamples) && options.trimSamples >= 2 && options.trimSamples <= 4096)) {
    throw new Error(`trimSamples must be an integer within 2..4096 (got ${options.trimSamples})`);
  }

  const m = await getMeshio();
  try {
    m.FS.writeFile(READ_PATH, bytes);
    const { info, heal, warnings } = readIgaSideChannel(m, meshioFormat, options.cadRead);
    const faces = (info.faces ?? []) as unknown[];
    if (face >= faces.length) {
      throw new Error(`face ${face} is out of range — the model has ${faces.length} face(s), 0-based.`);
    }
    const evaluateOptions: Record<string, unknown> = {};
    if (options.derivatives !== undefined) evaluateOptions.derivatives = options.derivatives;
    if (options.trimSamples !== undefined) evaluateOptions.trimSamples = options.trimSamples;
    const r: Record<string, unknown> =
      Object.keys(evaluateOptions).length > 0 ? m.igaEvaluate(info, face, params, evaluateOptions) : m.igaEvaluate(info, face, params);

    const spaceDim = Number(r.spaceDim ?? 3);
    const paramDim = 2; // every CAD JSON face is a surface
    const pointCount = Math.floor(params.length / paramDim);
    const inside = r.inside as Uint8Array | undefined;
    if (inside) {
      const outside = Array.from(inside).filter((v) => Number(v) === 0).length;
      if (outside > 0) warnings.push(`${outside} of ${pointCount} evaluated points lie OUTSIDE the face's trimming loops (inside: 0).`);
    }
    return {
      format: "cad_json",
      face,
      spaceDim,
      pointCount,
      points: Array.from(r.points as ArrayLike<number>, Number),
      ...(r.derivatives ? { derivatives: Array.from(r.derivatives as ArrayLike<number>, Number) } : {}),
      ...(r.normals ? { normals: Array.from(r.normals as ArrayLike<number>, Number) } : {}),
      ...(inside ? { inside: Array.from(inside, Number) } : {}),
      ...(heal ? { heal } : {}),
      warnings,
    };
  } catch (err) {
    throw wrapMeshioFault(err);
  }
}
