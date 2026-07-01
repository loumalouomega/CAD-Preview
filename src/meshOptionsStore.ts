import * as vscode from "vscode";
import { DEFAULT_MESH_OPTIONS, type MeshOptions } from "./meshOptions";
import { parseMeshJson, serializeMeshJson, generateGeoScript } from "./meshOptionsSidecar";

/** The mesh options sidecar URI for a model: `<model>.mesh.json` beside the source. */
export function meshOptionsSidecarUri(modelUri: vscode.Uri): vscode.Uri {
  return modelUri.with({ path: `${modelUri.path}.mesh.json` });
}

/** Reads + validates the mesh options sidecar; returns `DEFAULT_MESH_OPTIONS` when missing or unreadable. */
export async function readMeshOptions(modelUri: vscode.Uri): Promise<MeshOptions> {
  try {
    const bytes = await vscode.workspace.fs.readFile(meshOptionsSidecarUri(modelUri));
    return parseMeshJson(Buffer.from(bytes).toString("utf8"));
  } catch {
    return DEFAULT_MESH_OPTIONS;
  }
}

/** Writes the mesh options sidecar beside the model. The model file itself is never touched. */
export async function writeMeshOptions(modelUri: vscode.Uri, options: MeshOptions): Promise<void> {
  const sourceName = modelUri.path.slice(modelUri.path.lastIndexOf("/") + 1);
  const text = serializeMeshJson(sourceName, options);
  await vscode.workspace.fs.writeFile(meshOptionsSidecarUri(modelUri), Buffer.from(text, "utf8"));
}

/** The editable `.geo` script URI for a model: `<model>.geo` beside the source. */
export function geoScriptUri(modelUri: vscode.Uri): vscode.Uri {
  return modelUri.with({ path: `${modelUri.path}.geo` });
}

/** Computes and writes the `.geo` script for the model's current mesh options. */
export async function writeGeoScript(modelUri: vscode.Uri, options: MeshOptions): Promise<void> {
  const sourceName = modelUri.path.slice(modelUri.path.lastIndexOf("/") + 1);
  const text = generateGeoScript(sourceName, options);
  await vscode.workspace.fs.writeFile(geoScriptUri(modelUri), Buffer.from(text, "utf8"));
}
