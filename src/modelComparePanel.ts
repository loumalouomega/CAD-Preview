import * as vscode from "vscode";
import { routeFile } from "./fileRouter";
import { readEdits } from "./editsStore";
import { compareModels, type CompareSource } from "./modelDiffHost";
import type { ModelDiff, SolidSignature } from "./modelDiff";
import type { BRepFormat } from "./massProperties";
import { renderSnapshot, isRenderAvailable, DEFAULT_VIEWS, type RenderImage } from "./renderService";

const COMPARABLE_MESH_FORMATS = new Set(["stl", "obj", "ply"]);

const COMPARE_FILTER = { "STEP / IGES / BREP / STL / OBJ / PLY": ["step", "stp", "iges", "igs", "brep", "stl", "obj", "ply"] };

async function pickCompareFile(title: string): Promise<vscode.Uri | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: title,
    filters: COMPARE_FILTER,
  });
  return uris?.[0];
}

/** Builds the `CompareSource` `compareModels()` needs for one side, plus any
 * warning about what it couldn't account for — `undefined` (with a warning)
 * when the file's format isn't compare-able at all (glTF/meshio formats: no
 * host-side geometry to independently derive centroids/volumes from without
 * a webview — the same gap this feature always had, now narrowed to just
 * those, since STEP/IGES/BREP/STL/OBJ/PLY are all supported). */
