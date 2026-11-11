// MCP handlers for the meshio++ 20 scan / metrology / surface-editing tools.
// Split out of `mcpTools.ts` (which only grows by the shared helpers it exports)
// so the family is one readable unit. Same conventions as `register_meshes`:
// validate caller input fast, read the mesh as its triangle surface through
// `resolveSurfaceStl` (pending edits baked; a B-rep returns `supported:false`),
// refuse an output path that is a source, report FACTS (meshio++'s own numbers
// and warnings, enveloped as untrusted text) and never a verdict.

import * as fs from "fs/promises";
import * as path from "path";
import { assertNotSourcePath } from "./mcpSidecars";
import { envelope } from "./untrustedText";
import { requireNonNegative, resolveSurfaceStl, type ToolContext } from "./mcpTools";
import type { MeasureScanSpec, DeviationScanSpec, AlignScanSpec, SurfaceSectionsSpec, SurfaceEditSpec, ScanToCadSpec } from "./meshioScan";

type Supported<T> = ({ supported: true; written?: string } & T) | { supported: false; warnings: string[] };

// -- shared validation ------------------------------------------------------

function vec3(name: string, v: unknown, { nonZero = false }: { nonZero?: boolean } = {}): number[] {
  if (!(Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)))) {
    throw new Error(`${name} must be three finite numbers.`);
  }
  if (nonZero && v.every((x) => x === 0)) throw new Error(`${name} must not be the zero vector.`);
  return v as number[];
}

function finiteList(name: string, v: unknown, { min = 1, multipleOf = 1, max = 100_000 }: { min?: number; multipleOf?: number; max?: number } = {}): number[] {
  if (!(Array.isArray(v) && v.length >= min && v.length <= max && v.length % multipleOf === 0 && v.every((x) => typeof x === "number" && Number.isFinite(x)))) {
    throw new Error(`${name} must be a list of finite numbers${multipleOf > 1 ? ` (a multiple of ${multipleOf})` : ""}${min > 0 ? `, at least ${min}` : ""}.`);
  }
  return v as number[];
}

function positive(name: string, v: number | undefined): void {
  if (v !== undefined && !(Number.isFinite(v) && v > 0)) throw new Error(`${name} must be a positive number (got ${String(v)}).`);
}

function oneOf<T extends string>(name: string, v: T | undefined, allowed: readonly T[]): void {
  if (v !== undefined && !allowed.includes(v)) throw new Error(`${name} must be one of ${allowed.join(", ")} (got ${String(v)}).`);
}

/** Resolves an optional output path: not a source, with an extension that selects the format. */
function outputOf(inputs: Array<string | undefined>, outputPath: string | undefined, { stepAllowed = false, stepOnly = false }: { stepAllowed?: boolean; stepOnly?: boolean } = {}): { resolved?: string; ext?: string; isStep: boolean } {
  if (outputPath === undefined) return { isStep: false };
  const resolved = path.resolve(outputPath);
  for (const i of inputs) if (i) assertNotSourcePath(i, resolved);
  const ext = path.basename(resolved).split(".").slice(1).join(".").toLowerCase();
  if (!ext) throw new Error("outputPath needs a file extension (it selects the output format).");
  const isStep = ext === "step" || ext === "stp";
  if (stepOnly && !isStep) throw new Error("outputPath must end in .step or .stp (the elements are written as an AP214 STEP file).");
  if (isStep && !stepAllowed && !stepOnly) throw new Error("outputPath: a STEP file is not a mesh format this tool writes; use a mesh extension (.vtu, .ply, .msh, ...).");
  return { resolved, ext: isStep ? undefined : ext, isStep };
}

function warn(list: string[], prefix: string): string[] {
  return list.map((w) => envelope(w, prefix));
}

/** STL holds triangles only: a tool whose point is data on the mesh says so when it is asked to write one. */
function dataLossWarning(ext: string | undefined, what: string): string[] {
  return ext === "stl" ? [`.stl cannot hold ${what}; the geometry is written without it -- use .vtu, .ply or .msh to keep it.`] : [];
}

