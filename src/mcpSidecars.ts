/**
 * Node-fs sidecar store for the MCP server — the headless counterpart of
 * `editsStore.ts` / `partsStore.ts` / `meshOptionsStore.ts` (which wrap the
 * same pure parsers in `vscode.workspace.fs`). Must stay byte-compatible with
 * what `provider.ts` reads on reopen: same `<model>.edits.json` /
 * `.parts.json` / `.planes.json` / `.mesh.json` / `.geo` filenames, same tolerant-read
 * defaults, same one-way `.geo` regeneration on every options write.
 */
import * as fs from "fs/promises";
import * as path from "path";
import type { EditOp } from "./editOps";
import type { ParamVariable } from "./editVariables";
import { parseEditsJson, serializeEditsJson, type ParsedEdits } from "./editsSidecar";
import type { Annotation, ConstructionPlane, Part } from "./protocol";
import { parsePartsJson, serializePartsJson } from "./partsSidecar";
import { parseAnnotationsJson, serializeAnnotationsJson } from "./annotationsSidecar";
import { parsePlanesJson, serializePlanesJson } from "./planesSidecar";
import { DEFAULT_MESH_OPTIONS, type MeshOptions } from "./meshOptions";
import { parseMeshJson, serializeMeshJson, generateGeoScript } from "./meshOptionsSidecar";
import { parseScriptLibraryJson, serializeScriptLibraryJson, type ScriptLibrary } from "./scriptLibrary";
import { parseViewStateJson } from "./viewStateSidecar";
import type { ViewState } from "./protocol";

export function editsSidecarPath(modelPath: string): string {
  return `${modelPath}.edits.json`;
}

export function partsSidecarPath(modelPath: string): string {
  return `${modelPath}.parts.json`;
}

export function annotationsSidecarPath(modelPath: string): string {
  return `${modelPath}.annotations.json`;
}

export function planesSidecarPath(modelPath: string): string {
  return `${modelPath}.planes.json`;
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

/** Reads + validates the construction-planes sidecar; returns `[]` when missing or unreadable. */
export async function readPlanes(modelPath: string): Promise<ConstructionPlane[]> {
  try {
    const text = await fs.readFile(planesSidecarPath(modelPath), "utf8");
    return parsePlanesJson(text);
  } catch {
    return [];
  }
}

/** Writes the construction-planes sidecar beside the model. The model file itself is never touched. */
export async function writePlanes(modelPath: string, planes: ConstructionPlane[]): Promise<void> {
  const text = serializePlanesJson(path.basename(modelPath), planes);
  await fs.writeFile(planesSidecarPath(modelPath), text, "utf8");
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
 * The persisted view state, or `null` when there is none.
 *
 * Read-only: the MCP server never writes view state (it is a display
 * preference with no headless meaning), but `render_snapshot`'s `current` /
 * `orbit-from-current` views need the orientation the user left the viewer in.
 */
export async function readViewState(modelPath: string): Promise<ViewState | null> {
  try {
    const text = await fs.readFile(viewStateSidecarPath(modelPath), "utf8");
    return parseViewStateJson(text);
  } catch {
    return null;
  }
}

/**
 * The script (macro) library at a caller-named path.
 *
 * Unlike every other function here, this takes the library file's OWN path
 * rather than deriving it from a model path — a macro is not tied to one CAD
 * document the way `.edits.json` is, and the MCP server has no workspace root
 * to hide it in. Missing/unreadable/corrupt yields an empty library, same
 * bare-catch convention as every read above.
 */
export async function readScriptLibrary(libraryPath: string): Promise<ScriptLibrary> {
  try {
    const text = await fs.readFile(libraryPath, "utf8");
    return parseScriptLibraryJson(text);
  } catch {
    return {};
  }
}

export async function writeScriptLibrary(libraryPath: string, library: ScriptLibrary): Promise<void> {
  await fs.writeFile(libraryPath, serializeScriptLibraryJson(library), "utf8");
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
