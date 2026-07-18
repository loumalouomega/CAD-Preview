import * as vscode from "vscode";
import { CadPreviewProvider } from "./provider";
import { maybeShowWhatsNew } from "./whatsNew";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(CadPreviewProvider.register(context));
  void maybeShowWhatsNew(context);
}

export function deactivate(): void {
  /* nothing to clean up: per-editor resources are disposed with their webview panels */
}