async function source(ctx: ToolContext, tool: string, p: string, warnings: string[], label = "path"): Promise<{ stl: Uint8Array } | { fail: { supported: false; warnings: string[] } }> {
  const r = await resolveSurfaceStl(ctx, p, tool, warnings);
  if ("unsupported" in r) return { fail: { supported: false, warnings: [label === "path" ? r.unsupported : `${label}: ${r.unsupported}`] } };
  return { stl: r.stl };
}

async function save(bytes: Uint8Array | undefined, resolved: string | undefined): Promise<string | undefined> {
  if (!bytes || !resolved) return undefined;
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, bytes);
  return resolved;
}

// -- measure ----------------------------------------------------------------

export async function measureMeshTool(
  ctx: ToolContext,
  params: { path: string; spec: object | string; alignDatums?: { primary: string; secondary: string; origin?: string }; primitives?: string[]; outputPath?: string }
): Promise<Supported<{ report: unknown; numFail: number; datum?: unknown; primitives?: unknown; warnings: string[] }>> {
  if (!(typeof params.spec === "string" ? params.spec.trim().length > 0 : typeof params.spec === "object" && params.spec !== null)) throw new Error("spec must be a measure spec object or its JSON text.");
  const out = outputOf([params.path], params.outputPath);
  const warnings: string[] = [];
  const src = await source(ctx, "measure_mesh", params.path, warnings);
  if ("fail" in src) return src.fail;
  const spec: MeasureScanSpec = { spec: params.spec, alignDatums: params.alignDatums, primitives: params.primitives };
  const r = await ctx.pipeline.measureScan(src.stl, spec, out.ext);
  const written = await save(r.bytes, out.resolved);
  return {
    supported: true, report: r.report, numFail: r.numFail,
    ...(r.datum ? { datum: r.datum } : {}), ...(r.primitives ? { primitives: r.primitives } : {}),
    ...(written ? { written } : {}),
    warnings: [...warnings, ...warn(r.warnings, "meshio warning"), ...dataLossWarning(out.ext, "the element table")],
  };
}

// -- deviation --------------------------------------------------------------

export interface AnalyzeDeviationParams {
  path: string;
  referencePath?: string;
  primitive?: { type: "plane" | "sphere" | "cylinder" | "cone" | "torus"; params: number[] };
  tolerance?: number;
  bins?: number;
  range?: [number, number];
  maxNormalAngle?: number;
  referenceRegion?: string;
  register?: boolean;
  regionTolerance?: number;
  regionMinArea?: number;
  exaggerate?: { scale?: number; clamp?: number; smoothFraction?: number };
  colorize?: { cmap?: string; vmin?: number; vmax?: number; symmetric?: boolean; steps?: number };
  outputPath?: string;
}

export async function analyzeDeviationTool(ctx: ToolContext, params: AnalyzeDeviationParams): Promise<Supported<Record<string, unknown> & { warnings: string[] }>> {
  if ((params.referencePath === undefined) === (params.primitive === undefined)) throw new Error("Give exactly one of referencePath (a reference surface) or primitive (a fitted primitive).");
  if (params.primitive) finiteList("primitive.params", params.primitive.params, { min: 10, max: 10 });
  requireNonNegative("tolerance", params.tolerance);
  requireNonNegative("maxNormalAngle", params.maxNormalAngle);
  positive("regionTolerance", params.regionTolerance);
  requireNonNegative("regionMinArea", params.regionMinArea);
  if (params.bins !== undefined && !(Number.isInteger(params.bins) && params.bins >= 1 && params.bins <= 1000)) throw new Error("bins must be an integer between 1 and 1000.");
  if (params.range !== undefined) finiteList("range", params.range, { min: 2, max: 2 });
  if ((params.exaggerate || params.colorize) && params.outputPath === undefined) throw new Error("exaggerate and colorize produce a mesh: give outputPath.");
  const out = outputOf([params.path, params.referencePath], params.outputPath);
  const warnings: string[] = [];
  const scan = await source(ctx, "analyze_deviation", params.path, warnings);
  if ("fail" in scan) return scan.fail;
  let reference: Uint8Array | null = null;
  if (params.referencePath !== undefined) {
    const ref = await source(ctx, "analyze_deviation", params.referencePath, warnings, "referencePath");
    if ("fail" in ref) return ref.fail;
    reference = ref.stl;
  }
  const spec: DeviationScanSpec = {
    primitive: params.primitive, tolerance: params.tolerance, bins: params.bins, range: params.range, maxNormalAngle: params.maxNormalAngle,
    referenceRegion: params.referenceRegion, register: params.register,
    ...(params.regionTolerance !== undefined ? { regions: { tolerance: params.regionTolerance, ...(params.regionMinArea !== undefined ? { minArea: params.regionMinArea } : {}) } } : {}),
    exaggerate: params.exaggerate, colorize: params.colorize,
  };
  const { bytes, warnings: kernelWarnings, ...facts } = await ctx.pipeline.deviationScan(scan.stl, reference, spec, out.ext);
  const written = await save(bytes, out.resolved);
  return { supported: true, ...facts, ...(written ? { written } : {}), warnings: [...warnings, ...warn(kernelWarnings, "meshio warning"), ...dataLossWarning(out.ext, "the deviation field or colours")] };
}

