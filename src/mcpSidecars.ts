/**
 * Node-fs sidecar store for the MCP server — the headless counterpart of
 * `editsStore.ts` / `partsStore.ts` / `meshOptionsStore.ts` (which wrap the
 * same pure parsers in `vscode.workspace.fs`). Must stay byte-compatible with
 * what `provider.ts` reads on reopen: same `<model>.edits.json` /
 * `.parts.json` / `.mesh.json` / `.geo` filenames, same tolerant-read
 * defaults, same one-way `.geo` regeneration on every options write.
 */
import * as fs from "fs/promises";
import * as path from "path";
import type { EditOp } from "./editOps";
import type { ParamVariable } from "./editVariables";
import { parseEditsJson, serializeEditsJson, type ParsedEdits } from "./editsSidecar";
import type { Annotation, Part } from "./protocol";
import { parsePartsJson, serializePartsJson } from "./partsSidecar";
import { parseAnnotationsJson, serializeAnnotationsJson } from "./annotationsSidecar";
import { DEFAULT_MESH_OPTIONS, type MeshOptions } from "./meshOptions";
import { parseMeshJson, serializeMeshJson, generateGeoScript } from "./meshOptionsSidecar";

export function editsSidecarPath(modelPath: string): string {
  return `${modelPath}.edits.json`;
}

export function partsSidecarPath(modelPath: string): string {
  return `${modelPath}.parts.json`;
}

export function annotationsSidecarPath(modelPath: string): string {
  return `${modelPath}.annotations.json`;
}

export function meshOptionsSidecarPath(modelPath: string): string {
  return `${modelPath}.mesh.json`;
}

export function geoScriptPath(modelPath: string): string {
  return `${modelPath}.geo`;
}

/** `<model>.view.json` — the display-only camera/display-mode sidecar
 * (`viewStateStore.ts` on the extension side). Read-only over MCP (no tool
 * writes it); declared here so every companion filename has ONE derivation
 * point — `list_workspace_models`' presence set reads from here rather than
 * hand-concatenating a sixth string that could drift. */
export function viewStateSidecarPath(modelPath: string): string {
  return `${modelPath}.view.json`;
}

/** Reads + validates the edits sidecar; returns empty lists when missing or unreadable. */
export async function readEdits(modelPath: string): Promise<ParsedEdits> {
  try {
    const text = await fs.readFile(editsSidecarPath(modelPath), "utf8");
    return parseEditsJson(text);
  } catch {
    return { ops: [], variables: [] };
  }
}

/** Writes the edits sidecar beside the model. The model file itself is never touched. */
export async function writeEdits(modelPath: string, ops: EditOp[], variables: ParamVariable[]): Promise<void> {
  const text = serializeEditsJson(path.basename(modelPath), ops, variables);
  await fs.writeFile(editsSidecarPath(modelPath), text, "utf8");
}

/** Reads + validates the parts sidecar; returns `[]` when missing or unreadable. */
export async function readParts(modelPath: string): Promise<Part[]> {
  try {
    const text = await fs.readFile(partsSidecarPath(modelPath), "utf8");
    return parsePartsJson(text);
  } catch {
    return [];
  }
}

/** Writes the parts sidecar beside the model. The model file itself is never touched. */
export async function writeParts(modelPath: string, parts: Part[]): Promise<void> {
  const text = serializePartsJson(path.basename(modelPath), parts);
  await fs.writeFile(partsSidecarPath(modelPath), text, "utf8");
}

/** Reads + validates the annotations sidecar; returns `[]` when missing or unreadable. */
export async function readAnnotations(modelPath: string): Promise<Annotation[]> {
  try {
    const text = await fs.readFile(annotationsSidecarPath(modelPath), "utf8");
    return parseAnnotationsJson(text);
  } catch {
    return [];
  }
}

/** Writes the annotations sidecar beside the model. The model file itself is never touched. */
export async function writeAnnotations(modelPath: string, annotations: Annotation[]): Promise<void> {
  const text = serializeAnnotationsJson(path.basename(modelPath), annotations);
  await fs.writeFile(annotationsSidecarPath(modelPath), text, "utf8");
}

/** Reads + validates the mesh options sidecar; returns `DEFAULT_MESH_OPTIONS` when missing or unreadable. */
export async function readMeshOptions(modelPath: string): Promise<MeshOptions> {
  try {
    const text = await fs.readFile(meshOptionsSidecarPath(modelPath), "utf8");
    return parseMeshJson(text);
  } catch {
    return DEFAULT_MESH_OPTIONS;
  }
}

/** Writes the mesh options sidecar AND regenerates the one-way `.geo` script beside it. */
export async function writeMeshOptions(modelPath: string, options: MeshOptions): Promise<void> {
  const sourceName = path.basename(modelPath);
  await fs.writeFile(meshOptionsSidecarPath(modelPath), serializeMeshJson(sourceName, options), "utf8");
  await fs.writeFile(geoScriptPath(modelPath), generateGeoScript(sourceName, options), "utf8");
}

/**
 * Project invariant: the CAD source file is never written. Every tool that
 * takes a caller-chosen output path must run it through this guard first.
 */
export function assertNotSourcePath(modelPath: string, outPath: string): void {
  if (path.resolve(modelPath) === path.resolve(outPath)) {
    throw new Error(`Refusing to overwrite the CAD source file: ${modelPath}`);
  }
}
