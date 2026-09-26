/**
 * Node-fs sidecar store for the MCP server — the headless counterpart of
 * `editsStore.ts` / `partsStore.ts` / `meshOptionsStore.ts` (which wrap the
 * same pure parsers in `vscode.workspace.fs`). Must stay byte-compatible with
 * what `provider.ts` reads on reopen: same `<model>.edits.json` /
 * `.parts.json` / `.planes.json` / `.mesh.json` / `.geo` filenames, same tolerant-read
 * defaults, same one-way `.geo` regeneration on every options write.
 */
import { bundledSheetTemplatesPath, parseSheetTemplatesJson, serializeSheetTemplatesJson, type SheetTemplateLibrary } from "./sheetTemplates";
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
import { bundledMacrosPath } from "./starterMacros";
import {
  bundledMeshPresetsPath,
  parseMeshPresetsJson,
  serializeMeshPresetsJson,
  type MeshPresetLibrary,
} from "./meshPresets";
import { parseViewStateJson } from "./viewStateSidecar";
import { saveJournalFileName } from "./saveJournal";
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

/**
 * The save-transaction journal's path — a SIBLING of the source, from
 * `saveJournal.ts`'s single name derivation.
 *
 * Deliberately NOT one of the six sidecars: it is per-save transaction state,
 * not per-document state, so `list_workspace_models` does not report it as a
 * companion and `save_preprocess` does not archive it. Its presence is
 * reported by `load_model` when recovery acts on it, which is the only thing
 * that needs to know about it.
 */
export function saveJournalPath(modelPath: string): string {
  return path.join(path.dirname(modelPath), saveJournalFileName(path.basename(modelPath)));
}

/** Reads + validates the edits sidecar; returns empty lists when missing or unreadable. */
export async function readEdits(modelPath: string): Promise<ParsedEdits> {
  try {
    const text = await fs.readFile(editsSidecarPath(modelPath), "utf8");
    return parseEditsJson(text);
  } catch {
    return { ops: [], variables: [], bakedThrough: 0 };
  }
}

/** Writes the edits sidecar beside the model. The model file itself is never touched. */
export async function writeEdits(modelPath: string, ops: EditOp[], variables: ParamVariable[], bakedThrough = 0): Promise<void> {
  const text = serializeEditsJson(path.basename(modelPath), ops, variables, bakedThrough);
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
 * The read-only bundled starter library (roadmap Tier 1 "A bundled starter
 * macro library") — `dist/macros/starter-library.json` beside the bundle
 * (copied there by `esbuild.mjs`'s `copyMacros()`). Missing/unreadable/
 * corrupt yields an empty library, same bare-catch convention as
 * `readScriptLibrary` above — a broken bundle must degrade to "no starters",
 * never fail a list/run call.
 */
export async function readBundledScriptLibrary(extensionPath: string): Promise<ScriptLibrary> {
  try {
    const text = await fs.readFile(bundledMacrosPath(extensionPath), "utf8");
    return parseScriptLibraryJson(text);
  } catch {
    return {};
  }
}

/**
 * The mesh-preset library at a caller-named path (roadmap Tier 1 "Reusable
 * meshing presets") — the `readScriptLibrary` shape exactly: a preset is
 * reusable by definition, so it lives in an explicit caller-named file, not a
 * hidden per-workspace convention. Missing/unreadable/corrupt yields an empty
 * library, same bare-catch convention.
 */
export async function readMeshPresetLibrary(libraryPath: string): Promise<MeshPresetLibrary> {
  try {
    const text = await fs.readFile(libraryPath, "utf8");
    return parseMeshPresetsJson(text);
  } catch {
    return {};
  }
}

export async function writeMeshPresetLibrary(libraryPath: string, library: MeshPresetLibrary): Promise<void> {
  await fs.writeFile(libraryPath, serializeMeshPresetsJson(library), "utf8");
}

/** The caller-named drawing-sheet template library (missing/corrupt → empty). */
export async function readSheetTemplateLibrary(libraryPath: string): Promise<SheetTemplateLibrary> {
  try {
    return parseSheetTemplatesJson(await fs.readFile(libraryPath, "utf8"));
  } catch {
    return {};
  }
}

export async function writeSheetTemplateLibrary(libraryPath: string, library: SheetTemplateLibrary): Promise<void> {
  await fs.writeFile(libraryPath, serializeSheetTemplatesJson(library), "utf8");
}

/** The read-only bundled sheet templates (`dist/sheet-templates/…`). */
export async function readBundledSheetTemplateLibrary(extensionPath: string): Promise<SheetTemplateLibrary> {
  try {
    return parseSheetTemplatesJson(await fs.readFile(bundledSheetTemplatesPath(extensionPath), "utf8"));
  } catch {
    return {};
  }
}

/**
 * The read-only bundled starter presets — `dist/mesh-presets/
 * starter-presets.json` beside the bundle (copied there by `esbuild.mjs`'s
 * `copyMeshPresets()`). Missing/unreadable/corrupt yields an empty library —
 * a broken bundle degrades to "no starters", never fails a list/apply call.
 */
export async function readBundledMeshPresetLibrary(extensionPath: string): Promise<MeshPresetLibrary> {
  try {
    const text = await fs.readFile(bundledMeshPresetsPath(extensionPath), "utf8");
    return parseMeshPresetsJson(text);
  } catch {
    return {};
  }
}

/**
 * Project invariant: the CAD source file is never written except by the
 * explicit opt-in `save_model` tool (which takes no output path at all).
 * Every other tool that takes a caller-chosen output path must run it
 * through this guard first.
 */
export function assertNotSourcePath(modelPath: string, outPath: string): void {
  if (path.resolve(modelPath) === path.resolve(outPath)) {
    throw new Error(`Refusing to overwrite the CAD source file: ${modelPath}`);
  }
}
