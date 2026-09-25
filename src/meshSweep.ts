/**
 * Pure, vscode/WASM-free mesh-refinement sweep types + TSV (roadmap Tier 1
 * "Measured mesh-refinement comparison", closed) — split out for the same
 * reason every other pure/impure pair in this codebase is split
 * (`bomExport.ts`'s doc comment): `mcpTools.ts` must stay importable under
 * vitest with no `.wasm` anywhere in its graph, and it needs {@link sweepTsv}
 * as a VALUE, while `mcpTools.ts` hosts the kernel-touching sweep itself.
 */

import type { MeshEngine, MeshOptions } from "./meshOptions";
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

/**
 * Hard cap on sweep rows — each row is a full meshing pass (seconds to
 * minutes of WASM time), so an uncapped list is a hang by another name. Same
 * safety-caps-instead-of-sandboxing discipline as `MAX_STEPS`/
 * `MAX_TOTAL_OPS` in `parametricScript.ts`: hit it and the call throws
 * before any work starts, never a silent truncation.
 */
export const MAX_SWEEP_RUNS = 8;

/**
 * Carried on every sweep response and shown under the FE Mesh panel's sweep
 * table: rows describe meshing COST (nodes/elements/time) and element SHAPE
 * quality (minSICN) — neither establishes FE-solution convergence, which
 * needs a solver run on the exported meshes, not just finer elements.
 */
export const SWEEP_NOTE =
  "Mesh-density/quality trends across swept sizes do NOT establish FE-solution convergence — that needs a solver run on the exported meshes, not just finer elements. Rows describe meshing cost (nodes/elements/time) and element shape quality (minSICN), not solution accuracy.";

/** Throws on a malformed size list (empty, over the cap, or a non-positive /
 * non-finite entry) — before any meshing work, so a bad sweep costs nothing. */
export function validateSweepSizes(sizes: unknown): number[] {
  if (!Array.isArray(sizes) || sizes.length === 0) {
    throw new Error("sizes must be a non-empty array of positive mesh sizes in mm.");
  }
  if (sizes.length > MAX_SWEEP_RUNS) {
    throw new Error(
      `sizes has ${sizes.length} entries — capped at ${MAX_SWEEP_RUNS} runs per sweep (each run is a full meshing pass).`
    );
  }
  for (const s of sizes) {
    if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) {
      throw new Error(`sizes must all be finite positive numbers in mm (got ${JSON.stringify(s)}).`);
    }
  }
  return sizes as number[];
}

/**
 * Parses the FE Mesh panel's size field ("0.5, 1, 2" — commas or spaces) into
 * a validated size list. Throws the same messages as {@link validateSweepSizes}.
 */
export function parseSweepSizes(text: string): number[] {
  const tokens = text.split(/[\s,;]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) throw new Error("Enter one or more mesh sizes in mm, e.g. 4, 2, 1.");
  const sizes = tokens.map((t) => {
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error(`"${t}" is not a number.`);
    return n;
  });
  return validateSweepSizes(sizes);
}

/** The slice of a `MeshResult` a sweep row reads. */
export interface SweepGenerateResult {
  nodeCount: number;
  elementCount: number;
  engineUsed: MeshEngine;
  quality?: QualitySummary | null;
  warnings: string[];
}

/**
 * The per-size loop, shared by `compare_mesh_refinement` and the FE Mesh
 * panel's sweep form so their rows cannot disagree: each size meshes the SAME
 * `baseOptions` as a uniform mesh (`sizeMin = sizeMax = size`), sequentially;
 * `elapsedMs` covers the generate call only; a failed run (generate or the
 * optional `writeOutputs`) is a row with `status: "error"`, never a thrown
 * sweep. `writeOutputs` returns the paths it wrote for that run.
 */
export async function runMeshSweep<R extends SweepGenerateResult>(
  sizes: readonly number[],
  baseOptions: MeshOptions,
  generate: (options: MeshOptions) => Promise<R>,
  hooks: {
    warnings: string[];
    writeOutputs?: (size: number, options: MeshOptions, result: R) => Promise<string[]>;
    onRunStart?: (index: number, size: number) => void;
    onRunDone?: (index: number, run: MeshSweepRun) => void;
  }
): Promise<MeshSweepRun[]> {
  const runs: MeshSweepRun[] = [];
  for (let i = 0; i < sizes.length; i++) {
    const size = sizes[i];
    const runOptions: MeshOptions = { ...baseOptions, sizeMin: size, sizeMax: size };
    hooks.onRunStart?.(i, size);
    const started = Date.now();
    let row: MeshSweepRun;
    try {
      const result = await generate(runOptions);
      row = {
        size,
        status: "ok",
        nodeCount: result.nodeCount,
        elementCount: result.elementCount,
        elapsedMs: Date.now() - started,
        engineUsed: result.engineUsed,
        quality: result.quality ?? null,
        outputPaths: [],
        error: null,
      };
      if (hooks.writeOutputs) row.outputPaths = await hooks.writeOutputs(size, runOptions, result);
      hooks.warnings.push(...result.warnings);
    } catch (err) {
      row = {
        size,
        status: "error",
        nodeCount: null,
        elementCount: null,
        elapsedMs: null,
        engineUsed: null,
        quality: null,
        outputPaths: [],
        error: (err as Error)?.message ?? String(err),
      };
    }
    runs.push(row);
    hooks.onRunDone?.(i, row);
  }
  return runs;
}
