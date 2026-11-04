// vscode-free and kernel-free: the Mesh Health ▸ Fit to CAD… pick, kept apart from
// meshFitCad.ts (which loads the WASM kernel) so the extension host can import it.
import type { FitMeshToCadOptions } from "./meshFitCad";

/**
 * What the Mesh Health ▸ Fit to CAD… button asks before it fits. Two levels only:
 * the freeform modes (`adaptive`/`network`/`auto`) were measured 8-12x slower with a
 * worse skin deviation, and `refineSegmentation` + `adaptive` hit the kernel worker's
 * five-minute watchdog on a 3 000-triangle skin, so they stay MCP-only options.
 */
export interface FitToCadLevel {
  id: "default" | "refine";
  label: string;
  detail: string;
  options: FitMeshToCadOptions;
}
export const FIT_TO_CAD_LEVELS: readonly FitToCadLevel[] = [
  {
    id: "default",
    label: "Kernel defaults (CAD-made meshes)",
    detail:
      "Segments by dihedral angle and fits every patch. Fast, and exact on a mesh tessellated from CAD; a rough or organic skin (an optimizer's, a scan's) mostly stays faceted.",
    options: {},
  },
  {
    id: "refine",
    label: "Refine the patches first (rough or organic skins)",
    detail:
      "Moves patch boundaries onto the surfaces before fitting (refineSegmentation, tolerance 0.2 % of the diagonal). On a 22k-triangle optimized hook the faceted area fell from 95 % to 42 % in about three minutes; the solid may lie up to ~0.4 % of the diagonal from the skin.",
    options: { refineSegmentation: true, refineTolerance: 2e-3 },
  },
];
