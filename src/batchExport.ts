/**
 * Batch export with per-file results (roadmap "Batch export with per-file
 * results") — the PURE orchestrator shared by the `batch_export` MCP tool and
 * the `cad-preview.batchExport` command. Each file is exported by an injected
 * `exportOne` (in practice the SAME single-file tool functions an agent or the
 * Export menu uses), sequentially, so:
 *   - one bad file is a failed ROW, never an aborted batch;
 *   - no input is ever overwritten (an output colliding with ANY input is
 *     refused regardless of the collision policy), and existing outputs follow
 *     the explicit policy: skip (default), suffix, or overwrite;
 *   - cancellation stops before the next file and reports the rest as
 *     cancelled — work already written stays written and is listed.
 * Hidden editors are never opened: this is a headless pipeline loop.
 */
import * as path from "path";
import { escapeHtml } from "./html";

export type CollisionPolicy = "skip" | "suffix" | "overwrite";

export interface BatchRow {
  input: string;
  status: "ok" | "failed" | "skipped" | "cancelled";
  outputs: string[];
  /** Ops baked into the output (0 for mesh sources, whose edits are never baked). */
  editsBaked: number;
  error?: string;
  warnings: string[];
}

export interface BatchSummary {
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

/** `{stem}` = input basename without its (possibly compound) extension, `{ext}` = target extension, `{name}` = full basename. */
export function outputNameFor(inputPath: string, ext: string, naming = "{stem}.{ext}"): string {
  const base = path.basename(inputPath);
  const dot = base.indexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const name = naming.replace(/\{stem\}/g, stem).replace(/\{ext\}/g, ext).replace(/\{name\}/g, base);
  if (name.includes("/") || name.includes("\\") || name === "" || name === "." || name === "..") {
    throw new Error(`The naming pattern "${naming}" must produce a bare file name (got "${name}").`);
  }
  return name;
}

/**
 * The output path to write for `desired`, or null to skip. `taken` holds paths
 * already produced in this batch (two inputs mapping to one name suffix apart
 * under "suffix", and are refused under skip/overwrite — never silently
 * overwritten by a sibling).
 */
export function resolveCollision(
  desired: string,
  policy: CollisionPolicy,
  exists: (p: string) => boolean,
  inputs: ReadonlySet<string>,
  taken: ReadonlySet<string>
): { path: string | null; reason?: string } {
  const norm = (p: string) => path.resolve(p);
  const clash = (p: string) => inputs.has(norm(p)) || taken.has(norm(p)) || exists(p);
  if (inputs.has(norm(desired))) {
    if (policy !== "suffix") return { path: null, reason: "the output would overwrite an input file — refused" };
  }
  if (!clash(desired)) return { path: desired };
  if (policy === "overwrite" && !inputs.has(norm(desired)) && !taken.has(norm(desired))) return { path: desired };
  if (policy === "skip") return { path: null, reason: `${path.basename(desired)} already exists — skipped (collision policy: skip)` };
  if (policy === "overwrite") return { path: null, reason: "another file in this batch already produced this output — refused" };
  const ext = path.extname(desired);
  const stem = desired.slice(0, desired.length - ext.length);
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!clash(candidate)) return { path: candidate };
  }
  return { path: null, reason: "no free suffixed name" };
}

export interface BatchRunOptions {
  outDir: string;
  /** Target file extension for naming (e.g. "step", "svg"). */
  ext: string;
  naming?: string;
  onCollision?: CollisionPolicy;
  exists: (p: string) => boolean;
  /** Exports one input to `outPath`; returns written paths, baked-op count and warnings. Throw to fail the row. */
  exportOne: (input: string, outPath: string) => Promise<{ outputs: string[]; editsBaked: number; warnings: string[] }>;
  isCancelled?: () => boolean;
  onProgress?: (done: number, total: number, row: BatchRow) => void;
}

/** The kernel-client's vocabulary for "a WASM abort reset the singleton; the
 *  next call gets a fresh worker". Matched case-insensitively because the exact
 *  phrasing differs per service — the same pattern `mcp-smoke`'s
 *  `callWithCleanRetry` and the perf harness test against. */
const KERNEL_RESET_RE = /kernel has been reset/i;

