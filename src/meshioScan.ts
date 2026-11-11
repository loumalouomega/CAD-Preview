// meshio++ 20 scan / metrology / surface-editing calls over triangle surfaces
// given as STL bytes (the boundary every mesh-format source funnels through).
// One kernel function per family so the `Pipeline` grows by six entries:
//
//   measureScan      measure, alignDatums, measureElementPrimitive
//   deviationScan    deviation, deviationRegions, exaggerate, colorize
//   alignScan        registerLandmarks, findSymmetryPlane, autoAlign
//   surfaceSections  sections, silhouette, fitCurves, clip
//   surfaceEdit      offsetSurface, thicken, hollow, flipNormals, removeIslands
//   scanToCad        segment + fitPrimitives + constrainPrimitives / writeStepElements,
//                    profileSolid, fitCadIterate (+ faceSupport) — FULL artifact
//
// Facts only: every reply carries meshio++'s own numbers and warnings, never a
// verdict. Meshes are GC'd JS values (no handle cleanup); only the MEMFS paths
// are unlinked. Plain-JSON results: typed arrays and BigInt64Arrays become
// number arrays and a non-finite number becomes `null` (JSON would lose it).

import { getMeshio, wrapMeshioFault } from "./meshioService";

/** Largest list returned inline (regions, pieces, per-face shares); the true counts are always reported. */
export const SCAN_MAX_LISTED = 500;

type Mesh = any;

/** Typed arrays -> number arrays, BigInt -> number, non-finite -> null, big lists capped by the caller. */
export function plain(v: unknown): any {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as unknown as ArrayLike<number | bigint>, (x) => plain(x));
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = plain(x);
    return out;
  }
  return v;
}

/** Copies the defined keys of `src` named in `keys` (so a default call is byte-identical to upstream's). */
function defined(src: object, keys: readonly string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of keys) {
    const x = (src as Record<string, unknown>)[k];
    if (x !== undefined && x !== null) o[k] = x;
  }
  return o;
}

function words(v: unknown): string[] {
  return Array.isArray(v) ? v.map((w) => String(w)) : [];
}

class Scope {
  private paths: string[] = [];
  constructor(readonly m: any) {}
  /** Stage STL bytes and read them as a mesh. `Buffer`s can be pool views: copy first. */
  stl(bytes: Uint8Array, name: string): Mesh {
    const p = `/${name}.stl`;
    this.m.FS.writeFile(p, bytes.slice());
    this.paths.push(p);
    return this.m.readMesh(p, "stl");
  }
  /** Write `mesh` in the format of `extension` and read the bytes back. */
  write(mesh: Mesh, extension: string): Uint8Array {
    const p = `/so.${extension}`;
    this.paths.push(p);
    this.m.writeMesh(p, mesh);
    return this.m.FS.readFile(p) as Uint8Array;
  }
  scratch(name: string): string {
    const p = `/${name}`;
    this.paths.push(p);
    return p;
  }
  read(p: string): Uint8Array {
    return this.m.FS.readFile(p) as Uint8Array;
  }
  close(): void {
    for (const p of this.paths) {
      try { this.m.FS.unlink(p); } catch { /* never written */ }
    }
  }
}

async function run<T>(fn: (s: Scope, m: any) => T): Promise<T> {
  const m = await getMeshio();
  const scope = new Scope(m);
  try {
    return fn(scope, m);
  } catch (err) {
    throw wrapMeshioFault(err);
  } finally {
    scope.close();
  }
}

function applyMatrix(mesh: Mesh, matrix: ArrayLike<number>): Mesh {
  const dim = mesh.dim as number;
  const p = mesh.points as ArrayLike<number>;
  const moved = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += dim) {
    const x = p[i], y = p[i + 1], z = dim > 2 ? p[i + 2] : 0;
    moved[i] = matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3];
    moved[i + 1] = matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7];
    if (dim > 2) moved[i + 2] = matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11];
  }
  return { ...mesh, points: moved };
}

