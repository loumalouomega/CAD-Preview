import * as vscode from "vscode";
import type { Part } from "./protocol";
import { parsePartsJson, serializePartsJson } from "./partsSidecar";

/** The sidecar URI for a model: `<model>.parts.json` beside the source file. */
export function sidecarUri(modelUri: vscode.Uri): vscode.Uri {
  return modelUri.with({ path: `${modelUri.path}.parts.json` });
}

/** Reads + validates the sidecar; returns `[]` when it is missing or unreadable. */
export async function readParts(modelUri: vscode.Uri): Promise<Part[]> {
  try {
    const bytes = await vscode.workspace.fs.readFile(sidecarUri(modelUri));
    return parsePartsJson(Buffer.from(bytes).toString("utf8"));
  } catch {
    return [];
  }
}

/** Writes the sidecar beside the model. The model file itself is never touched. */
export async function writeParts(modelUri: vscode.Uri, parts: Part[]): Promise<void> {
  const sourceName = modelUri.path.slice(modelUri.path.lastIndexOf("/") + 1);
  const text = serializePartsJson(sourceName, parts);
  await vscode.workspace.fs.writeFile(sidecarUri(modelUri), Buffer.from(text, "utf8"));
}
