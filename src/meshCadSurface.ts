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

export interface MeshCadFaceFact {
  face: number;
  id: number;
  status: string;
  reason: string;
  numTriangles: number;
  numInteriorPoints: number;
  minAngleDeg: number;
  maxAngleDeg: number;
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
  warnings: string[];
}

export interface MeshCadSurfaceResult {
  /** The surface mesh serialized in the requested format. */
  outputBytes: Uint8Array;
  report: MeshCadSurfaceReport;
}

const MAX_POINTS_CEILING = 5_000_000;
const MAX_FACES_LISTED = 200;
// Host-side MEMFS paths: always ≤ 10 characters (see meshioService.ts).
const IN_PATH = "/mcs.in";
const OUT_PATH = "/mcs.out";

function positive(name: string, v: number | undefined, allowZero = false): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isFinite(v) || (allowZero ? v < 0 : v <= 0)) throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} number (got ${v})`);
  return v;
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
  const targetSize = positive("targetSize", options.targetSize);
  if (targetSize === undefined) throw new Error("targetSize is required (a positive edge length in model units).");
  const maxChordalDeviation = positive("maxChordalDeviation", options.maxChordalDeviation, true);
  const tolerance = positive("tolerance", options.tolerance, true);
  if (options.minPointsPerEdge !== undefined && !(Number.isInteger(options.minPointsPerEdge) && options.minPointsPerEdge >= 0)) {
    throw new Error(`minPointsPerEdge must be a non-negative integer (got ${options.minPointsPerEdge})`);
  }
  const maxPoints = Math.min(MAX_POINTS_CEILING, Math.floor(positive("maxPoints", options.maxPoints) ?? MAX_POINTS_CEILING));

  const warnings: string[] = [];
  let edges = options.edges ?? true;
  if (edges && writerFormat === "obj") {
    edges = false;
    warnings.push("OBJ holds no line cells — the B-rep edge block was dropped (the triangles keep their cad:face ids only in formats that carry cell data).");
  }

  const m = await getMeshio();
  try {
    m.FS.writeFile(IN_PATH, bytes);
    const selective: Record<string, unknown> = m.readMeshSelective(IN_PATH, { format: meshioFormat, info: true });
    const info = selective.info as Record<string, unknown> | undefined;
    if (!info || info.format !== "cad_json") {
      throw new Error("The file has no B-rep side channel — mesh_cad_surface needs a Kratos CAD JSON model (.cad.json) or a STEP/IGES file.");
    }
    // Only defined keys cross into meshio++, which validates names and kinds.
    const o: Record<string, unknown> = { targetSize, edges, maxPoints };
    if (maxChordalDeviation !== undefined) o.maxChordalDeviation = maxChordalDeviation;
    if (tolerance !== undefined) o.tolerance = tolerance;
    if (options.minPointsPerEdge !== undefined) o.minPointsPerEdge = options.minPointsPerEdge;
    if (options.strict !== undefined) o.strict = options.strict;
    const r = m.meshCadSurface(info, o) as unknown as {
      mesh: unknown;
      faces: Array<Record<string, unknown>>;
      warnings: string[];
    } & Record<string, number>;

    m.writeMesh(OUT_PATH, r.mesh, writerFormat);
    const outputBytes = new Uint8Array(m.FS.readFile(OUT_PATH));

    const all: MeshCadFaceFact[] = r.faces.map((f) => ({
      face: Number(f.face),
      id: Number(f.id),
      status: String(f.status),
      reason: String(f.reason ?? ""),
      numTriangles: Number(f.numTriangles),
      numInteriorPoints: Number(f.numInteriorPoints),
      minAngleDeg: Number(f.minAngleDeg),
      maxAngleDeg: Number(f.maxAngleDeg),
    }));
    // Failures first, so a cap never hides one.
    const ordered = [...all.filter((f) => f.status !== "ok"), ...all.filter((f) => f.status === "ok")];
    const facesTruncated = ordered.length > MAX_FACES_LISTED;
    if (facesTruncated) warnings.push(`Face listing capped at ${MAX_FACES_LISTED} of ${ordered.length} (failures first); the counts cover every face.`);
    for (const w of r.warnings ?? []) warnings.push(String(w));
    if (r.numFailed > 0) warnings.push(`${r.numFailed} of ${r.numFaces} faces could not be meshed — see faces[] for each status and reason; the surface is open there.`);
    if (r.numOpenEdges > 0 || r.numNonManifoldEdges > 0 || r.numMisorientedEdges > 0) {
      warnings.push(
        `The surface is not a closed, consistently wound manifold (${r.numOpenEdges} open, ${r.numNonManifoldEdges} non-manifold, ${r.numMisorientedEdges} misoriented edges).`
      );
    }

    return {
      outputBytes,
      report: {
        targetSize,
        numPoints: r.numPoints,
        numTriangles: r.numTriangles,
        numEdgeSegments: r.numEdgeSegments,
        numFaces: r.numFaces,
        numFailed: r.numFailed,
        numEdges: r.numEdges,
        numOpenEdges: r.numOpenEdges,
        numNonManifoldEdges: r.numNonManifoldEdges,
        numMisorientedEdges: r.numMisorientedEdges,
        numDegenerateDropped: r.numDegenerateDropped,
        tolerance: r.tolerance,
        minAngleDeg: r.minAngleDeg,
        maxAngleDeg: r.maxAngleDeg,
        minEdge: r.minEdge,
        maxEdge: r.maxEdge,
        maxEdgeGap: r.maxEdgeGap,
        faces: ordered.slice(0, MAX_FACES_LISTED),
        facesTruncated,
        warnings,
      },
    };
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
