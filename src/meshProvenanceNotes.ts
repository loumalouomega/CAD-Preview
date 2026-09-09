/**
 * Provenance-note builder for meshio++-routed FE-mesh exports (Tier 1 item
 * "meshio++ provenance, read and write").
 *
 * Pure and dependency-light (only `meshOptions.ts`'s sentinel, itself
 * vscode/WASM-free) so BOTH export call sites — `mcpTools.ts`'s
 * `exportMeshTool` and `provider.ts`'s `runMeshExport` — build the identical
 * audit trail instead of hand-formatting the same six notes twice and
 * drifting. Each note becomes one `Note [category]: detail` line inside the
 * export's provenance block, where the container has a header slot for one
 * (vtu/avsucd/mphtxt/netgen/flac3d/flux/gid — NOT med/cgns/xdmf/hmf/wkt, see
 * `exportViaMeshio`'s doc comment for the measured split).
 *
 * Every entry is a FACT about the call that produced the file (engine that
 * actually ran, sizes actually used, whether edits were baked) — never a
 * verdict — matching this codebase's `verdictConventions`.
 */
import { SIZE_MAX_SENTINEL } from "./meshOptions";

export interface ProvenanceNote {
  category: string;
  detail: string;
}

export interface MeshProvenanceFacts {
  /** `generateMesh`'s `engineUsed` — the engine that ACTUALLY ran, not the requested one. */
  engineUsed: string;
  dimension: number;
  sizeMin: number;
  sizeMax: number;
  elementShape: string;
  elementOrder: number;
  /** Export-unit the mesh numbers are written in (`export_mesh` unit / FE Mesh panel selector). */
  unit: string;
  /** `MeshGenerationInput.kind` — `"brep"` (STEP re-export) or `"stl"` (triangle bytes). */
  inputKind: "brep" | "stl";
  /** Edit ops in the source's sidecar at export time. */
  editOpCount: number;
}

/**
 * Builds the conversion-chain notes for one meshio-routed export. Capped at
 * six short lines: a provenance block is a header, not a log file. A
 * `sizeMax` still at the "unbounded" sentinel renders as `auto`, not `1e+22`.
 */
export function buildMeshProvenanceNotes(facts: MeshProvenanceFacts): ProvenanceNote[] {
  const sizeMax = facts.sizeMax === SIZE_MAX_SENTINEL ? "auto" : String(facts.sizeMax);
  const edits =
    facts.inputKind === "brep"
      ? `${facts.editOpCount} edit op(s) baked via STEP re-export`
      : "raw mesh bytes (edits NOT baked)";
  return [
    { category: "meshing-engine", detail: facts.engineUsed },
    { category: "mesh-size", detail: `sizeMin=${facts.sizeMin} sizeMax=${sizeMax}` },
    { category: "mesh-shape", detail: `dimension=${facts.dimension} shape=${facts.elementShape} order=${facts.elementOrder}` },
    { category: "export-unit", detail: facts.unit },
    { category: "edits-baked", detail: edits },
    { category: "exported-by", detail: "CAD Preview export_mesh" },
  ];
}