async function resolveCompareSource(uri: vscode.Uri): Promise<{ source: CompareSource; warning?: string } | { source: undefined; warning: string }> {
  const route = routeFile(uri.fsPath);
  const name = vscode.workspace.asRelativePath(uri);
  const meshFormat = route?.strategy === "three" && COMPARABLE_MESH_FORMATS.has(route.format) ? route.format : null;
  if (!route || (route.strategy !== "occt" && !meshFormat)) {
    return { source: undefined, warning: `${name}: unsupported format for Compare Models (STEP/IGES/BREP/STL/OBJ/PLY only).` };
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (route.strategy === "occt") {
    const { ops } = await readEdits(uri);
    return { source: { kind: "brep", bytes, format: route.format as BRepFormat, ops } };
  }
  const { ops } = await readEdits(uri);
  const warning =
    ops.length > 0
      ? `${name}: pending edits are NOT baked in (${meshFormat!.toUpperCase()} sources have no host-side edit engine) — comparing the raw file only.`
      : undefined;
  return { source: { kind: meshFormat as "stl" | "obj" | "ply", bytes }, warning };
}

/**
 * "CAD Preview: Compare Models…" — a standalone command (like `open`/
 * `whatsNew`), not gated on a focused editor. Prompts for two files (A
 * defaults to `defaultUri` — the currently-focused editor's file, if any —
 * skipping straight to picking B), diffs them via `modelDiffHost.ts`'s
 * `compareModels()`, and renders the result in a standalone webview panel
 * mirroring `whatsNew.ts`'s precedent. STEP/IGES/BREP (edits baked in) and
 * STL/OBJ/PLY (raw file bytes — no host-side mesh edit engine to bake edits
 * with) are supported, in any combination; glTF/meshio-only formats are
 * rejected with a clear message rather than crashing, matching this
 * feature's original B-rep-only graceful-skip convention (see CLAUDE.md's
 * "Compare Models" section for why those remain out of reach headlessly).
 */
export async function runCompareModelsCommand(context: vscode.ExtensionContext, defaultUri?: vscode.Uri): Promise<void> {
  try {
    const uriA = defaultUri ?? (await pickCompareFile("Select model A"));
    if (!uriA) return;
    const uriB = await pickCompareFile("Select model B");
    if (!uriB) return;

    const [resolvedA, resolvedB] = await Promise.all([resolveCompareSource(uriA), resolveCompareSource(uriB)]);
    if (!resolvedA.source || !resolvedB.source) {
      const message = [resolvedA.warning, resolvedB.warning].filter(Boolean).join(" ");
      void vscode.window.showErrorMessage(`Compare Models: ${message}`);
      return;
    }

    const diff = await compareModels(context.extensionPath, resolvedA.source, resolvedB.source);
    const warnings = [resolvedA.warning, resolvedB.warning].filter((w): w is string => !!w);

    const { imagesA, imagesB, warnings: snapshotWarnings } = await renderCompareSnapshots(
      context.extensionPath,
      resolvedA.source,
      resolvedB.source
    );
    warnings.push(...snapshotWarnings);

    showModelDiffPanel(uriA, uriB, diff, warnings, imagesA, imagesB);
  } catch (err) {
    void vscode.window.showErrorMessage(`Compare Models failed: ${(err as Error).message}`);
  }
}

/**
 * Visual diff (roadmap item, closed): renders each side's whole-model
 * snapshot via the same headless `render_snapshot` engine `mcpTools.ts`'s
 * `compare_models` tool uses (`renderService.ts`) — B-rep sources only, same
 * gate as that tool; mesh (STL/OBJ/PLY) sides degrade to a warning, never a
 * blocked comparison. Probes `isRenderAvailable()` ONCE (not per side) only
 * when at least one side actually needs it, then renders both B-rep sides in
 * parallel (`Promise.all` — each gets its own independent, disposable
 * Chromium instance, verified safe to run concurrently; see `renderService.
 * ts`'s doc comment). Never throws: a skipped/failed snapshot is reported as
 * a warning and must never block the numeric diff this feature already
 * produces (same "additive, not required" convention as every other
 * `supported: false` path in this codebase).
 */
async function renderCompareSnapshots(
  extensionPath: string,
  sourceA: CompareSource,
  sourceB: CompareSource
): Promise<{ imagesA: RenderImage[]; imagesB: RenderImage[]; warnings: string[] }> {
  const warnings: string[] = [];
  const needsRender = sourceA.kind === "brep" || sourceB.kind === "brep";
  let available = false;
  if (needsRender) {
    const avail = await isRenderAvailable();
    available = avail.available;
    if (!available) warnings.push(`Visual snapshots skipped — ${avail.reason ?? "renderer unavailable"}.`);
  }
  const renderOne = async (label: "A" | "B", source: CompareSource): Promise<RenderImage[]> => {
    if (source.kind !== "brep") {
      warnings.push(`Model ${label}: visual snapshot not available for ${source.kind.toUpperCase()} sources (render_snapshot is B-rep sources only).`);
      return [];
    }
    if (!available) return [];
    const result = await renderSnapshot(extensionPath, source.bytes, source.format, source.ops, { views: DEFAULT_VIEWS });
    if (!result.supported || !result.images) {
      warnings.push(`Model ${label}: visual snapshot failed — ${result.reason ?? "unknown error"}.`);
      return [];
    }
    return result.images;
  };
  const [imagesA, imagesB] = await Promise.all([renderOne("A", sourceA), renderOne("B", sourceB)]);
  return { imagesA, imagesB, warnings };
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

/** Builds the "Before / After" snapshot grid — one row per view direction
 * (`DEFAULT_VIEWS` order), one column per side — by matching each side's
 * `RenderImage[]` up by `label` (`renderSnapshot` always returns them in
 * `DEFAULT_VIEWS` order, but matching by label rather than trusting index
 * order is cheap insurance against that ever changing). Returns `""` (no
 * section at all) when NEITHER side produced any images, so a fully
 * unavailable/unsupported comparison doesn't leave a dangling empty heading.
 */
function snapshotSection(imagesA: RenderImage[], imagesB: RenderImage[]): string {
  if (imagesA.length === 0 && imagesB.length === 0) return "";
  const byLabel = (images: RenderImage[], label: string) => images.find((i) => i.label === label);
  const labels = DEFAULT_VIEWS.map((v) => v.label);
  const cell = (img: RenderImage | undefined) =>
    img ? `<img src="data:${img.mimeType};base64,${img.dataBase64}" alt="${img.label}" />` : `<span class="md-empty">—</span>`;
  const rows = labels
    .map((label) => `<tr><td>${label}</td><td>${cell(byLabel(imagesA, label))}</td><td>${cell(byLabel(imagesB, label))}</td></tr>`)
    .join("\n");
  return `
  <h2>Visual diff</h2>
  <table class="md-snapshots">
    <thead><tr><th>View</th><th>A</th><th>B</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
`;
}

function showModelDiffPanel(
  uriA: vscode.Uri,
  uriB: vscode.Uri,
  diff: ModelDiff,
  warnings: string[] = [],
  imagesA: RenderImage[] = [],
  imagesB: RenderImage[] = []
): void {
  const panel = vscode.window.createWebviewPanel(
    "cadPreviewModelDiff",
    "Compare Models — CAD Preview",
    vscode.ViewColumn.Beside,
    { enableScripts: false, localResourceRoots: [] }
  );

  // `img-src data:` added for the visual-diff snapshots below — inline
  // base64 PNGs only (no `localResourceRoots`/webview.asWebviewUri involved,
  // consistent with `enableScripts: false` ruling out any script-driven
  // resource loading anyway).
  const csp = [`default-src 'none'`, `style-src 'unsafe-inline'`, `img-src data:`].join("; ");
  const nameA = vscode.workspace.asRelativePath(uriA);
  const nameB = vscode.workspace.asRelativePath(uriB);

  const matchedRows = diff.matched.length
    ? diff.matched.map(matchRow).join("\n")
    : `<tr><td colspan="5" class="md-empty">No matched solids.</td></tr>`;
  const removedRows = diff.removed.length ? diff.removed.map(signatureRow).join("\n") : `<tr><td colspan="3" class="md-empty">None.</td></tr>`;
  const addedRows = diff.added.length ? diff.added.map(signatureRow).join("\n") : `<tr><td colspan="3" class="md-empty">None.</td></tr>`;
  const warningsBlock = warnings.length
    ? `<div class="md-warning">${warnings.map((w) => `⚠ ${w}`).join("<br/>")}</div>`
    : "";

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
    .md-warning {
      margin-bottom: 16px;
      padding: 8px 12px;
      background: var(--vscode-inputValidation-warningBackground, #352a05);
      border-left: 3px solid var(--vscode-inputValidation-warningBorder, #b89500);
      font-size: 0.85em;
    }
    .md-snapshots td { vertical-align: top; }
    .md-snapshots img { max-width: 260px; width: 100%; height: auto; border: 1px solid var(--vscode-widget-border, #3c3c3c); border-radius: 3px; background: #1e1e1e; }
  </style>
</head>
<body>
  <h1>Compare Models</h1>
  <div class="md-files">A: <code>${nameA}</code> &nbsp;·&nbsp; B: <code>${nameB}</code></div>
  ${warningsBlock}
  <div class="md-summary">
    <div class="md-stat"><b>${diff.added.length}</b>Added</div>
    <div class="md-stat"><b>${diff.removed.length}</b>Removed</div>
    <div class="md-stat"><b>${diff.matched.length}</b>Matched</div>
  </div>
  ${snapshotSection(imagesA, imagesB)}
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
