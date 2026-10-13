import * as vscode from "vscode";
import { assertNotDirty } from "./dirtyGuard";
import { parseScadOverridesJson, serializeScadOverridesJson } from "./scadOverridesSidecar";
import type { ScadValue } from "./scadParams";

/** The sidecar URI for a model: `<model>.scad-params.json` beside the source file. */
export function scadOverridesSidecarUri(modelUri: vscode.Uri): vscode.Uri {
  return modelUri.with({ path: `${modelUri.path}.scad-params.json` });
}

/** Reads + validates the sidecar; returns `{}` when it is missing or unreadable. */
export async function readScadOverrides(modelUri: vscode.Uri): Promise<Record<string, ScadValue>> {
  try {
    const bytes = await vscode.workspace.fs.readFile(scadOverridesSidecarUri(modelUri));
    return parseScadOverridesJson(Buffer.from(bytes).toString("utf8"));
  } catch {
    return {};
  }
}

/** Writes the sidecar beside the model. The model file itself is never touched. */
export async function writeScadOverrides(modelUri: vscode.Uri, overrides: Record<string, ScadValue>): Promise<void> {
  assertNotDirty(scadOverridesSidecarUri(modelUri));
  const sourceName = modelUri.path.slice(modelUri.path.lastIndexOf("/") + 1);
  const text = serializeScadOverridesJson(sourceName, overrides);
  await vscode.workspace.fs.writeFile(scadOverridesSidecarUri(modelUri), Buffer.from(text, "utf8"));
}
