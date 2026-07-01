import * as vscode from "vscode";
import type { EditOp } from "./editOps";
import { parseEditsJson, serializeEditsJson } from "./editsSidecar";

/** The edits sidecar URI for a model: `<model>.edits.json` beside the source. */
export function editsSidecarUri(modelUri: vscode.Uri): vscode.Uri {
  return modelUri.with({ path: `${modelUri.path}.edits.json` });
}

/** Reads + validates the edits sidecar; returns `[]` when missing or unreadable. */
export async function readEdits(modelUri: vscode.Uri): Promise<EditOp[]> {
  try {
    const bytes = await vscode.workspace.fs.readFile(editsSidecarUri(modelUri));
    return parseEditsJson(Buffer.from(bytes).toString("utf8"));
  } catch {
    return [];
  }
}

/** Writes the edits sidecar beside the model. The model file itself is never touched. */
export async function writeEdits(modelUri: vscode.Uri, ops: EditOp[]): Promise<void> {
  const sourceName = modelUri.path.slice(modelUri.path.lastIndexOf("/") + 1);
  const text = serializeEditsJson(sourceName, ops);
  await vscode.workspace.fs.writeFile(editsSidecarUri(modelUri), Buffer.from(text, "utf8"));
}
