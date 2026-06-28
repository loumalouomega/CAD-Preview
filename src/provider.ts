import * as vscode from "vscode";
import { routeFile } from "./fileRouter";
import type { HostToWebview, WebviewToHost } from "./protocol";

/** Read-only custom document: previews hold no editable state beyond their URI. */
class CadDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {
    /* no resources to release */
  }
}

/**
 * Renders supported CAD/mesh files in a Three.js webview.
 *
 * For mesh formats the file is exposed to the webview via `asWebviewUri` and parsed
 * there by a native Three.js loader. (B-rep formats will be tessellated in the host
 * and sent as geometry buffers in a later milestone.)
 */
export class CadPreviewProvider implements vscode.CustomReadonlyEditorProvider<CadDocument> {
  public static readonly viewType = "cad-preview.mesh";

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      CadPreviewProvider.viewType,
      new CadPreviewProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  openCustomDocument(uri: vscode.Uri): CadDocument {
    return new CadDocument(uri);
  }

  async resolveCustomEditor(
    document: CadDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const route = routeFile(document.uri.fsPath);

    const fileDir = vscode.Uri.joinPath(document.uri, "..");
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri, fileDir],
    };

    const post = (msg: HostToWebview) => webviewPanel.webview.postMessage(msg);

    webviewPanel.webview.onDidReceiveMessage((msg: WebviewToHost) => {
      if (msg.type === "ready") {
        if (!route) {
          post({ type: "error", message: `Unsupported file type: ${document.uri.fsPath}` });
          return;
        }
        if (route.strategy === "three") {
          const url = webviewPanel.webview.asWebviewUri(document.uri).toString();
          post({ type: "loadUrl", url, format: route.format });
        } else {
          // OCCT pipeline lands in a later milestone.
          post({
            type: "error",
            message: `${route.format.toUpperCase()} preview is not implemented yet.`,
          });
        }
      }
    });

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const viewerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "viewer.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "viewer.css")
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `connect-src ${webview.cspSource} blob: data:`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>CAD Preview</title>
</head>
<body>
  <div id="app"></div>
  <div id="toolbar">
    <button id="fit" title="Fit to view">Fit</button>
    <button id="wireframe" title="Toggle wireframe">Wireframe</button>
    <button id="grid" title="Toggle grid">Grid</button>
  </div>
  <div id="status">Loading…</div>
  <script nonce="${nonce}" src="${viewerUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