// -- registration -----------------------------------------------------------

export async function registerLandmarksTool(
  ctx: ToolContext,
  params: { source: number[]; target: number[]; weights?: number[]; path?: string; outputPath?: string }
): Promise<Supported<Record<string, unknown> & { warnings: string[] }>> {
  const src = finiteList("source", params.source, { min: 9, multipleOf: 3 });
  const tgt = finiteList("target", params.target, { min: 9, multipleOf: 3 });
  if (src.length !== tgt.length) throw new Error("source and target must hold the same number of points.");
  if (params.weights !== undefined) {
    finiteList("weights", params.weights, { min: src.length / 3, max: src.length / 3 });
    if (params.weights.some((w) => w < 0)) throw new Error("weights must be non-negative.");
  }
  if (params.outputPath !== undefined && params.path === undefined) throw new Error("outputPath writes the moved mesh: give path as well.");
  const out = outputOf([params.path], params.outputPath);
  const warnings: string[] = [];
  let stl: Uint8Array | null = null;
  if (params.path !== undefined) {
    const s = await source(ctx, "register_landmarks", params.path, warnings);
    if ("fail" in s) return s.fail;
    stl = s.stl;
  }
  const { bytes, warnings: kw, mode: _m, ...facts } = await ctx.pipeline.alignScan(stl, { mode: "landmarks", source: src, target: tgt, weights: params.weights }, out.ext);
  void _m;
  const written = await save(bytes, out.resolved);
  return { supported: true, ...facts, ...(written ? { written } : {}), warnings: [...warnings, ...warn(kw, "meshio warning")] };
}

export async function findSymmetryPlaneTool(
  ctx: ToolContext,
  params: { path: string; seedOrigin?: number[]; seedNormal?: number[]; tolerance?: number; minShare?: number; maxSamples?: number; maxIterations?: number }
): Promise<Supported<Record<string, unknown> & { warnings: string[] }>> {
  if (params.seedOrigin !== undefined) vec3("seedOrigin", params.seedOrigin);
  if (params.seedNormal !== undefined) vec3("seedNormal", params.seedNormal, { nonZero: true });
  requireNonNegative("tolerance", params.tolerance);
  if (params.minShare !== undefined && !(params.minShare >= 0 && params.minShare <= 1)) throw new Error("minShare must be between 0 and 1.");
  const warnings: string[] = [];
  const s = await source(ctx, "find_symmetry_plane", params.path, warnings);
  if ("fail" in s) return s.fail;
  const { path: _p, ...rest } = params;
  void _p;
  const { bytes: _b, warnings: kw, mode: _m, ...facts } = await ctx.pipeline.alignScan(s.stl, { mode: "symmetry", ...rest });
  void _b; void _m;
  return { supported: true, ...facts, warnings: [...warnings, ...warn(kw, "meshio warning")] };
}

export async function autoAlignScanTool(
  ctx: ToolContext,
  params: { path: string; angleTolerance?: number; subdivisions?: number; region?: string; rotateVectorData?: boolean; outputPath?: string }
): Promise<Supported<Record<string, unknown> & { warnings: string[] }>> {
  requireNonNegative("angleTolerance", params.angleTolerance);
  const out = outputOf([params.path], params.outputPath);
  const warnings: string[] = [];
  const s = await source(ctx, "auto_align_scan", params.path, warnings);
  if ("fail" in s) return s.fail;
  const { path: _p, outputPath: _o, ...rest } = params;
  void _p; void _o;
  const { bytes, warnings: kw, mode: _m, ...facts } = await ctx.pipeline.alignScan(s.stl, { mode: "auto", ...rest }, out.ext);
  void _m;
  const written = await save(bytes, out.resolved);
  return { supported: true, ...facts, ...(written ? { written } : {}), warnings: [...warnings, ...warn(kw, "meshio warning")] };
}

