/**
 * Mesh-aware surface tessellation export — the pure half (roadmap
 * "Mesh-aware surface tessellation export"). A fine downstream volume mesh
 * cannot recover curvature a coarse STL already lost, so the export's
 * chordal tolerance is derived from the DOWNSTREAM cell size instead of the
 * viewport's display preset: `linearDeflection = targetCellSize ×
 * chordalFraction`, with an angular limit kept alongside.
 *
 * Units: `targetCellSize` is given in the EXPORT unit (what the user thinks
 * in), converted to the model's millimetres before tessellating, and the
 * output coordinates are scaled back — so the PHYSICAL tolerance is the same
 * whichever unit the file is written in.
 *
 * No OCCT here; `tessellationExport.ts` is the kernel half.
 */
import { unitScaleFactor, type DisplayUnit } from "./lengthUnits";
import type { WeldedMesh } from "./meshComponents";

export interface TessellationExportRequest {
  /** Downstream (volume-mesh) cell size, in `unit`. */
  targetCellSize: number;
  /** Chordal error as a fraction of the cell size (0 < f ≤ 1). Default 0.1. */
  chordalFraction?: number;
  /** Angular deflection limit in degrees (default 20). */
  angularDeg?: number;
  unit?: DisplayUnit;
}

export interface DerivedTessellation {
  /** Absolute linear deflection in model millimetres. */
  linearDeflectionMm: number;
  angularDeflectionRad: number;
  /** The requested chordal tolerance expressed in the export unit. */
  requestedChordal: number;
  unit: DisplayUnit;
  scale: number;
}

export const DEFAULT_CHORDAL_FRACTION = 0.1;
export const DEFAULT_ANGULAR_DEG = 20;
/** Refuse before writing anything above this — a runaway fine tolerance on a
 * large part would otherwise allocate gigabytes. */
export const DEFAULT_MAX_TRIANGLES = 2_000_000;

/** Validates and converts a request; throws a caller-input error on nonsense. */
export function deriveTessellation(req: TessellationExportRequest): DerivedTessellation {
  const unit = req.unit ?? "mm";
  const scale = unitScaleFactor(unit);
  const size = req.targetCellSize;
  if (!(typeof size === "number" && Number.isFinite(size) && size > 0)) {
    throw new Error(`targetCellSize must be a positive number (got ${String(size)})`);
  }
  const fraction = req.chordalFraction ?? DEFAULT_CHORDAL_FRACTION;
  if (!(Number.isFinite(fraction) && fraction > 0 && fraction <= 1)) {
    throw new Error(`chordalFraction must be in (0, 1] (got ${String(fraction)})`);
  }
  const angularDeg = req.angularDeg ?? DEFAULT_ANGULAR_DEG;
  if (!(Number.isFinite(angularDeg) && angularDeg >= 1 && angularDeg <= 90)) {
    throw new Error(`angularDeg must be between 1 and 90 (got ${String(angularDeg)})`);
  }
  const requestedChordal = size * fraction;
  return {
    linearDeflectionMm: requestedChordal / scale,
    angularDeflectionRad: (angularDeg * Math.PI) / 180,
    requestedChordal,
    unit,
    scale,
  };
}

/** Nearest-rank percentile of a numeric sample (p in [0, 100]); NaN for empty. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

/** Binary STL (80-byte header, little-endian), coordinates multiplied by
 * `scale`; facet normals recomputed from winding like every other host
 * STL writer here. Binary rather than ASCII: an export sized for a fine
 * downstream mesh routinely carries millions of triangles. */
export function weldedMeshToBinaryStl(mesh: WeldedMesh, scale = 1, header = "CAD-Preview mesh-aware tessellation"): Uint8Array {
  const { positions, indices } = mesh;
  const n = Math.floor(indices.length / 3);
  const out = new Uint8Array(84 + n * 50);
  const view = new DataView(out.buffer);
  const h = new TextEncoder().encode(header.slice(0, 80));
  out.set(h, 0);
  view.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ax = positions[a] * scale, ay = positions[a + 1] * scale, az = positions[a + 2] * scale;
    const bx = positions[b] * scale, by = positions[b + 1] * scale, bz = positions[b + 2] * scale;
    const cx = positions[c] * scale, cy = positions[c + 1] * scale, cz = positions[c + 2] * scale;
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const v of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) {
      view.setFloat32(o, v, true);
      o += 4;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return out;
}