function countDistinct(mesh: Mesh, key: string): number {
  const blocks = mesh.cell_data?.[key] as ArrayLike<number | bigint>[] | undefined;
  const seen = new Set<number>();
  for (const b of blocks ?? []) for (let i = 0; i < b.length; i++) seen.add(Number(b[i]));
  return seen.size;
}

function countCells(mesh: Mesh, type?: string): number {
  let n = 0;
  for (const b of mesh.cells as Array<{ type: string; data: ArrayLike<unknown>; nodesPerCell?: number }>) {
    if (type && b.type !== type) continue;
    n += Math.floor(b.data.length / (b.nodesPerCell ?? 1));
  }
  return n;
}

// ---------------------------------------------------------------------------
// measure

export interface MeasureScanSpec {
  /** The measure spec: `{elements, dimensions, tolerances}` (an object or its JSON text). */
  spec: object | string;
  /** After measuring, align on these datum elements (3-2-1: `primary` sets Z, `secondary` X, optional `origin`). */
  alignDatums?: { primary: string; secondary: string; origin?: string };
  /** Names of measured elements to also return as a fitted primitive (type + ten parameters), a deviation reference. */
  primitives?: string[];
}

export interface MeasureScanResult {
  /** meshio++'s own report: elements, dimensions, tolerances, num_fail, warnings. */
  report: any;
  numFail: number;
  datum?: { matrix: number[] };
  primitives?: Array<{ name: string; type: number; params: number[] }>;
  warnings: string[];
  /** The measured (and, with `alignDatums`, aligned) mesh with its element table, only when an output extension was given. */
  bytes?: Uint8Array;
}

export async function measureScan(stl: Uint8Array, spec: MeasureScanSpec, outExtension?: string): Promise<MeasureScanResult> {
  return run((s, m) => {
    let mesh = s.stl(stl, "ms0");
    const r = m.measure(mesh, spec.spec);
    mesh = r.mesh;
    const out: MeasureScanResult = { report: plain(r.report), numFail: Number(r.numFail), warnings: words(r.warnings) };
    if (spec.alignDatums) {
      const a = m.alignDatums(mesh, spec.alignDatums.primary, spec.alignDatums.secondary, spec.alignDatums.origin);
      mesh = a.mesh;
      out.datum = { matrix: plain(a.matrix) };
    }
    if (spec.primitives?.length) {
      out.primitives = spec.primitives.map((name) => {
        const p = m.measureElementPrimitive(mesh, name);
        return { name, type: Number(p.type), params: plain(p.params) };
      });
    }
    if (outExtension) out.bytes = s.write(mesh, outExtension);
    return out;
  });
}

// ---------------------------------------------------------------------------
// deviation

export interface DeviationScanSpec {
  /** A fitted primitive reference instead of a reference surface: type + the ten `fit:patch_params` numbers. */
  primitive?: { type: "plane" | "sphere" | "cylinder" | "cone" | "torus"; params: number[] };
  tolerance?: number;
  bins?: number;
  range?: [number, number];
  maxNormalAngle?: number;
  referenceRegion?: string;
  /** Register the scan to the reference first (ICP). */
  register?: boolean;
  /** Group the cells beyond ±tolerance into excess / missing-material regions. */
  regions?: { tolerance: number; minArea?: number };
  /** Displace the points along their normals by the deviation × scale (output only). */
  exaggerate?: { scale?: number; clamp?: number; smoothFraction?: number };
  /** Bake the deviation into red/green/blue data through a colormap (output only). */
  colorize?: { cmap?: string; vmin?: number; vmax?: number; symmetric?: boolean; steps?: number };
}

