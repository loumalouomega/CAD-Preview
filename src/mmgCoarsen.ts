import { weldTriangleSoup, weldedMeshToStlBytes, volumeOfTriangles } from "./meshComponents";
import { parseStl } from "./stlParser";
import { remeshMmg } from "./mmgService";

/**
 * Hausdorff-bounded surface coarsening for the `autoDecimate` opt-in
 * (`check_mesh_health` / `promote_mesh_to_brep` / the Mesh Health panel).
 *
 * mmgs (surface remeshing) is the backend because it is the only candidate
 * measured to coarsen a ~100k-triangle sphere to ~1 000 triangles that still
 * closes AND heals to a positive volume near the true one; meshio++'s quadric
 * `decimate` heals to exactly 0 and its clustering `remesh` never closes
 * (see the roadmap's "Hausdorff-bounded surface coarsening" write-up). mmgs
 * takes a geometric deviation bound (`hausd`), not a triangle target, so the
 * target is reached by bisecting `hausd` in log space — the triangle count is
 * non-increasing in `hausd`.
 */
export interface CoarsenStlResult {
  bytes: Uint8Array;
  fromTriangles: number;
  toTriangles: number;
  method: "mmgs";
  /** The Hausdorff bound mmgs ran with, in source units. */
  hausd: number;
  /** The same bound as a fraction of the bounding-box diagonal. */
  hausdFraction: number;
  /** mmgs runs the search spent. */
  iterations: number;
  /** Signed enclosed volume of the coarse mesh vs the input mesh, in percent (null when the input volume is 0 or the mesh is open). A fact, not a verdict. */
  volumeDeltaPct: number | null;
}

/** Search bracket for the relative `hausd` (fraction of the bbox diagonal). */
const HAUSD_LOW = 1e-4;
const HAUSD_HIGH = 0.2;
const MAX_ITERATIONS = 9;
/** A result with at least this fraction of the target is accepted without searching further. */
const ACCEPT_FRACTION = 0.7;

export async function coarsenStlBoundary(extensionPath: string, stlBytes: Uint8Array, targetTriangles: number): Promise<CoarsenStlResult> {
  if (!(targetTriangles >= 4)) throw new Error(`coarsen target must be at least 4 triangles (got ${targetTriangles})`);
  const welded = weldTriangleSoup(parseStl(stlBytes));
  const fromTriangles = Math.floor(welded.indices.length / 3);
  if (fromTriangles === 0) throw new Error("coarsen: no triangles in the STL input — refusing to resample an empty mesh.");
  const positions = Float64Array.from(welded.positions);
  const triangles = Int32Array.from(welded.indices, (n) => n + 1);
  const triangleRefs = new Int32Array(fromTriangles).fill(1);
  const input = { positions, triangles, triangleRefs, tetrahedra: new Int32Array(), tetraRefs: new Int32Array() };

  type Run = Awaited<ReturnType<typeof remeshMmg>>;
  const run = (fraction: number): Promise<Run> => remeshMmg(extensionPath, input, { hausd: fraction, hausdRelative: true });

  let lo = HAUSD_LOW;
  let hi = HAUSD_HIGH;
  let best: { run: Run; fraction: number } | null = null; // largest count <= target
  let smallest: { run: Run; fraction: number } | null = null; // fallback when nothing reaches the target
  let iterations = 0;
  for (; iterations < MAX_ITERATIONS;) {
    const fraction = Math.sqrt(lo * hi);
    const result = await run(fraction);
    iterations++;
    const count = result.report.outputCells;
    if (count <= targetTriangles) {
      if (!best || count > best.run.report.outputCells) best = { run: result, fraction };
      if (count >= targetTriangles * ACCEPT_FRACTION) break;
      hi = fraction; // too coarse: tighten the bound for more triangles
    } else {
      if (!smallest || count < smallest.run.report.outputCells) smallest = { run: result, fraction };
      lo = fraction; // too fine: loosen the bound
    }
  }
  const chosen = best ?? smallest!;
  const { run: out, fraction } = chosen;
  const indices = Uint32Array.from(out.triangles, (n) => n - 1);
  const coarse = { positions: Float32Array.from(out.positions), indices };
  const bytes = weldedMeshToStlBytes(coarse);
  const all = (m: { indices: Uint32Array }): number[] => Array.from({ length: m.indices.length / 3 }, (_, i) => i);
  const before = volumeOfTriangles(welded.positions, welded.indices, all(welded));
  const after = volumeOfTriangles(coarse.positions, coarse.indices, all(coarse));
  const volumeDeltaPct = Math.abs(before) > 0 ? ((after - before) / Math.abs(before)) * 100 : null;
  return {
    bytes,
    fromTriangles,
    toTriangles: out.report.outputCells,
    method: "mmgs",
    hausd: out.report.hausd,
    hausdFraction: fraction,
    iterations,
    volumeDeltaPct,
  };
}
