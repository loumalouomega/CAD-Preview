/**
 * CAD-to-mesh deviation map — the kernel half. Builds the REFERENCE surface
 * (a B-rep's own fine CAD tessellation, one region per `face-N`; or a mesh
 * source's raw triangles), generates the FE mesh exactly as `generate_mesh`
 * would (same input, options and Parts), takes its boundary triangles, and
 * runs the pure `measureDeviation` both ways.
 *
 * The reference is an explicitly APPROXIMATE stand-in for the exact CAD
 * surface — its own chordal error (the `fine` tessellation preset) is the
 * floor below which a reported deviation means nothing; the report says so.
 * Exact OCCT point projection would need a separate binding probe.
 */
import { getOcct, readShape, wrapOcctFault } from "./occtService";
import { applyEditsBRep } from "./occtOperations";
import { tessellateByGroup } from "./meshExtract";
import { TESSELLATION_PRESETS } from "./tessellationQuality";
import { generateMesh, type MeshGenerationInput } from "./gmshService";
import { parseStl } from "./stlParser";
import { weldTriangleSoup } from "./meshComponents";
import { measureDeviation, type DeviationReport, type DeviationSurface } from "./meshDeviation";
import type { MeshOptions } from "./meshOptions";
import type { EditOp } from "./editOps";
import type { Part } from "./protocol";

export type DeviationReference =
  | { kind: "brep"; bytes: Uint8Array; format: "step" | "iges" | "brep" | "csg"; ops: EditOp[] }
  | { kind: "stl"; stlBytes: Uint8Array };

export interface MeshDeviationOptions {
  tolerance: number;
  samples?: number;
  /** Return per-corner mesh-boundary positions + distances (the overlay / PLY). */
  perCorner?: boolean;
}

export interface MeshDeviationResult {
  report: DeviationReport;
  mesh: { nodeCount: number; elementCount: number; boundaryTriangles: number; engineUsed: string };
  referenceKind: "cad-tessellation" | "source-mesh";
  /** Per-corner boundary positions (9 floats per triangle) and distances (3 per triangle). */
  corners?: { positions: Float32Array; distances: Float32Array };
  warnings: string[];
}

export async function measureMeshDeviation(
  extensionPath: string,
  reference: DeviationReference,
  input: MeshGenerationInput,
  options: MeshOptions,
  parts: Part[],
  deviation: MeshDeviationOptions
): Promise<MeshDeviationResult> {
  const warnings: string[] = [];
  const ref = reference.kind === "brep" ? await cadReference(extensionPath, reference) : stlReference(reference.stlBytes);
  if (reference.kind === "brep") {
    warnings.push(
      `The reference is the CAD's own fine tessellation (chordal ≤ ${TESSELLATION_PRESETS.fine.linearDeflection} mm), an approximate stand-in for the exact surface — deviations below that are not meaningful.`
    );
  }
  const meshed = await generateMesh(extensionPath, input, options, parts);
  warnings.push(...meshed.warnings);
  const mesh: DeviationSurface = { positions: meshed.positions, indices: meshed.indices };
  const { report, cornerDistances } = measureDeviation(ref, mesh, deviation);
  let corners: MeshDeviationResult["corners"];
  if (deviation.perCorner && cornerDistances) {
    const n = Math.floor(meshed.indices.length / 3);
    const positions = new Float32Array(n * 9);
    for (let c = 0; c < n * 3; c++) {
      const v = meshed.indices[c] * 3;
      positions[c * 3] = meshed.positions[v];
      positions[c * 3 + 1] = meshed.positions[v + 1];
      positions[c * 3 + 2] = meshed.positions[v + 2];
    }
    corners = { positions, distances: cornerDistances };
  }
  return {
    report,
    mesh: {
      nodeCount: meshed.nodeCount,
      elementCount: meshed.elementCount,
      boundaryTriangles: Math.floor(meshed.indices.length / 3),
      engineUsed: meshed.engineUsed,
    },
    referenceKind: reference.kind === "brep" ? "cad-tessellation" : "source-mesh",
    corners,
    warnings,
  };
}

function stlReference(bytes: Uint8Array): DeviationSurface {
  const welded = weldTriangleSoup(parseStl(bytes));
  return { positions: welded.positions, indices: welded.indices };
}

async function cadReference(
  extensionPath: string,
  ref: Extract<DeviationReference, { kind: "brep" }>
): Promise<DeviationSurface> {
  const oc = await getOcct(extensionPath);
  const tmp = `/dv.${ref.format}`;
  oc.FS.writeFile(tmp, ref.bytes);
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const shape = applyEditsBRep(oc, readShape(oc, tmp, ref.format, cleanup), ref.ops, cleanup);
    const groups = tessellateByGroup(oc, shape, TESSELLATION_PRESETS.fine);
    const positions: number[] = [];
    const indices: number[] = [];
    const triangleRegion: number[] = [];
    const regionNames: string[] = [];
    for (const g of groups)
      for (const f of g.faces) {
        const base = positions.length / 3;
        const region = regionNames.length;
        regionNames.push(f.faceId);
        for (let i = 0; i < f.buffers.positions.length; i++) positions.push(f.buffers.positions[i]);
        for (let i = 0; i < f.buffers.indices.length; i++) indices.push(f.buffers.indices[i] + base);
        for (let t = 0; t < f.buffers.indices.length / 3; t++) triangleRegion.push(region);
      }
    return { positions, indices, triangleRegion, regionNames };
  } catch (err) {
    throw wrapOcctFault(err);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try {
        cleanup[i].delete();
      } catch {
        /* ignore */
      }
    }
    try {
      oc.FS.unlink(tmp);
    } catch {
      /* ignore */
    }
  }
}