export interface DeviationScanResult {
  numPoints: number;
  numMeasured: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  rms: number | null;
  sigma: number | null;
  percentiles: Record<string, number | null>;
  histogram: { edges: number[]; counts: number[] };
  numOutsideRange: number;
  shareWithin: number | null;
  suggestedRange: number | null;
  numWithoutNormal: number;
  registered: boolean;
  matrix: number[];
  registrationRms: number | null;
  regions?: {
    numExcess: number;
    numMissing: number;
    numDropped: number;
    listed: any[];
    truncated: boolean;
  };
  warnings: string[];
  bytes?: Uint8Array;
}

export async function deviationScan(
  scanStl: Uint8Array,
  referenceStl: Uint8Array | null,
  spec: DeviationScanSpec,
  outExtension?: string
): Promise<DeviationScanResult> {
  if (!referenceStl && !spec.primitive) throw new Error("deviation needs a reference surface or a primitive.");
  if (referenceStl && spec.primitive) throw new Error("deviation takes a reference surface or a primitive, not both.");
  return run((s, m) => {
    const scan = s.stl(scanStl, "dv0");
    const o: Record<string, unknown> = defined(spec, ["primitive", "tolerance", "bins", "range", "maxNormalAngle", "referenceRegion", "register"]);
    if (referenceStl) o.reference = s.stl(referenceStl, "dv1");
    const d = m.deviation(scan, o);
    let mesh = d.mesh;
    const warnings = words(d.warnings);
    let regions: DeviationScanResult["regions"];
    if (spec.regions) {
      const r = m.deviationRegions(mesh, defined(spec.regions, ["tolerance", "minArea"]));
      mesh = r.mesh;
      warnings.push(...words(r.warnings));
      const list = (r.regions as any[]).slice(0, SCAN_MAX_LISTED).map(plain);
      regions = { numExcess: Number(r.numExcess), numMissing: Number(r.numMissing), numDropped: Number(r.numDropped), listed: list, truncated: r.regions.length > list.length };
    }
    if (spec.exaggerate) {
      const e = m.exaggerate(mesh, defined(spec.exaggerate, ["scale", "clamp", "smoothFraction"]));
      mesh = e.mesh;
      warnings.push(...words(e.warnings));
    }
    if (spec.colorize) {
      const c = m.colorize(mesh, { field: "deviation:distance", ...defined(spec.colorize, ["cmap", "vmin", "vmax", "symmetric", "steps"]) });
      mesh = c.mesh;
    }
    const pct = plain(d.percentiles) as Record<string, number | null>;
    const out: DeviationScanResult = {
      numPoints: Number(d.numPoints), numMeasured: Number(d.numMeasured),
      min: plain(d.min), max: plain(d.max), mean: plain(d.mean), rms: plain(d.rms), sigma: plain(d.sigma),
      percentiles: pct,
      histogram: { edges: plain(d.histogramEdges), counts: plain(d.histogramCounts) },
      numOutsideRange: Number(d.numOutsideRange),
      shareWithin: plain(d.shareWithin), suggestedRange: plain(d.suggestedRange),
      numWithoutNormal: Number(d.numWithoutNormal),
      registered: d.registered === true, matrix: plain(d.matrix), registrationRms: plain(d.registrationRms),
      ...(regions ? { regions } : {}),
      warnings,
    };
    if (outExtension) out.bytes = s.write(mesh, outExtension);
    return out;
  });
}

// ---------------------------------------------------------------------------
// registration

export type AlignScanSpec =
  | { mode: "landmarks"; source: number[]; target: number[]; weights?: number[] }
  | { mode: "symmetry"; seedOrigin?: number[]; seedNormal?: number[]; tolerance?: number; minShare?: number; maxSamples?: number; maxIterations?: number }
  | { mode: "auto"; angleTolerance?: number; subdivisions?: number; region?: string; rotateVectorData?: boolean };

export interface AlignScanResult {
  mode: AlignScanSpec["mode"];
  /** Row-major 4x4 (`landmarks`: the source-onto-target pose; `auto`: the pose applied). */
  matrix?: number[];
  rms?: number | null;
  residuals?: number[];
  /** `symmetry`. */
  plane?: { origin: number[]; normal: number[]; rms: number | null; share: number | null; tolerance: number | null; candidateRms: number[]; chosenCandidate: number };
  /** `auto`. */
  pose?: { poseMode: string; primary: number[]; secondary: number[]; share: number | null; faceShare: number | null; axisShare: number | null; openingArea: number | null };
  warnings: string[];
  bytes?: Uint8Array;
}