// -- sections / silhouette / curves / clip ----------------------------------

async function sectionsRun(ctx: ToolContext, tool: string, params: { path: string; outputPath?: string }, spec: SurfaceSectionsSpec) {
  const out = outputOf([params.path], params.outputPath);
  const warnings: string[] = [];
  const s = await source(ctx, tool, params.path, warnings);
  if ("fail" in s) return s.fail;
  const { bytes, warnings: kw, ...facts } = await ctx.pipeline.surfaceSections(s.stl, spec, out.ext);
  const written = await save(bytes, out.resolved);
  return { supported: true as const, ...facts, ...(written ? { written } : {}), warnings: [...warnings, ...warn(kw, "meshio warning")] };
}

export async function meshSectionsTool(ctx: ToolContext, params: { path: string; direction: number[]; offsets: number[]; minLength?: number; outputPath?: string }) {
  vec3("direction", params.direction, { nonZero: true });
  finiteList("offsets", params.offsets, { min: 1, max: 1000 });
  requireNonNegative("minLength", params.minLength);
  return sectionsRun(ctx, "mesh_sections", params, { kind: "sections", direction: params.direction, offsets: params.offsets, minLength: params.minLength });
}

export async function meshSilhouetteTool(
  ctx: ToolContext,
  params: { path: string; normal?: number[]; clearance?: number; roundAngle?: number; arcSegments?: number; extrude?: boolean; region?: string; mergeTolerance?: number; outputPath?: string }
) {
  if (params.normal !== undefined) vec3("normal", params.normal, { nonZero: true });
  positive("roundAngle", params.roundAngle);
  requireNonNegative("mergeTolerance", params.mergeTolerance);
  const { path: p, outputPath, ...rest } = params;
  return sectionsRun(ctx, "mesh_silhouette", { path: p, outputPath }, { kind: "silhouette", ...rest });
}

export async function fitMeshCurvesTool(
  ctx: ToolContext,
  params: { path: string; direction: number[]; offsets: number[]; minLength?: number; tolerance?: number; snapAngle?: number; normal?: number[]; minArcPoints?: number; minArcSweep?: number; outputPath?: string }
) {
  vec3("direction", params.direction, { nonZero: true });
  finiteList("offsets", params.offsets, { min: 1, max: 1000 });
  requireNonNegative("minLength", params.minLength);
  positive("tolerance", params.tolerance);
  if (params.normal !== undefined) vec3("normal", params.normal, { nonZero: true });
  const { path: p, outputPath, ...rest } = params;
  return sectionsRun(ctx, "fit_mesh_curves", { path: p, outputPath }, { kind: "fitCurves", ...rest });
}

export async function clipMeshTool(ctx: ToolContext, params: { path: string; origin: number[]; normal: number[]; keepBelow?: boolean; cap?: boolean; outputPath?: string }) {
  vec3("origin", params.origin);
  vec3("normal", params.normal, { nonZero: true });
  const { path: p, outputPath, ...rest } = params;
  return sectionsRun(ctx, "clip_mesh", { path: p, outputPath }, { kind: "clip", ...rest });
}

// -- surface editing --------------------------------------------------------

async function editRun(ctx: ToolContext, tool: string, params: { path: string; outputPath?: string }, spec: SurfaceEditSpec, { outputRequired }: { outputRequired: boolean }) {
  if (outputRequired && params.outputPath === undefined) throw new Error("outputPath is required: this tool produces a mesh.");
  const out = outputOf([params.path], params.outputPath);
  const warnings: string[] = [];
  const s = await source(ctx, tool, params.path, warnings);
  if ("fail" in s) return s.fail;
  const { bytes, warnings: kw, ...facts } = await ctx.pipeline.surfaceEdit(s.stl, spec, out.ext);
  const written = await save(bytes, out.resolved);
  return { supported: true as const, ...facts, ...(written ? { written } : {}), warnings: [...warnings, ...warn(kw, "meshio warning")] };
}

