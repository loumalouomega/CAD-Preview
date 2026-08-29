import * as vscode from "vscode";
import type { ConstructionPlane } from "./protocol";
import { parsePlanesJson, serializePlanesJson } from "./planesSidecar";
import { assertNotDirty } from "./dirtyGuard";

/** The sidecar URI for a model: `<model>.planes.json` beside the source file. */
export function planesSidecarUri(modelUri: vscode.Uri): vscode.Uri {
  return modelUri.with({ path: `${modelUri.path}.planes.json` });
}

/** Reads + validates the sidecar; returns `[]` when it is missing or unreadable. */
export async function readPlanes(modelUri: vscode.Uri): Promise<ConstructionPlane[]> {
  try {
    const bytes = await vscode.workspace.fs.readFile(planesSidecarUri(modelUri));
    return parsePlanesJson(Buffer.from(bytes).toString("utf8"));
  } catch {
    return [];
  }
}

/** Writes the sidecar beside the model. The model file itself is never touched. */
export async function writePlanes(modelUri: vscode.Uri, planes: ConstructionPlane[]): Promise<void> {
  assertNotDirty(planesSidecarUri(modelUri));
  const sourceName = modelUri.path.slice(modelUri.path.lastIndexOf("/") + 1);
  const text = serializePlanesJson(sourceName, planes);
  await vscode.workspace.fs.writeFile(planesSidecarUri(modelUri), Buffer.from(text, "utf8"));
}
