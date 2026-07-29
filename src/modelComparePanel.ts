import * as vscode from "vscode";
import { routeFile } from "./fileRouter";
import { readEdits } from "./editsStore";
import { compareModels } from "./modelDiffHost";
import type { ModelDiff, SolidSignature } from "./modelDiff";
import type { BRepFormat } from "./massProperties";

const BREP_FILTER = { "STEP / IGES / BREP": ["step", "stp", "iges", "igs", "brep"] };

async function pickBRepFile(title: string): Promise<vscode.Uri | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: title,
    filters: BREP_FILTER,
  });
  return uris?.[0];
}

/**
 * "CAD Preview: Compare Models…" — a standalone command (like `open`/
 * `whatsNew`), not gated on a focused editor. Prompts for two B-rep files (A
 * defaults to `defaultUri` — the currently-focused editor's file, if any —
 * skipping straight to picking B), diffs them via `modelDiffHost.ts`'s
 * `compareModels()`, and renders the result in a standalone webview panel
 * mirroring `whatsNew.ts`'s precedent. B-rep only — the panel rejects with a
 * clear message rather than crashing on a mesh-format file, matching every
 * other B-rep-only feature's graceful-skip convention (see CLAUDE.md's
 * "Compare Models" section for why: mesh formats have no host-side geometry
 * to independently re-derive centroids/volumes from without a webview).
 */
export async function runCompareModelsCommand(context: vscode.ExtensionContext, defaultUri?: vscode.Uri): Promise<void> {
  try {
    const uriA = defaultUri ?? (await pickBRepFile("Select model A"));
    if (!uriA) return;
    const uriB = await pickBRepFile("Select model B");
    if (!uriB) return;

    const routeA = routeFile(uriA.fsPath);
    const routeB = routeFile(uriB.fsPath);
    if (!routeA || routeA.strategy !== "occt" || !routeB || routeB.strategy !== "occt") {
      void vscode.window.showErrorMessage("Compare Models only supports STEP, IGES, and BREP files.");
      return;
    }

    const [bytesA, bytesB, editsA, editsB] = await Promise.all([
      vscode.workspace.fs.readFile(uriA),
      vscode.workspace.fs.readFile(uriB),
      readEdits(uriA),
      readEdits(uriB),
    ]);

    const diff = await compareModels(
      context.extensionPath,
      bytesA,
      routeA.format as BRepFormat,
      editsA.ops,
      bytesB,
      routeB.format as BRepFormat,
      editsB.ops
    );

    showModelDiffPanel(uriA, uriB, diff);
  } catch (err) {
    void vscode.window.showErrorMessage(`Compare Models failed: ${(err as Error).message}`);
  }
}

function fmt(n: number): string {
  return Number.isFinite(n) ? String(Number(n.toPrecision(5))) : "—";
}

function signatureRow(s: SolidSignature): string {
  return `<tr><td>${s.id}</td><td>${s.centre.map(fmt).join(", ")}</td><td>${fmt(s.volume)}</td></tr>`;
}

function matchRow(m: ModelDiff["matched"][number]): string {
  const confidence = m.centreDistance < 1e-6 && m.volumeDeltaPct < 1e-6 ? "identical" : "moved/changed";
  return `<tr><td>${m.a.id}</td><td>${m.b.id}</td><td>${fmt(m.centreDistance)}</td><td>${fmt(m.volumeDeltaPct)}%</td><td>${confidence}</td></tr>`;
}

function showModelDiffPanel(uriA: vscode.Uri, uriB: vscode.Uri, diff: ModelDiff): void {
  const panel = vscode.window.createWebviewPanel(
    "cadPreviewModelDiff",
    "Compare Models — CAD Preview",
    vscode.ViewColumn.Beside,
    { enableScripts: false, localResourceRoots: [] }
  );

  const csp = [`default-src 'none'`, `style-src 'unsafe-inline'`].join("; ");
  const nameA = vscode.workspace.asRelativePath(uriA);
  const nameB = vscode.workspace.asRelativePath(uriB);

  const matchedRows = diff.matched.length
    ? diff.matched.map(matchRow).join("\n")
    : `<tr><td colspan="5" class="md-empty">No matched solids.</td></tr>`;
  const removedRows = diff.removed.length ? diff.removed.map(signatureRow).join("\n") : `<tr><td colspan="3" class="md-empty">None.</td></tr>`;
  const addedRows = diff.added.length ? diff.added.map(signatureRow).join("\n") : `<tr><td colspan="3" class="md-empty">None.</td></tr>`;

  panel.webview.html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Compare Models</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 0 24px 24px;
    }
    h1 { font-weight: 600; font-size: 1.2em; }
    h2 { font-weight: 600; font-size: 1em; margin-top: 24px; }
    .md-files { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-bottom: 8px; }
    .md-summary { display: flex; gap: 16px; margin: 12px 0 20px; }
    .md-stat { padding: 8px 14px; border: 1px solid var(--vscode-widget-border, #3c3c3c); border-radius: 4px; }
    .md-stat b { display: block; font-size: 1.4em; }
    table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
    th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid var(--vscode-widget-border, #3c3c3c); }
    th { color: var(--vscode-descriptionForeground); font-weight: 600; }
    .md-empty { color: var(--vscode-descriptionForeground); font-style: italic; }
    .md-note {
      margin-top: 20px;
      padding: 8px 12px;
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textBlockQuote-border, #007fd4);
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <h1>Compare Models</h1>
  <div class="md-files">A: <code>${nameA}</code> &nbsp;·&nbsp; B: <code>${nameB}</code></div>
  <div class="md-summary">
    <div class="md-stat"><b>${diff.added.length}</b>Added</div>
    <div class="md-stat"><b>${diff.removed.length}</b>Removed</div>
    <div class="md-stat"><b>${diff.matched.length}</b>Matched</div>
  </div>

  <h2>Matched solids</h2>
  <table>
    <thead><tr><th>A</th><th>B</th><th>Centre displacement</th><th>Volume Δ</th><th>Confidence</th></tr></thead>
    <tbody>${matchedRows}</tbody>
  </table>

  <h2>Removed (only in A)</h2>
  <table>
    <thead><tr><th>Id</th><th>Centre</th><th>Volume</th></tr></thead>
    <tbody>${removedRows}</tbody>
  </table>

  <h2>Added (only in B)</h2>
  <table>
    <thead><tr><th>Id</th><th>Centre</th><th>Volume</th></tr></thead>
    <tbody>${addedRows}</tbody>
  </table>

  <div class="md-note">
    Solids are matched by bounding-box-centroid proximity + volume similarity —
    a heuristic, not exact correspondence. "Matched" rows always show their raw
    centre displacement and volume delta so you can judge confidence yourself;
    a large displacement or volume delta on a matched row may mean the solid
    was heavily edited rather than simply moved.
  </div>
</body>
</html>`;
}