export async function offsetMeshSurfaceTool(
  ctx: ToolContext,
  params: { path: string; mode: "offset" | "thicken" | "hollow"; distance: number; side?: "inward" | "outward" | "both"; smoothIterations?: number; outputPath: string }
) {
  oneOf("mode", params.mode, ["offset", "thicken", "hollow"]);
  oneOf("side", params.side, ["inward", "outward", "both"]);
  if (!Number.isFinite(params.distance)) throw new Error("distance must be a finite number.");
  if (params.mode !== "offset" && !(params.distance > 0)) throw new Error(`${params.mode} needs a positive distance (the ${params.mode === "thicken" ? "wall thickness" : "wall"}).`);
  if (params.smoothIterations !== undefined && !(Number.isInteger(params.smoothIterations) && params.smoothIterations >= 0)) throw new Error("smoothIterations must be a non-negative integer.");
  const base = { path: params.path, outputPath: params.outputPath };
  const spec: SurfaceEditSpec =
    params.mode === "offset" ? { kind: "offset", distance: params.distance, smoothIterations: params.smoothIterations }
    : params.mode === "thicken" ? { kind: "thicken", thickness: params.distance, side: params.side, smoothIterations: params.smoothIterations }
    : { kind: "hollow", wall: params.distance, smoothIterations: params.smoothIterations };
  return editRun(ctx, "offset_mesh_surface", base, spec, { outputRequired: true });
}

export async function flipMeshNormalsTool(ctx: ToolContext, params: { path: string; region?: string; outputPath: string }) {
  return editRun(ctx, "flip_mesh_normals", params, { kind: "flip", region: params.region }, { outputRequired: true });
}

export async function removeMeshIslandsTool(
  ctx: ToolContext,
  params: { path: string; connectivity?: "edge" | "point"; minDiagonal?: number; minArea?: number; minCells?: number; relative?: boolean; dryRun?: boolean; outputPath?: string }
) {
  oneOf("connectivity", params.connectivity, ["edge", "point"]);
  requireNonNegative("minDiagonal", params.minDiagonal);
  requireNonNegative("minArea", params.minArea);
  requireNonNegative("minCells", params.minCells);
  const { path: p, outputPath, ...rest } = params;
  return editRun(ctx, "remove_mesh_islands", { path: p, outputPath }, { kind: "islands", ...rest }, { outputRequired: params.dryRun !== true });
}

// -- scan -> CAD ------------------------------------------------------------

const FIT_TYPES = ["plane", "sphere", "cylinder", "cone", "torus"] as const;

function checkSegmentFit(p: { featureAngle?: number; tolerance?: number; minInlierFraction?: number; types?: string[] }): void {
  if (p.featureAngle !== undefined && !(p.featureAngle >= 0 && p.featureAngle <= 180)) throw new Error("featureAngle must be within 0..180 degrees.");
  positive("tolerance", p.tolerance);
  for (const t of p.types ?? []) oneOf("types", t as (typeof FIT_TYPES)[number], FIT_TYPES);
}

async function cadRun(ctx: ToolContext, tool: string, params: { path: string; outputPath?: string }, spec: ScanToCadSpec, o: { stepAllowed?: boolean; stepOnly?: boolean }) {
  const out = outputOf([params.path], params.outputPath, o);
  const warnings: string[] = [];
  const s = await source(ctx, tool, params.path, warnings);
  if ("fail" in s) return s.fail;
  const { bytes, stepBytes, warnings: kw, ...facts } = await ctx.pipeline.scanToCad(s.stl, spec, out.ext);
  const written = await save(out.isStep ? stepBytes : bytes, out.resolved);
  return { supported: true as const, ...facts, ...(written ? { written } : {}), warnings: [...warnings, ...warn(kw, "meshio warning")] };
}

