import * as vscode from "vscode";
import type { EditOp } from "./editOps";
import type { ParamVariable } from "./editVariables";
import { parseEditsJson, serializeEditsJson, type ParsedEdits } from "./editsSidecar";
import { assertNotDirty } from "./dirtyGuard";

/** The edits sidecar URI for a model: `<model>.edits.json` beside the source. */
export function editsSidecarUri(modelUri: vscode.Uri): vscode.Uri {
  return modelUri.with({ path: `${modelUri.path}.edits.json` });
}

/** Reads + validates the edits sidecar; returns empty lists when missing or unreadable. */
export async function readEdits(modelUri: vscode.Uri): Promise<ParsedEdits> {
  try {
    const bytes = await vscode.workspace.fs.readFile(editsSidecarUri(modelUri));
    return parseEditsJson(Buffer.from(bytes).toString("utf8"));
  } catch {
    return { ops: [], variables: [] };
  }
}

/** Writes the edits sidecar beside the model. The model file itself is never touched. */
export async function writeEdits(modelUri: vscode.Uri, ops: EditOp[], variables: ParamVariable[]): Promise<void> {
  assertNotDirty(editsSidecarUri(modelUri));
  const sourceName = modelUri.path.slice(modelUri.path.lastIndexOf("/") + 1);
  const text = serializeEditsJson(sourceName, ops, variables);
  await vscode.workspace.fs.writeFile(editsSidecarUri(modelUri), Buffer.from(text, "utf8"));
}
