import * as vscode from "vscode";
import { CadPreviewProvider } from "./provider";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(CadPreviewProvider.register(context));
}

export function deactivate(): void {
  /* nothing to clean up: per-editor resources are disposed with their webview panels */
}