export async function alignScan(stl: Uint8Array | null, spec: AlignScanSpec, outExtension?: string): Promise<AlignScanResult> {
  return run((s, m) => {
    if (spec.mode === "landmarks") {
      const r = m.registerLandmarks(spec.source, spec.target, spec.weights ?? null);
      const out: AlignScanResult = { mode: "landmarks", matrix: plain(r.matrix), rms: plain(r.rms), residuals: plain(r.residuals), warnings: [] };
      if (outExtension) {
        if (!stl) throw new Error("landmarks: an output file needs a mesh to move (path).");
        out.bytes = s.write(applyMatrix(s.stl(stl, "al0"), r.matrix), outExtension);
      }
      return out;
    }
    if (!stl) throw new Error(`${spec.mode}: needs a mesh (path).`);
    const mesh = s.stl(stl, "al0");
    if (spec.mode === "symmetry") {
      const r = m.findSymmetryPlane(mesh, defined(spec, ["seedOrigin", "seedNormal", "tolerance", "minShare", "maxSamples", "maxIterations"]));
      return {
        mode: "symmetry",
        plane: { origin: plain(r.origin), normal: plain(r.normal), rms: plain(r.rms), share: plain(r.share), tolerance: plain(r.tolerance), candidateRms: plain(r.candidateRms), chosenCandidate: Number(r.chosenCandidate) },
        warnings: words(r.warnings),
      };
    }
    const r = m.autoAlign(mesh, defined(spec, ["angleTolerance", "subdivisions", "region", "rotateVectorData"]));
    const out: AlignScanResult = {
      mode: "auto", matrix: plain(r.matrix),
      pose: { poseMode: String(r.mode), primary: plain(r.primary), secondary: plain(r.secondary), share: plain(r.share), faceShare: plain(r.faceShare), axisShare: plain(r.axisShare), openingArea: plain(r.openingArea) },
      warnings: words(r.warnings),
    };
    if (outExtension) out.bytes = s.write(r.mesh, outExtension);
    return out;
  });
}

// ---------------------------------------------------------------------------
// sections, silhouette, curves, clip

export type SurfaceSectionsSpec =
  | { kind: "sections"; direction: number[]; offsets: number[]; minLength?: number; recordParentIds?: boolean }
  | { kind: "silhouette"; normal?: number[]; clearance?: number; roundAngle?: number; arcSegments?: number; extrude?: boolean; region?: string; mergeTolerance?: number }
  | { kind: "fitCurves"; direction: number[]; offsets: number[]; minLength?: number; tolerance?: number; snapAngle?: number; normal?: number[]; minArcPoints?: number; minArcSweep?: number }
  | { kind: "clip"; origin: number[]; normal: number[]; keepBelow?: boolean; cap?: boolean };

export interface SurfaceSectionsResult {
  kind: SurfaceSectionsSpec["kind"];
  facts: Record<string, unknown>;
  /** `fitCurves`: the lines/arcs/circles, capped at `SCAN_MAX_LISTED` (counts in `facts` are complete). */
  pieces?: any[];
  truncated?: boolean;
  warnings: string[];
  bytes?: Uint8Array;
}

