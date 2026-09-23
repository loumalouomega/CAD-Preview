/**
 * `cad-preview.batchExport` — the interactive half of batch export (roadmap
 * "Batch export with per-file results"). Session-free: it never opens an
 * editor, it runs the SAME `batchExportTool` the MCP server exposes, over the
 * extension host's own kernel client under a `batch-<n>` owner, so cancelling
 * it cancels only its own kernel work (never another tab's), and shows the
 * per-file rows in a read-only report panel.
 */
import * as vscode from "vscode";
import * as path from "path";
import type { KernelClient } from "./kernelClient";
import { BATCH_TARGETS, batchExportTool, type BatchTarget } from "./mcpTools";
import { batchReportHtml } from "./batchExport";
import { ROUTED_EXTENSIONS } from "./fileRouter";

const TARGET_LABELS: Record<BatchTarget, string> = {
  step: "STEP (.step)",
  iges: "IGES (.iges)",
  brep: "BREP (.brep)",
  svg: "Technical drawing — SVG (front view)",
  dxf: "Technical drawing — DXF (front view)",
  "sheet-svg": "Drawing sheet — SVG",
  "sheet-dxf": "Drawing sheet — DXF",
};

let batchCounter = 0;

export async function runBatchExportCommand(context: vscode.ExtensionContext, pipeline: KernelClient): Promise<void> {
  const inputs = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: "Batch export",
    title: "Batch export — pick CAD/mesh files",
    filters: { "CAD and mesh files": ROUTED_EXTENSIONS.map((e) => e.replace(/^\./, "")) },
  });
  if (!inputs || inputs.length === 0) return;

  const targetPick = await vscode.window.showQuickPick(
    BATCH_TARGETS.map((t) => ({ label: TARGET_LABELS[t], target: t })),
    { title: "Batch export — target", placeHolder: "Export every file to…" }
  );
  if (!targetPick) return;

  const outDirs = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Export here",
    title: "Batch export — destination folder",
    defaultUri: vscode.Uri.file(path.dirname(inputs[0].fsPath)),
  });
  if (!outDirs || outDirs.length === 0) return;

  const collisionPick = await vscode.window.showQuickPick(
    [
      { label: "Skip existing outputs", policy: "skip" as const },
      { label: "Add a numeric suffix", policy: "suffix" as const },
      { label: "Overwrite existing outputs", policy: "overwrite" as const, description: "inputs are never overwritten" },
    ],
    { title: "Batch export — when an output already exists" }
  );
  if (!collisionPick) return;

  const owner = `batch-${++batchCounter}`;
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "CAD Preview: Batch export", cancellable: true },
    async (progress, token) => {
      const abort = new AbortController();
      const sub = token.onCancellationRequested(() => abort.abort());
      try {
        let last = 0;
        return await batchExportTool(
          { pipeline: pipeline.withJob({ owner, signal: abort.signal }), extensionPath: context.extensionPath },
          { inputs: inputs.map((u) => u.fsPath), target: targetPick.target, outDir: outDirs[0].fsPath, onCollision: collisionPick.policy },
          (p) => {
            const total = p.total ?? inputs.length;
            progress.report({ message: `${p.progress}/${total} — ${p.message ?? ""}`, increment: ((p.progress - last) / total) * 100 });
            last = p.progress;
          },
          abort.signal
        );
      } finally {
        sub.dispose();
      }
    }
  );
  showBatchReport(result.rows, result.summary, `Batch export → ${TARGET_LABELS[result.target]}`, result.warnings);
  const s = result.summary;
  void vscode.window.showInformationMessage(
    `Batch export: ${s.ok} ok, ${s.failed} failed, ${s.skipped} skipped${s.cancelled ? `, ${s.cancelled} cancelled` : ""}.`
  );
}

function showBatchReport(
  rows: Parameters<typeof batchReportHtml>[0],
  summary: Parameters<typeof batchReportHtml>[1],
  title: string,
  warnings: string[]
): void {
  const panel = vscode.window.createWebviewPanel("cadPreviewBatchReport", "Batch Export — CAD Preview", vscode.ViewColumn.Active, {
    enableScripts: false,
    localResourceRoots: [],
  });
  const csp = [`default-src 'none'`, `style-src 'unsafe-inline'`].join("; ");
  const warningBlock = warnings.length
    ? `<p class="warn">${warnings.map((w) => `⚠ ${w.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}`).join("<br/>")}</p>`
    : "";
  panel.webview.html = /* html */ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px 20px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  .status { font-weight: 600; }
  .st-failed .status { color: var(--vscode-errorForeground); }
  .st-skipped .status, .st-cancelled .status { color: var(--vscode-descriptionForeground); }
  .summary, .warn { color: var(--vscode-descriptionForeground); }
</style></head>
<body>${batchReportHtml(rows, summary, title)}${warningBlock}</body></html>`;
}
