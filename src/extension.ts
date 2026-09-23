import * as vscode from "vscode";
import { CadPreviewProvider } from "./provider";
import { registerModelsView } from "./modelsView";
import { maybeShowWhatsNew } from "./whatsNew";
import { disconnectSpaceMouse } from "./spaceMouse";
import { setTestSheetFormAnswer } from "./drawingSheetForm";
import type { HostToWebview, WebviewToHost } from "./protocol";

/**
 * What `activate()` returns to `vscode.extensions.getExtension(id).exports`,
 * and ONLY under `ExtensionMode.Test`.
 *
 * The integration suite (`test/integration/`) can drive VS Code's modal UI by
 * stubbing `vscode.window.*` and can observe anything that writes a file, but
 * `provider.ts`'s six external-change watchers reconcile purely by posting to
 * the webview — no return value, no disk write, fire-and-forget. This is the
 * one seam that makes them observable. It is not a public API: in normal use
 * `activate()` returns `undefined` exactly as before.
 */
export interface CadPreviewTestApi {
  onDidPostMessage: vscode.Event<HostToWebview>;
  /** Runs the real `saveCustomDocument` join (sidecar flush + tail bake). */
  saveDocument: (uri: vscode.Uri) => Promise<void>;
  /** Runs the real `revertCustomDocument` join (drop to the save point). */
  revertDocument: (uri: vscode.Uri) => Promise<void>;
  /** Fires the dirty event exactly like a webview `editsChanged` post would. */
  markDirtyDocument: (uri: vscode.Uri) => void;
  /** Delivers a message to the document's real webview-message handler. */
  simulateWebviewMessage: (uri: vscode.Uri, msg: WebviewToHost) => Promise<void>;
  /** Runs the real `saveCustomDocumentAs` copy join for an open document. */
  saveDocumentAs: (uri: vscode.Uri, destination: vscode.Uri) => Promise<void>;
  /**
   * Installs (or clears, with `undefined`) the `testExportMeshStub` the mesh
   * save-in-place path consults instead of the webview round trip — see its
   * doc comment in `provider.ts`.
   */
  setExportMeshStub: (stub: ((format: string) => Uint8Array | undefined) | undefined) => void;
  /** Answers the Export Drawing Sheet form without showing it (undefined restores the real form). */
  setSheetFormAnswer: (answer: ((opts: unknown) => Promise<unknown>) | undefined) => void;
}

export function activate(context: vscode.ExtensionContext): CadPreviewTestApi | undefined {
  context.subscriptions.push(CadPreviewProvider.register(context));
  registerModelsView(context, CadPreviewProvider.viewType);
  void maybeShowWhatsNew(context);
  return context.extensionMode === vscode.ExtensionMode.Test
    ? {
        onDidPostMessage: CadPreviewProvider.onDidPostMessage,
        saveDocument: (uri: vscode.Uri) => CadPreviewProvider.testSaveDocument(uri),
        revertDocument: (uri: vscode.Uri) => CadPreviewProvider.testRevertDocument(uri),
        markDirtyDocument: (uri: vscode.Uri) => CadPreviewProvider.markDirtyDocument(uri),
        simulateWebviewMessage: (uri: vscode.Uri, msg: WebviewToHost) => CadPreviewProvider.simulateWebviewMessage(uri, msg),
        saveDocumentAs: (uri: vscode.Uri, destination: vscode.Uri) =>
          CadPreviewProvider.testSaveDocumentAs(uri, destination),
        setExportMeshStub: (stub) => {
          CadPreviewProvider.testExportMeshStub = stub;
        },
        setSheetFormAnswer: (answer) => setTestSheetFormAnswer(answer as Parameters<typeof setTestSheetFormAnswer>[0]),
      }
    : undefined;
}

export function deactivate(): void {
  // Per-editor resources are disposed with their webview panels; the one
  // global is the SpaceMouse reader — release the
  // device and stop its reconnect timer so the host exits cleanly.
  disconnectSpaceMouse();
}
