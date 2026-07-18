import * as vscode from "vscode";
import { getNonce } from "./nonce";
import { parseChangelog, compareVersions, entriesSince, renderEntryHtml, type ChangelogEntry } from "./changelogParser";

/** `context.globalState` key holding the last version this profile has seen the "What's New" check for. */
const LAST_VERSION_KEY = "cadPreview.lastVersion";

const REPO_CHANGELOG_URL = "https://github.com/loumalouomega/CAD-Preview/blob/main/CHANGELOG.md";

async function readChangelogEntries(context: vscode.ExtensionContext): Promise<ChangelogEntry[]> {
  const uri = vscode.Uri.joinPath(context.extensionUri, "CHANGELOG.md");
  const bytes = await vscode.workspace.fs.readFile(uri);
  return parseChangelog(Buffer.from(bytes).toString("utf8"));
}

/**
 * Called once per activation. Compares the extension's current version against
 * the last one this profile saw and, on an upgrade, shows the What's New panel
 * with everything that changed since then. Never throws — a failure here must
 * not block `activate()` or any other startup behavior.
 */
export async function maybeShowWhatsNew(context: vscode.ExtensionContext): Promise<void> {
  try {
    const currentVersion = (context.extension.packageJSON as { version: string }).version;
    const lastVersion = context.globalState.get<string>(LAST_VERSION_KEY);

    if (lastVersion === undefined) {
      // Fresh install: nothing to compare against yet, so stay silent this first time.
      await context.globalState.update(LAST_VERSION_KEY, currentVersion);
      return;
    }

    if (compareVersions(currentVersion, lastVersion) > 0) {
      const entries = await readChangelogEntries(context);
      const since = entriesSince(entries, lastVersion);
      // `lastVersion` predates every entry still in the file (e.g. very old install) — fall back to the latest one.
      const toShow = since.length > 0 ? since : entries.slice(0, 1);
      if (toShow.length > 0) {
        showWhatsNewPanel(context, currentVersion, toShow);
      }
    }

    await context.globalState.update(LAST_VERSION_KEY, currentVersion);
  } catch {
    // CHANGELOG.md missing/unreadable, or any other unexpected failure — never block activation over this.
  }
}

/** Manual "CAD Preview: Show What's New" command — shows the full changelog, not just what's new since last seen. */
export async function showLatestWhatsNew(context: vscode.ExtensionContext): Promise<void> {
  try {
    const currentVersion = (context.extension.packageJSON as { version: string }).version;
    const entries = await readChangelogEntries(context);
    showWhatsNewPanel(context, currentVersion, entries);
  } catch (err) {
    void vscode.window.showErrorMessage(`Couldn't load CHANGELOG.md: ${(err as Error).message}`);
  }
}

export function showWhatsNewPanel(
  context: vscode.ExtensionContext,
  version: string,
  entries: readonly ChangelogEntry[]
): void {
  const panel = vscode.window.createWebviewPanel(
    "cadPreviewWhatsNew",
    "What's New in CAD Preview",
    vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: [] }
  );

  const nonce = getNonce();
  const csp = [`default-src 'none'`, `style-src 'unsafe-inline'`, `script-src 'nonce-${nonce}'`].join("; ");
  const body = entries.map((e) => `<section class="wn-entry">${renderEntryHtml(e)}</section>`).join("\n");

  panel.webview.html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>What's New in CAD Preview</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 0 24px 24px;
      max-width: 720px;
      margin: 0 auto;
    }
    h1 { font-weight: 600; }
    h3 { margin-bottom: 4px; }
    .wn-date { font-weight: normal; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    h4 { margin: 12px 0 4px; color: var(--vscode-descriptionForeground); }
    ul { margin: 4px 0; padding-left: 20px; }
    li { margin: 2px 0; }
    code {
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .wn-entry { border-bottom: 1px solid var(--vscode-widget-border, transparent); padding-bottom: 12px; margin-bottom: 12px; }
    .wn-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; }
    a { color: var(--vscode-textLink-foreground); }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 16px;
      border-radius: 2px;
      cursor: pointer;
      font-size: 1em;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <h1>What's New in CAD Preview ${version}</h1>
  ${body}
  <div class="wn-footer">
    <a href="${REPO_CHANGELOG_URL}">View full changelog on GitHub</a>
    <button id="wn-dismiss">Got it</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById("wn-dismiss").addEventListener("click", () => {
      vscode.postMessage({ type: "dismiss" });
    });
  </script>
</body>
</html>`;

  panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
    if (msg?.type === "dismiss") panel.dispose();
  });
}
