import * as vscode from "vscode";
import { CadPreviewProvider } from "./provider";
import { registerModelsView } from "./modelsView";
import { maybeShowWhatsNew } from "./whatsNew";
import { disconnectSpaceMouse } from "./spaceMouse";
import type { HostToWebview } from "./protocol";

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
}

export function activate(context: vscode.ExtensionContext): CadPreviewTestApi | undefined {
  context.subscriptions.push(CadPreviewProvider.register(context));
  registerModelsView(context, CadPreviewProvider.viewType);
  void maybeShowWhatsNew(context);
  return context.extensionMode === vscode.ExtensionMode.Test
    ? { onDidPostMessage: CadPreviewProvider.onDidPostMessage }
    : undefined;
}

export function deactivate(): void {
  // Per-editor resources are disposed with their webview panels; the one
  // global is the SpaceMouse reader (roadmap Tier 2 item 2) — release the
  // device and stop its reconnect timer so the host exits cleanly.
  disconnectSpaceMouse();
}
