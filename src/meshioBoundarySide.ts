/**
 * Host-side geometry for a meshio-only source.
 *
 * meshio++ never exposes the source's volume cells to JS, but it does expose
 * their boundary as an STL triangle surface — the exact bytes the viewer
 * displays. This module turns that boundary into the same welded triangle mesh
 * the native STL/OBJ/PLY/glTF paths already measure, so compare/mass/measure
 * can read a meshio source without a webview.
 *
 * The source is still `surfaceDerived`: volume is the divergence-theorem
 * volume of the boundary, meaningful only when the boundary is watertight, and
 * no volume-cell count or per-cell field is claimed. The conversion itself is
 * injected so this stays free of the meshio WASM singleton and unit-tests with
 * a fake.
 */

import type { MeshioBoundaryResult, MeshioCompanion } from "./meshioService";
import type { WeldedMesh } from "./meshComponents";
import { parseToWeldedMesh } from "./meshParse";
import { meshInspection } from "./meshInspection";

export interface MeshioBoundarySide {
  /** The welded boundary triangles, in the source's own coordinates. */
  mesh: WeldedMesh;
  /** The same machinery `get_mass_properties`/`measure` use for STL. */
  inspection: ReturnType<typeof meshInspection>;
  stlBytes: Uint8Array;
  /** Always true: every fact comes from the extracted boundary, not the cells. */
  surfaceDerived: true;
  /** `kind: "cell"` regions that correlated to at least one boundary triangle. */
  regionCount: number;
  /** Derived from boundary-edge closure, not from meshio's own report. */
  watertight: boolean;
  triangleCount: number;
}

/** The source could not yield a boundary surface (unreadable file, or no
 * triangles after extraction). Callers turn this into their own
 * `supported: false` result rather than reporting an empty model as facts. */
export class MeshioBoundaryUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "MeshioBoundaryUnavailableError";
  }
}

/**
 * Converts a meshio source to its boundary side. The `convert` argument is
 * `convertToStlBoundaryWithRegions` (or a pipeline adapter with the same
 * signature); passing it in keeps this module WASM-free and testable.
 */
export async function meshioBoundarySide(
  bytes: Uint8Array,
  format: string,
  sourceName: string | undefined,
  companions: readonly MeshioCompanion[] | undefined,
  convert: (
    sourceBytes: Uint8Array,
    meshioFormat: string,
    sourceName?: string,
    companions?: readonly MeshioCompanion[]
  ) => Promise<MeshioBoundaryResult>
): Promise<MeshioBoundarySide> {
  let result: MeshioBoundaryResult;
  try {
    result = await convert(bytes, format, sourceName, companions);
  } catch (err) {
    throw new MeshioBoundaryUnavailableError(
      `${sourceName ?? format} could not be converted to a boundary surface (${(err as Error).message})`
    );
  }
  const side = meshioBoundarySideFromResult(result);
  if (side.triangleCount === 0) {
    throw new MeshioBoundaryUnavailableError(`${sourceName ?? format} has no boundary triangles to measure`);
  }
  return side;
}

/** The pure half: a boundary result already in hand (the shape the kernel
 * worker returns) to its welded side and read-back facts. */
export function meshioBoundarySideFromResult(result: MeshioBoundaryResult): MeshioBoundarySide {
  const mesh = parseToWeldedMesh(result.stlBytes, "stl");
  const inspection = meshInspection(mesh);
  const watertight = mesh.indices.length > 0 && inspection.mass("whole-model").watertight;
  return {
    mesh,
    inspection,
    stlBytes: result.stlBytes,
    surfaceDerived: true,
    regionCount: result.regions?.regionNames.length ?? 0,
    watertight,
    triangleCount: mesh.indices.length / 3,
  };
}