export async function runBatch(inputs: readonly string[], options: BatchRunOptions): Promise<{ rows: BatchRow[]; summary: BatchSummary }> {  const policy = options.onCollision ?? "skip";
  const inputSet = new Set(inputs.map((i) => path.resolve(i)));
  const taken = new Set<string>();
  const rows: BatchRow[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    if (options.isCancelled?.()) {
      for (const rest of inputs.slice(i)) rows.push({ input: rest, status: "cancelled", outputs: [], editsBaked: 0, warnings: [] });
      break;
    }
    let row: BatchRow;
    try {
      const desired = path.join(options.outDir, outputNameFor(input, options.ext, options.naming));
      const resolved = resolveCollision(desired, policy, options.exists, inputSet, taken);
      if (!resolved.path) {
        row = { input, status: "skipped", outputs: [], editsBaked: 0, warnings: [], error: resolved.reason };
      } else {
        taken.add(path.resolve(resolved.path));
        // One clean retry after a KERNEL RESET, and only that. A WASM abort in
        // the OCCT/Gmsh worker ("memory access out of bounds") resets the
        // singleton; the kernel client respawns a fresh worker on the next call,
        // so the retry runs on a clean one and succeeds. This is the same
        // recovery `mcp-smoke`'s `callWithCleanRetry` and the perf harness
        // already perform — batch export was the one export path without it,
        // which is why a loaded CI runner turned an OCCT abort into "0 ok,
        // 3 failed" for a batch whose every file was fine.
        //
        // Retrying is safe here because the export is a deterministic write to
        // an already-resolved path: `taken` was updated before the attempt, so a
        // collision cannot be re-resolved onto the same name, and a partial file
        // from the aborted attempt is simply overwritten by the retry. Ordinary
        // errors are never retried, and a SECOND failure is recorded as the
        // failure it is.
        let attempt = 0;
        for (;;) {
          try {
            const r = await options.exportOne(input, resolved.path);
            for (const o of r.outputs) taken.add(path.resolve(o));
            row = { input, status: "ok", outputs: r.outputs, editsBaked: r.editsBaked, warnings: r.warnings };
            break;
          } catch (err) {
            const message = (err as Error)?.message ?? String(err);
            if (attempt === 0 && KERNEL_RESET_RE.test(message)) {
              attempt++;
              continue;
            }
            row = { input, status: "failed", outputs: [], editsBaked: 0, warnings: [], error: message.split("\n")[0] };
            break;
          }
        }
      }
    } catch (err) {
      row = { input, status: "failed", outputs: [], editsBaked: 0, warnings: [], error: ((err as Error)?.message ?? String(err)).split("\n")[0] };
    }
    rows.push(row);
    options.onProgress?.(i + 1, inputs.length, row);
  }
  const count = (s: BatchRow["status"]) => rows.filter((r) => r.status === s).length;
  return { rows, summary: { total: inputs.length, ok: count("ok"), failed: count("failed"), skipped: count("skipped"), cancelled: count("cancelled") } };
}

/** Spreadsheet-ready TSV of the rows. */
export function batchTsv(rows: readonly BatchRow[]): string {
  const clean = (s: string) => s.replace(/[\t\n\r]/g, " ");
  const lines = ["input\tstatus\toutputs\tedits_baked\terror\twarnings"];
  for (const r of rows) lines.push([r.input, r.status, r.outputs.join(";"), String(r.editsBaked), r.error ?? "", r.warnings.join(" | ")].map(clean).join("\t"));
  return lines.join("\n") + "\n";
}

/** Body HTML (no scripts, no external resources) for the batch report panel. */
export function batchReportHtml(rows: readonly BatchRow[], summary: BatchSummary, title: string): string {
  const cell = (s: string) => `<td>${escapeHtml(s)}</td>`;
  const body = rows
    .map((r) => {
      const detail = [r.error ?? "", ...r.warnings.map((w) => `⚠ ${w}`)].filter(Boolean).join("<br/>");
      return `<tr class="st-${r.status}">${cell(path.basename(r.input))}<td class="status">${escapeHtml(r.status)}</td>${cell(
        r.outputs.map((o) => path.basename(o)).join(", ")
      )}${cell(String(r.editsBaked))}<td>${detail
        .split("<br/>")
        .map((d) => escapeHtml(d))
        .join("<br/>")}</td></tr>`;
    })
    .join("\n");
  const counts = `${summary.ok} ok · ${summary.failed} failed · ${summary.skipped} skipped · ${summary.cancelled} cancelled (of ${summary.total})`;
  return `<h2>${escapeHtml(title)}</h2><p class="summary">${escapeHtml(counts)}</p>
<table><thead><tr><th>Input</th><th>Status</th><th>Output</th><th>Edits baked</th><th>Detail</th></tr></thead>
<tbody>${body || '<tr><td colspan="5">No files.</td></tr>'}</tbody></table>`;
}
