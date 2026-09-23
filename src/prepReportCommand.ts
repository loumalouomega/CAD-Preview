/**
 * `cad-preview.prepReport` — the interactive half of the preparation report
 * bundle. Runs the SAME `generatePrepReportTool` the MCP server exposes over
 * the host's kernel client, under that document's own job owner (so Cancel
 * cancels only its kernel work), writes report.json + report.html to a chosen
 * folder, and offers to open the HTML.
 */
import * as vscode from "vscode";
import * as path from "path";
import type { KernelClient } from "./kernelClient";
import { generatePrepReportTool } from "./mcpTools";
import { ROUTED_EXTENSIONS } from "./fileRouter";

export async function runPrepReportCommand(
  context: vscode.ExtensionContext,
  pipeline: KernelClient,
  activeUri: vscode.Uri | undefined,
  /** Called before reading the model so the report sees the open tab's pending sidecar writes. */
  flush?: () => Promise<void>
): Promise<string | undefined> {
  let modelUri = activeUri;
  if (!modelUri) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Report",
      title: "Preparation report — pick a model",
      filters: { "CAD and mesh files": ROUTED_EXTENSIONS.map((e) => e.replace(/^\./, "")) },
    });
    if (!picked?.[0]) return;
    modelUri = picked[0];
  }
  const dirs = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Write report here",
    title: "Preparation report — destination folder",
    defaultUri: vscode.Uri.file(path.dirname(modelUri.fsPath)),
  });
  if (!dirs?.[0]) return;
  await flush?.();
  const outDir = dirs[0].fsPath;
  const target = modelUri;
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "CAD Preview: Preparation report", cancellable: true },
    async (progress, token) => {
      const abort = new AbortController();
      const sub = token.onCancellationRequested(() => abort.abort());
      try {
        return await generatePrepReportTool(
          { pipeline: pipeline.withJob({ owner: target.toString(), signal: abort.signal }), extensionPath: context.extensionPath },
          { path: target.fsPath, outputDir: outDir },
          (p) => progress.report({ message: p.message })
        );
      } finally {
        sub.dispose();
      }
    }
  );
  const html = result.written[1];
  const unavailable = result.sections.filter((s) => s.status === "unavailable").length;
  void vscode.window
    .showInformationMessage(`Preparation report written (${result.sections.length} sections, ${unavailable} unavailable).`, "Open report")
    .then((choice) => {
      if (choice === "Open report") void vscode.env.openExternal(vscode.Uri.file(html));
    });
  return html;
}
