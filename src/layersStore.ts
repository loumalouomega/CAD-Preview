import * as vscode from "vscode";
import type { Layer } from "./protocol";
import { parseLayersFile, serializeLayersJson } from "./layersSidecar";
import { assertNotDirty } from "./dirtyGuard";

/** The sidecar URI for a model: `<model>.layers.json` beside the source file. */
export function layersSidecarUri(modelUri: vscode.Uri): vscode.Uri {
  return modelUri.with({ path: `${modelUri.path}.layers.json` });
}

/**
 * Reads + validates the sidecar; `{ layers: [], nextId: 0 }` when it is
 * missing or unreadable. `nextId` is the allocation counter allocation sites
 * persist back — it is what keeps a deleted id from ever being recycled.
 */
export async function readLayers(modelUri: vscode.Uri): Promise<{ layers: Layer[]; nextId: number }> {
  try {
    const bytes = await vscode.workspace.fs.readFile(layersSidecarUri(modelUri));
    return parseLayersFile(Buffer.from(bytes).toString("utf8"));
  } catch {
    return { layers: [], nextId: 0 };
  }
}

/** Writes the sidecar beside the model. The model file itself is never touched. */
export async function writeLayers(modelUri: vscode.Uri, layers: Layer[], nextId: number): Promise<void> {
  assertNotDirty(layersSidecarUri(modelUri));
  const sourceName = modelUri.path.slice(modelUri.path.lastIndexOf("/") + 1);
  const text = serializeLayersJson(sourceName, layers, nextId);
  await vscode.workspace.fs.writeFile(layersSidecarUri(modelUri), Buffer.from(text, "utf8"));
}
