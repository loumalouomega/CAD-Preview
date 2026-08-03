import * as vscode from "vscode";
import type { ViewState } from "./protocol";
import { parseViewStateJson, serializeViewStateJson } from "./viewStateSidecar";

/** The sidecar URI for a model: `<model>.view.json` beside the source file. */
export function viewStateSidecarUri(modelUri: vscode.Uri): vscode.Uri {
  return modelUri.with({ path: `${modelUri.path}.view.json` });
}

/** Reads + validates the sidecar; returns `null` when it is missing, unreadable, or malformed. */
export async function readViewState(modelUri: vscode.Uri): Promise<ViewState | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(viewStateSidecarUri(modelUri));
    return parseViewStateJson(Buffer.from(bytes).toString("utf8"));
  } catch {
    return null;
  }
}

/** Writes the sidecar beside the model. The model file itself is never touched. */
export async function writeViewState(modelUri: vscode.Uri, view: ViewState): Promise<void> {
  const sourceName = modelUri.path.slice(modelUri.path.lastIndexOf("/") + 1);
  const text = serializeViewStateJson(sourceName, view);
  await vscode.workspace.fs.writeFile(viewStateSidecarUri(modelUri), Buffer.from(text, "utf8"));
}