export async function surfaceSections(stl: Uint8Array, spec: SurfaceSectionsSpec, outExtension?: string): Promise<SurfaceSectionsResult> {
  return run((s, m) => {
    const mesh = s.stl(stl, "ss0");
    let result: Mesh;
    let facts: Record<string, unknown>;
    let warnings: string[] = [];
    let pieces: any[] | undefined;
    if (spec.kind === "sections") {
      result = m.sections(mesh, spec.direction, spec.offsets, defined(spec, ["minLength", "recordParentIds"]));
      facts = { numOffsets: spec.offsets.length, numLines: countCells(result, "line"), numChains: countDistinct(result, "section:chain") };
    } else if (spec.kind === "silhouette") {
      const r = m.silhouette(mesh, defined(spec, ["normal", "clearance", "roundAngle", "arcSegments", "extrude", "region", "mergeTolerance"]));
      result = r.mesh;
      warnings = words(r.warnings);
      facts = plain(Object.fromEntries(["numLoops", "numOuter", "numHoles", "numTriangles", "area", "perimeter", "minHeight", "maxHeight"].map((k) => [k, r[k]])));
    } else if (spec.kind === "fitCurves") {
      const sec = m.sections(mesh, spec.direction, spec.offsets, defined(spec, ["minLength"]));
      const r = m.fitCurves(sec, defined(spec, ["tolerance", "snapAngle", "normal", "minArcPoints", "minArcSweep"]));
      result = r.mesh;
      warnings = words(r.warnings);
      pieces = (r.pieces as any[]).slice(0, SCAN_MAX_LISTED).map(plain);
      facts = plain({ numPieces: r.pieces.length, numLines: r.numLines, numArcs: r.numArcs, numCircles: r.numCircles, maxResidual: r.maxResidual, tolerance: r.tolerance, frames: r.frames });
    } else {
      const r = m.clip(mesh, spec.origin, spec.normal, defined(spec, ["keepBelow", "cap"]));
      result = r.mesh;
      warnings = words(r.warnings);
      facts = plain(Object.fromEntries(["numKept", "numSplit", "numCapTriangles", "numLoops", "numOpenChains"].map((k) => [k, r[k]])));
    }
    const out: SurfaceSectionsResult = {
      kind: spec.kind, facts, ...(pieces ? { pieces, truncated: (facts.numPieces as number) > pieces.length } : {}), warnings,
    };
    if (outExtension) out.bytes = s.write(result, outExtension);
    return out;
  });
}

// ---------------------------------------------------------------------------
// surface editing

export type SurfaceEditSpec =
  | { kind: "offset"; distance: number; smoothIterations?: number }
  | { kind: "thicken"; thickness: number; side?: "inward" | "outward" | "both"; smoothIterations?: number }
  | { kind: "hollow"; wall: number; smoothIterations?: number }
  | { kind: "flip"; region?: string }
  | { kind: "islands"; connectivity?: "edge" | "point"; minDiagonal?: number; minArea?: number; minCells?: number; relative?: boolean; dryRun?: boolean };

export interface SurfaceEditResult {
  kind: SurfaceEditSpec["kind"];
  facts: Record<string, unknown>;
  warnings: string[];
  bytes?: Uint8Array;
}

export async function surfaceEdit(stl: Uint8Array, spec: SurfaceEditSpec, outExtension?: string): Promise<SurfaceEditResult> {
  return run((s, m) => {
    const mesh = s.stl(stl, "se0");
    let r: any;
    let facts: Record<string, unknown>;
    let warnings: string[] = [];
    switch (spec.kind) {
      case "offset":
        r = m.offsetSurface(mesh, spec.distance, defined(spec, ["smoothIterations"]));
        break;
      case "thicken":
        r = m.thicken(mesh, spec.thickness, defined(spec, ["side", "smoothIterations"]));
        break;
      case "hollow":
        r = m.hollow(mesh, spec.wall, defined(spec, ["smoothIterations"]));
        break;
      case "flip":
        r = m.flipNormals(mesh, spec.region);
        break;
      default:
        r = m.removeIslands(mesh, defined(spec, ["connectivity", "minDiagonal", "minArea", "minCells", "relative", "dryRun"]));
    }
    if (spec.kind === "offset" || spec.kind === "thicken" || spec.kind === "hollow") {
      warnings = words(r.warnings);
      facts = plain(Object.fromEntries(["numNotVisible", "numClamped", "numFolded", "numRimQuads", "maxMove"].map((k) => [k, r[k]])));
    } else if (spec.kind === "flip") {
      facts = { numFlipped: Number(r.numFlipped) };
    } else {
      facts = plain(Object.fromEntries(["numComponents", "numRemoved", "numCellsRemoved", "numPointsRemoved"].map((k) => [k, r[k]])));
      if ((spec as { dryRun?: boolean }).dryRun) facts.dryRun = true;
    }
    const out: SurfaceEditResult = { kind: spec.kind, facts, warnings };
    if (outExtension) out.bytes = s.write(r.mesh, outExtension);
    return out;
  });
}

