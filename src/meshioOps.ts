// Declarative meshio++ mesh-operation specs for the interactive Mesh Ops
// panel (roadmap Tier 2 "Mesh-operations panel for meshio sources").
//
// Pure, vscode/WASM/DOM-free — shared by the webview panel (which builds a
// spec from its form) and `provider.ts` (which validates before calling the
// kernel). The kernel itself (`meshioService.ts`'s `runMeshioOps`) stays the
// single executor; this module is only the vocabulary + validation gate, the
// same split `opCatalog.ts` provides for edit ops. Deliberately NOT imported
// from `meshioService.ts` as a value (that module pulls in the WASM graph);
// `meshioService.ts` keeps its own `MeshioOpSpec` interface and this file
// mirrors it structurally — kept in lockstep by the test below.

/** The seven operations `transform_mesh` (and now the panel) support. */
export const MESHIO_OP_IDS = [
  "clean",
  "decimate",
  "smooth",
  "subdivide",
  "refine",
  "agglomerate",
  "convertCells",
] as const;

export type MeshioOpId = (typeof MESHIO_OP_IDS)[number];

/** Plain-JSON operation spec — crosses the host↔webview protocol untouched. */
export interface MeshioOpSpec {
  op: MeshioOpId;
  ratio?: number;
  iterations?: number;
  levels?: number;
  method?: string;
  mode?: string;
  targetGroupSize?: number;
}

/** Short human-readable label per operation, for the panel `<select>`. */
export const MESHIO_OP_LABELS: Record<MeshioOpId, string> = {
  clean: "Clean (weld + drop degenerate/duplicate)",
  decimate: "Decimate (quadric edge-collapse)",
  smooth: "Smooth (Taubin/Laplacian)",
  subdivide: "Subdivide once",
  refine: "Refine (levels)",
  agglomerate: "Agglomerate (coarsen)",
  convertCells: "Convert cells (linearize/simplexify/elevate)",
};

/**
 * Validates an untrusted op spec (panel draft or protocol payload). Returns
 * the clean spec, or `null` when the op id is unknown. Numeric params are
 * range-checked only where `runMeshioOps` would otherwise throw unconditionally
 * (`decimateStlBoundary`'s `(0,1]` rule for `ratio`); everything else degrades
 * gracefully kernel-side per that function's own per-step report, so this
 * stays a shape gate, not a second executor.
 */
export function validateMeshioOpSpec(raw: unknown): MeshioOpSpec | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.op !== "string") return null;
  if (!(MESHIO_OP_IDS as readonly string[]).includes(r.op)) return null;
  const op = r.op as MeshioOpId;
  const spec: MeshioOpSpec = { op };
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const ratio = num(r.ratio);
  if (ratio !== undefined) {
    if (!(ratio > 0 && ratio <= 1)) return null;
    spec.ratio = ratio;
  }
  const iterations = num(r.iterations);
  if (iterations !== undefined) spec.iterations = Math.max(1, Math.floor(iterations));
  const levels = num(r.levels);
  if (levels !== undefined) spec.levels = Math.max(1, Math.floor(levels));
  if (typeof r.method === "string" && (r.method === "taubin" || r.method === "laplacian")) {
    spec.method = r.method;
  }
  if (typeof r.mode === "string" && (r.mode === "linearize" || r.mode === "simplexify" || r.mode === "elevate")) {
    spec.mode = r.mode;
  }
  const targetGroupSize = num(r.targetGroupSize);
  if (targetGroupSize !== undefined) spec.targetGroupSize = Math.max(1, Math.floor(targetGroupSize));
  return spec;
}
