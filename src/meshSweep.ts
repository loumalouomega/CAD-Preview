/**
 * Pure, vscode/WASM-free mesh-refinement sweep types + TSV (roadmap Tier 1
 * "Measured mesh-refinement comparison", closed) — split out for the same
 * reason every other pure/impure pair in this codebase is split
 * (`bomExport.ts`'s doc comment): `mcpTools.ts` must stay importable under
 * vitest with no `.wasm` anywhere in its graph, and it needs {@link sweepTsv}
 * as a VALUE, while `mcpTools.ts` hosts the kernel-touching sweep itself.
 */

import type { MeshEngine } from "./meshOptions";
import type { QualitySummary } from "./meshQuality";

/** One swept size's outcome — an individual result, never a throw: a failed
 * run is a row with `status: "error"`, so one bad size can't discard the
 * rest of the comparison. */
export interface MeshSweepRun {
  /** The swept size in mm (applied to both `sizeMin` and `sizeMax`). */
  size: number;
  status: "ok" | "error";
  nodeCount: number | null;
  elementCount: number | null;
  /** Wall-clock ms for this run's generate call (client-side, same basis as
   * `generate_mesh`'s own `elapsedMs`). */
  elapsedMs: number | null;
  /** Which volume mesher actually ran (same downgrade rules as
   * `generate_mesh` — reported per run, never assumed). */
  engineUsed: MeshEngine | null;
  /** The existing per-run quality summary (`null` when uncomputable, same as
   * `generate_mesh`). The histogram rides along here (agents can diff
   * distributions); the TSV carries only min/mean. */
  quality: QualitySummary | null;
  /** Files written for this run (empty when no `outputDir` was given). */
  outputPaths: string[];
  /** Present only when `status === "error"`. */
  error: string | null;
}

/**
 * Tab-separated sweep summary — the ready-to-paste spreadsheet handoff (the
 * "Copy BOM" tab-separated convention this feature was mined from, via
 * `bomTsv`). Numbers are rounded to 4 decimal places only HERE (display),
 * never in {@link MeshSweepRun} itself; a failed run leaves its numeric cells
 * empty rather than writing a misleading `0`. Multiple outputs join with
 * `";"` (a path can legally contain a comma, never a tab).
 */
export function sweepTsv(rows: MeshSweepRun[]): string {
  const fmt = (n: number | null): string => (n === null ? "" : String(Number(n.toFixed(4))));
  const header = [
    "size_mm",
    "status",
    "nodes",
    "elements",
    "elapsed_ms",
    "engine",
    "quality_min",
    "quality_mean",
    "outputs",
    "error",
  ];
  const lines = rows.map((r) =>
    [
      fmt(r.size),
      r.status,
      fmt(r.nodeCount),
      fmt(r.elementCount),
      fmt(r.elapsedMs),
      r.engineUsed ?? "",
      fmt(r.quality?.min ?? null),
      fmt(r.quality?.mean ?? null),
      r.outputPaths.join(";"),
      r.error ?? "",
    ].join("\t")
  );
  return [header.join("\t"), ...lines].join("\n");
}

/**
 * Per-run output filename (no directory): `<stem>-size-<size>.<extension>`,
 * so every exported file identifies its own settings without opening it.
 * `String(size)` keeps the authored value verbatim (`0.5`, not `0.5000`).
 */
export function sweepOutputName(stem: string, size: number, extension: string): string {
  return `${stem}-size-${String(size)}.${extension}`;
}