// ---------------------------------------------------------------------------
// scan -> CAD (FULL artifact for the OpenCASCADE-backed calls)

export interface SegmentFitOptions {
  featureAngle?: number;
  tolerance?: number;
  minInlierFraction?: number;
  types?: string[];
  usedPoints?: "auto" | "all" | "3sigma" | "2sigma" | "1sigma";
  criterion?: "least_squares" | "minimum_zone" | "min_circumscribed" | "max_inscribed";
}

export type ScanToCadSpec =
  | ({ kind: "constrain"; faceTolerance?: number; angleTolerance?: number; distanceTolerance?: number; minFraction?: number;
      force?: Array<[number, number, string]>; forbid?: Array<[number, number, string]> } & SegmentFitOptions)
  | ({ kind: "stepElements"; patches?: number[]; segments?: number } & SegmentFitOptions)
  | { kind: "profileSolid"; direction: number[]; offset: number; features: string; tolerance?: number; provider?: string; deflection?: number; step?: boolean }
  | { kind: "fitCadIterate"; stepPath?: boolean; partClass?: "any" | "analytic" | "cast" | "freeform"; targetWithin?: number; targetExplained?: number;
      segmentTolerance?: number; fitTolerance?: number; maxRounds?: number; worstFaces?: number; refineFactor?: number;
      backend?: "auto" | "occt" | "native"; faceSupport?: boolean; supportTolerance?: number };

export interface ScanToCadResult {
  kind: ScanToCadSpec["kind"];
  facts: Record<string, unknown>;
  listed?: any[];
  truncated?: boolean;
  warnings: string[];
  /** The mesh (output extension given) — `fitCadIterate`/`profileSolid`: the solid's triangulation. */
  bytes?: Uint8Array;
  /** An AP214 STEP file: `stepElements` always; `profileSolid`/`fitCadIterate` when `step` / `stepPath` is set. */
  stepBytes?: Uint8Array;
}

function segmentAndFit(m: any, mesh: Mesh, o: SegmentFitOptions): { fit: any; warnings: string[] } {
  const featureAngle = o.featureAngle ?? 30;
  // The same positional calls as meshSegment.ts / meshFitCad.ts: the patch label is `segment:patch`.
  const seg = m.segment(mesh, featureAngle, 0, 0, 1, "", "patch");
  const extra = defined(o, ["usedPoints", "criterion"]);
  const args: unknown[] = [seg.mesh, "segment:patch", o.tolerance ?? 0.01, true, o.minInlierFraction ?? 0.9, o.types ?? ["plane", "sphere", "cylinder", "cone", "torus"], 20];
  if (Object.keys(extra).length > 0) args.push(extra);
  const fit = (m.fitPrimitives as (...a: unknown[]) => any)(...args);
  return { fit, warnings: words(fit.warnings) };
}

