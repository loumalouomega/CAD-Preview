import * as vscode from "vscode";
import type { Annotation } from "./protocol";
import { parseAnnotationsJson, serializeAnnotationsJson } from "./annotationsSidecar";
import { assertNotDirty } from "./dirtyGuard";

/** The sidecar URI for a model: `<model>.annotations.json` beside the source file. */
export function annotationsSidecarUri(modelUri: vscode.Uri): vscode.Uri {
  return modelUri.with({ path: `${modelUri.path}.annotations.json` });
}

/** Reads + validates the sidecar; returns `[]` when it is missing or unreadable. */
export async function readAnnotations(modelUri: vscode.Uri): Promise<Annotation[]> {
  try {
    const bytes = await vscode.workspace.fs.readFile(annotationsSidecarUri(modelUri));
    return parseAnnotationsJson(Buffer.from(bytes).toString("utf8"));
  } catch {
    return [];
  }
}

/** Writes the sidecar beside the model. The model file itself is never touched. */
export async function writeAnnotations(modelUri: vscode.Uri, annotations: Annotation[]): Promise<void> {
  assertNotDirty(annotationsSidecarUri(modelUri));
  const sourceName = modelUri.path.slice(modelUri.path.lastIndexOf("/") + 1);
  const text = serializeAnnotationsJson(sourceName, annotations);
  await vscode.workspace.fs.writeFile(annotationsSidecarUri(modelUri), Buffer.from(text, "utf8"));
}