export async function constrainPrimitivesTool(
  ctx: ToolContext,
  params: { path: string; featureAngle?: number; tolerance?: number; minInlierFraction?: number; types?: string[]; usedPoints?: "auto" | "all" | "3sigma" | "2sigma" | "1sigma";
    criterion?: "least_squares" | "minimum_zone" | "min_circumscribed" | "max_inscribed"; faceTolerance?: number; angleTolerance?: number; distanceTolerance?: number; minFraction?: number;
    force?: Array<[number, number, string]>; forbid?: Array<[number, number, string]>; outputPath?: string }
) {
  checkSegmentFit(params);
  requireNonNegative("faceTolerance", params.faceTolerance);
  requireNonNegative("angleTolerance", params.angleTolerance);
  requireNonNegative("distanceTolerance", params.distanceTolerance);
  const relations = ["coaxial", "parallel", "perpendicular", "equal_radius"];
  for (const r of [...(params.force ?? []), ...(params.forbid ?? [])]) {
    if (!(Array.isArray(r) && r.length === 3 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && relations.includes(r[2]))) throw new Error(`force/forbid entries are [patchA, patchB, relation] with relation one of ${relations.join(", ")}.`);
  }
  const { path: p, outputPath, ...rest } = params;
  return cadRun(ctx, "constrain_primitives", { path: p, outputPath }, { kind: "constrain", ...rest }, {});
}

export async function writeStepElementsTool(
  ctx: ToolContext,
  params: { path: string; featureAngle?: number; tolerance?: number; minInlierFraction?: number; types?: string[]; usedPoints?: "auto" | "all" | "3sigma" | "2sigma" | "1sigma";
    criterion?: "least_squares" | "minimum_zone" | "min_circumscribed" | "max_inscribed"; patches?: number[]; segments?: number; outputPath: string }
) {
  checkSegmentFit(params);
  if (params.patches !== undefined && !(Array.isArray(params.patches) && params.patches.every((x) => Number.isInteger(x) && x >= 0))) throw new Error("patches must be non-negative integer patch ids.");
  const { path: p, outputPath, ...rest } = params;
  return cadRun(ctx, "write_step_elements", { path: p, outputPath }, { kind: "stepElements", ...rest }, { stepOnly: true });
}

export async function profileToSolidTool(
  ctx: ToolContext,
  params: { path: string; direction: number[]; offset: number; features: string; tolerance?: number; provider?: string; deflection?: number; outputPath: string }
) {
  vec3("direction", params.direction, { nonZero: true });
  if (!Number.isFinite(params.offset)) throw new Error("offset must be a finite number.");
  if (typeof params.features !== "string" || params.features.trim().length === 0) throw new Error("features must be a feature string such as 'extrude:10;fillet:0.5'.");
  positive("tolerance", params.tolerance);
  const out = outputOf([params.path], params.outputPath, { stepAllowed: true });
  const { path: p, outputPath, ...rest } = params;
  return cadRun(ctx, "profile_to_solid", { path: p, outputPath }, { kind: "profileSolid", ...rest, step: out.isStep }, { stepAllowed: true });
}

export async function fitCadIterateTool(
  ctx: ToolContext,
  params: { path: string; partClass?: "any" | "analytic" | "cast" | "freeform"; targetWithin?: number; targetExplained?: number; segmentTolerance?: number; fitTolerance?: number;
    maxRounds?: number; worstFaces?: number; refineFactor?: number; backend?: "auto" | "occt" | "native"; faceSupport?: boolean; supportTolerance?: number; outputPath?: string }
) {
  oneOf("partClass", params.partClass, ["any", "analytic", "cast", "freeform"]);
  oneOf("backend", params.backend, ["auto", "occt", "native"]);
  if (params.maxRounds !== undefined && !(Number.isInteger(params.maxRounds) && params.maxRounds >= 1 && params.maxRounds <= 20)) throw new Error("maxRounds must be an integer between 1 and 20.");
  for (const k of ["targetWithin", "targetExplained"] as const) if (params[k] !== undefined && !(params[k]! >= 0 && params[k]! <= 1)) throw new Error(`${k} must be a share between 0 and 1.`);
  positive("segmentTolerance", params.segmentTolerance);
  positive("fitTolerance", params.fitTolerance);
  requireNonNegative("supportTolerance", params.supportTolerance);
  const out = outputOf([params.path], params.outputPath, { stepAllowed: true });
  const { path: p, outputPath, ...rest } = params;
  return cadRun(ctx, "fit_cad_iterate", { path: p, outputPath }, { kind: "fitCadIterate", ...rest, stepPath: out.isStep }, { stepAllowed: true });
}