export async function scanToCad(stl: Uint8Array, spec: ScanToCadSpec, outExtension?: string): Promise<ScanToCadResult> {
  return run((s, m) => {
    const mesh = s.stl(stl, "sc0");
    if (spec.kind === "constrain" || spec.kind === "stepElements") {
      const { fit, warnings } = segmentAndFit(m, mesh, spec);
      if (!(Number(fit.numPatches) > 0)) throw new Error("No patch was fitted; nothing to " + (spec.kind === "constrain" ? "constrain" : "write") + ".");
      if (spec.kind === "constrain") {
        const r = m.constrainPrimitives(fit.mesh, defined(spec, ["faceTolerance", "angleTolerance", "distanceTolerance", "minFraction", "force", "forbid"]));
        const relations = (r.relations as any[]).slice(0, SCAN_MAX_LISTED).map(plain);
        const out: ScanToCadResult = {
          kind: "constrain",
          facts: plain({ numPatches: fit.numPatches, numConstrained: r.numConstrained, numGroups: r.numGroups, faceTolerance: r.faceTolerance, numRelations: r.relations.length, unmet: r.unmet }),
          listed: relations, truncated: r.relations.length > relations.length, warnings,
        };
        if (outExtension) out.bytes = s.write(r.mesh, outExtension);
        return out;
      }
      const p = s.scratch("se.step");
      const r = m.writeStepElements(p, fit.mesh, defined(spec, ["patches", "segments"]));
      return {
        kind: "stepElements",
        facts: plain(Object.fromEntries(["numPlanes", "numSpheres", "numCylinders", "numCones", "numTori", "numSkipped"].map((k) => [k, r[k]]))),
        warnings: [...warnings, ...words(r.warnings)],
        stepBytes: s.read(p),
      };
    }
    if (spec.kind === "profileSolid") {
      const sec = m.sections(mesh, spec.direction, [spec.offset], {});
      const curves = m.fitCurves(sec, defined(spec, ["tolerance"]));
      const stepPath = spec.step ? s.scratch("ps.step") : undefined;
      const r = m.profileSolid(curves.mesh, spec.features, { ...defined(spec, ["provider", "deflection"]), ...(stepPath ? { stepPath } : {}) });
      const out: ScanToCadResult = {
        kind: "profileSolid",
        facts: plain({ volume: r.volume, area: r.area, numFaces: r.numFaces, valid: r.valid, provider: r.provider, numPieces: curves.pieces.length }),
        warnings: [...words(curves.warnings), ...words(r.warnings)],
      };
      if (outExtension) out.bytes = s.write(r.mesh, outExtension);
      if (stepPath) out.stepBytes = s.read(stepPath);
      return out;
    }
    // fitCadIterate (+ faceSupport)
    const stepPath = spec.stepPath ? s.scratch("fi.step") : undefined;
    const r = m.fitCadIterate(mesh, { ...defined(spec, ["partClass", "targetWithin", "targetExplained", "segmentTolerance", "fitTolerance", "maxRounds", "worstFaces", "refineFactor", "backend"]), ...(stepPath ? { stepPath } : {}) });
    let solid: Mesh = r.mesh;
    const facts: Record<string, unknown> = plain({ rounds: r.rounds, bestRound: r.bestRound, targetWithin: r.targetWithin, targetMet: r.targetMet, stopReason: r.stopReason, numMeasured: r.numMeasured, numInferred: r.numInferred });
    let listed: any[] | undefined;
    let truncated: boolean | undefined;
    if (spec.faceSupport) {
      const f = m.faceSupport(solid, mesh, defined({ tolerance: spec.supportTolerance }, ["tolerance"]));
      solid = f.mesh;
      Object.assign(facts, plain({ support: { numMeasured: f.numMeasured, numPartial: f.numPartial, numInferred: f.numInferred, shareWithin: f.shareWithin, tolerance: f.tolerance } }));
      listed = (f.faceShare as ArrayLike<number>) ? Array.from(f.faceShare as ArrayLike<number>, plain).slice(0, SCAN_MAX_LISTED) : [];
      truncated = (f.faceShare as ArrayLike<number>).length > listed.length;
    }
    const out: ScanToCadResult = { kind: "fitCadIterate", facts, ...(listed ? { listed, truncated } : {}), warnings: [] };
    if (outExtension) out.bytes = s.write(solid, outExtension);
    if (stepPath) out.stepBytes = s.read(stepPath);
    return out;
  });
}
