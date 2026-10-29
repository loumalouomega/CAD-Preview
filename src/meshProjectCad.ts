// meshio++ 17.23 `projectToCad`: snap a surface mesh's points onto the exact
// CAD faces (and the 3-D curves of its edges). The mesh must carry the
// `cad:face` cell data (and, for edge snapping, the `cad:edge` line block) that
// `mesh_cad_surface` writes — formats that hold cell data: .msh / .vtk / .vtu.
// The NURBS side channel (`readCadInfo`) holds BigInt64Arrays and never leaves
// the worker; only bytes cross IPC.
//
// Verified live (probe `scripts/probe/examples/meshio-prism-project.ts`):
// block.stp unperturbed control moves 4.6e-16; a 0.02-size perturbation snaps
// back (maxMove 0.0128), 44 points onto edges (all on curves) and 8 corners;
// `maxDistance` leaves farther points where they are (`numTooFar`); order-2
// input works; the .vtu round trip keeps both arrays.

import { getMeshio, wrapMeshioFault } from "./meshioService";
import { readCadInfo, MESH_CAD_SURFACE_FORMATS } from "./meshCadSurface";
import { clean } from "./untrustedText";

export interface ProjectCadOptions {
  /** Cell data naming each triangle's CAD face (default "cad:face"). */
  faceArray?: string;
  /** Cell data naming each line's CAD edge (default "cad:edge"). */
  edgeArray?: string;
  /** A point farther than this stays where it is (0, the default, is no limit). */
  maxDistance?: number;
  /** Samples per knot span when testing a face's trims (default 16). */
  trimSamples?: number;
}

export const MAX_OUTSIDE_TRIM_LISTED = 200;

export interface ProjectCadReport {
  numProjected: number;
  numOnEdges: number;
  numOnCurves: number;
  numCorners: number;
  numAmbiguous: number;
  numTooFar: number;
  numFailed: number;
  numOutsideTrim: number;
  maxMove: number;
  /** 0-based points projected outside their face's trims (first {@link MAX_OUTSIDE_TRIM_LISTED}). */
  outsideTrim: number[];
  outsideTrimTruncated: boolean;
  warnings: string[];
}

/** Pure: validates the options and forwards only the keys that were given. */
export function buildProjectCall(options: ProjectCadOptions): Record<string, unknown> {
  const call: Record<string, unknown> = {};
  for (const k of ["faceArray", "edgeArray"] as const) {
    const v = options[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length === 0 || v.length > 128) throw new Error(`${k} must be a non-empty array name (got ${String(v)})`);
    call[k] = v;
  }
  if (options.maxDistance !== undefined) {
    if (!(typeof options.maxDistance === "number" && Number.isFinite(options.maxDistance) && options.maxDistance >= 0)) {
      throw new Error(`maxDistance must be a non-negative number (got ${String(options.maxDistance)})`);
    }
    call.maxDistance = options.maxDistance;
  }
  if (options.trimSamples !== undefined) {
    if (!(typeof options.trimSamples === "number" && Number.isInteger(options.trimSamples) && options.trimSamples >= 1 && options.trimSamples <= 1024)) {
      throw new Error(`trimSamples must be an integer from 1 to 1024 (got ${String(options.trimSamples)})`);
    }
    call.trimSamples = options.trimSamples;
  }
  return call;
}

/** Pure: the facts of a `projectToCad` result. */
export function summarizeProjection(r: Record<string, unknown>): ProjectCadReport {
  const n = (k: string): number => Number(r[k] ?? 0);
  const all = Array.isArray(r.outsideTrim) ? (r.outsideTrim as unknown[]).map(Number) : [];
  const warnings = (Array.isArray(r.warnings) ? (r.warnings as unknown[]) : []).map((w) => clean(String(w)));
  const report: ProjectCadReport = {
    numProjected: n("numProjected"),
    numOnEdges: n("numOnEdges"),
    numOnCurves: n("numOnCurves"),
    numCorners: n("numCorners"),
    numAmbiguous: n("numAmbiguous"),
    numTooFar: n("numTooFar"),
    numFailed: n("numFailed"),
    numOutsideTrim: n("numOutsideTrim"),
    maxMove: n("maxMove"),
    outsideTrim: all.slice(0, MAX_OUTSIDE_TRIM_LISTED),
    outsideTrimTruncated: all.length > MAX_OUTSIDE_TRIM_LISTED,
    warnings,
  };
  if (report.numFailed > 0) warnings.push(`${report.numFailed} point(s) could not be projected and were left where they were.`);
  if (report.numTooFar > 0) warnings.push(`${report.numTooFar} point(s) were farther than maxDistance and were left where they were.`);
  if (report.numOutsideTrim > 0) warnings.push(`${report.numOutsideTrim} point(s) projected outside their face's trimming loops.`);
  if (report.outsideTrimTruncated) warnings.push(`Outside-trim point list capped at ${MAX_OUTSIDE_TRIM_LISTED}; the count covers every point.`);
  return report;
}

export interface ProjectCadResult {
  outputBytes: Uint8Array;
  report: ProjectCadReport;
}

const MESH_PATH = "/pj-mesh.dat";
const CAD_PATH = "/pj-cad.dat";
const OUT_PATH = "/pj-out.dat";

/**
 * Reads `meshBytes` (a surface mesh carrying `cad:face`), snaps it onto the
 * faces of `cadBytes` (STEP/IGES/Kratos CAD JSON, read for its `cad_json` side
 * channel) and returns the snapped mesh in `outputExtension`'s format. A mesh
 * without the face array fails with meshio++'s own message.
 */
export async function projectMeshToCad(
  meshBytes: Uint8Array,
  meshFormat: string,
  cadBytes: Uint8Array,
  cadFormat: string,
  outputExtension: string,
  options: ProjectCadOptions
): Promise<ProjectCadResult> {
  const writerFormat = MESH_CAD_SURFACE_FORMATS[outputExtension.toLowerCase()];
  if (!writerFormat) throw new Error(`Unsupported output extension "${outputExtension}" — valid: ${Object.keys(MESH_CAD_SURFACE_FORMATS).join(", ")}.`);
  const call = buildProjectCall(options);
  const m = await getMeshio();
  try {
    m.FS.writeFile(MESH_PATH, meshBytes);
    m.FS.writeFile(CAD_PATH, cadBytes);
    const info = readCadInfo(m, CAD_PATH, cadFormat);
    const mesh = m.readMesh(MESH_PATH, meshFormat);
    const r = (m as unknown as { projectToCad(mesh: unknown, info: unknown, o: unknown): Record<string, unknown> & { mesh: unknown } }).projectToCad(mesh, info, call);
    m.writeMesh(OUT_PATH, r.mesh as never, writerFormat);
    return { outputBytes: new Uint8Array(m.FS.readFile(OUT_PATH)), report: summarizeProjection(r) };
  } catch (err) {
    throw wrapMeshioFault(err);
  } finally {
    for (const p of [MESH_PATH, CAD_PATH, OUT_PATH]) {
      try {
        m.FS.unlink(p);
      } catch {
        /* ignore */
      }
    }
  }
}
