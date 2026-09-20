/**
 * Reusable meshing presets (roadmap Tier 1 "Reusable meshing presets",
 * closed) — named, shareable `MeshOptions` bundles with explicit units and a
 * pinned engine.
 *
 * Pure (no vscode, no node fs, no WASM), mirroring `scriptLibrary.ts`'s
 * parse/serialize split: `mcpSidecars.ts` adds the node-fs I/O (exactly as it
 * does for the macro library), and `provider.ts` reads the folder-level user
 * file through `vscode.workspace.fs`.
 *
 * **Scope, per the roadmap item.** A preset covers GLOBAL options only — the
 * flat `MeshOptions` bag. Part-specific sizing (`Part.meshSize`/
 * `Part.meshGrading`) and entity assignments stay in the document's own
 * sidecars; applying a preset never touches them. Applying a preset changes
 * settings only — it never generates a mesh and never saves a source file.
 *
 * **Units.** A preset stores the unit its sizes were authored in (`unit`) plus
 * the raw as-authored `options`. `effectivePresetOptions` converts the sizes
 * into mm-native `MeshOptions` (what every consumer stores) via the same
 * `unitScaleFactor` the Export flow uses — so "Size max 0.1 in" reads as
 * inches when listed and applies as 2.54 mm. `SIZE_MAX_SENTINEL` is never
 * converted (a flag, not a value — the `scaleMeshOptionsForUnit` precedent).
 *
 * **Engine.** A preset pins an engine (`engine`, default `"gmsh"`). Applying
 * it sets the document's engine too. Fields the pinned engine ignores are
 * REPORTED (`inapplicablePresetFields`), never stripped — the FE Mesh panel's
 * own greyed-not-hidden idiom (`meshingPanel.ts`'s per-engine `disabled`
 * flags), so a preset whose `elementOrder: 2` runs under fTetWild says so
 * plainly instead of silently doing nothing with the field.
 */

import {
  DEFAULT_MESH_OPTIONS,
  SIZE_MAX_SENTINEL,
  validateMeshOptions,
  type MeshEngine,
  type MeshOptions,
} from "./meshOptions";
import { DISPLAY_UNITS, unitScaleFactor, type DisplayUnit } from "./lengthUnits";

export const MESH_PRESET_LIBRARY_VERSION = 1;

/** Basename of the bundled preset library, both in `mesh-presets/` and in `dist/mesh-presets/`. */
export const BUNDLED_MESH_PRESETS_FILE = "starter-presets.json";

/**
 * Absolute path of the bundled library for a given extension root — the same
 * `<extensionPath>/dist/...` convention the WASM binaries and the macro
 * starters use, so the MCP server and the extension host resolve identically.
 */
export function bundledMeshPresetsPath(extensionPath: string): string {
  return `${extensionPath}/dist/mesh-presets/${BUNDLED_MESH_PRESETS_FILE}`;
}

/** One reusable meshing preset. */
export interface MeshPreset {
  /** Unique within the library; the key callers apply it by. */
  name: string;
  description?: string;
  /** The unit `options`' sizes were authored in — converted on apply. */
  unit: DisplayUnit;
  /** The engine this preset targets; applying sets the document's engine too. */
  engine: MeshEngine;
  /**
   * The as-authored options. Validated tolerantly on parse
   * (`validateMeshOptions`' per-field fallback); the mm-native effective
   * options are derived by `effectivePresetOptions`, never stored here.
   */
  options: MeshOptions;
}

/** A preset library: entries keyed by name. */
export type MeshPresetLibrary = Record<string, MeshPreset>;

interface MeshPresetLibraryFile {
  version: number;
  presets: Record<string, unknown>;
}

/** Guards against a pathological file; a preset library is small by nature. */
const MAX_PRESETS = 200;
const MAX_NAME_LENGTH = 120;

/**
 * Tolerant: unknown or malformed entries are dropped rather than throwing, so
 * a hand-edited or partially-corrupt library never blocks the entries that
 * are still fine. Same discipline as every other sidecar parser in this
 * codebase.
 */
export function parseMeshPresetsJson(text: string): MeshPresetLibrary {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  const raw = (data as Partial<MeshPresetLibraryFile> | null)?.presets;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out: MeshPresetLibrary = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_PRESETS) break;
    const entry = validatePresetEntry(key, value);
    if (entry) out[entry.name] = entry;
  }
  return out;
}

/**
 * One entry, or `null` if it cannot be trusted.
 *
 * The entry's own `name` field wins over its object key when both are present
 * and valid (the `scriptLibrary.ts` precedent) — the key is a convenience
 * index, the field is the record. An unknown `unit`/`engine` falls back to
 * `"mm"`/`"gmsh"` (the `validateMeshOptions` per-field-fallback precedent,
 * not a drop — the entry is still fully usable); only a missing/non-object
 * `options` drops the entry, since options are the whole point of a preset.
 */
function validatePresetEntry(key: string, value: unknown): MeshPreset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : key.trim();
  if (name === "" || name.length > MAX_NAME_LENGTH) return null;

  if (!raw.options || typeof raw.options !== "object" || Array.isArray(raw.options)) return null;
  const options = validateMeshOptions(raw.options);
  if (!options) return null;

  const unit: DisplayUnit =
    typeof raw.unit === "string" && (DISPLAY_UNITS as readonly string[]).includes(raw.unit)
      ? (raw.unit as DisplayUnit)
      : "mm";
  const engine: MeshEngine = raw.engine === "ftetwild" ? "ftetwild" : "gmsh";

  const entry: MeshPreset = { name, unit, engine, options };
  if (typeof raw.description === "string") entry.description = raw.description;
  return entry;
}

export function serializeMeshPresetsJson(library: MeshPresetLibrary): string {
  const file: MeshPresetLibraryFile = { version: MESH_PRESET_LIBRARY_VERSION, presets: library };
  return JSON.stringify(file, null, 2) + "\n";
}

export interface MergedPresetLibraries {
  /** Caller library wins on collision; bundled-only entries fill the rest. */
  merged: MeshPresetLibrary;
  /** Names present in both (the caller's entry is the one served). */
  collisions: string[];
}

/**
 * Merges the read-only bundled starters with the caller's own library —
 * the `mergeScriptLibraries` precedent verbatim. Pure object merge; either
 * side may be empty (a missing file reads as `{}`).
 */
export function mergePresetLibraries(
  bundled: MeshPresetLibrary,
  user: MeshPresetLibrary
): MergedPresetLibraries {
  const merged: MeshPresetLibrary = { ...bundled };
  const collisions: string[] = [];
  for (const [name, entry] of Object.entries(user)) {
    if (Object.prototype.hasOwnProperty.call(merged, name)) collisions.push(name);
    merged[name] = entry;
  }
  return { merged, collisions };
}

/**
 * Gmsh-only `MeshOptions` fields — the exact set `meshingPanel.ts` greys out
 * (`disabled`, not hidden) when `engine === "ftetwild"`, so the two can never
 * disagree about what "inapplicable" means. Kept here (not imported from the
 * panel) because this module must stay DOM-free.
 */
const GMSH_ONLY_FIELDS: readonly (keyof MeshOptions)[] = [
  "sizeMin",
  "algorithm2D",
  "algorithm3D",
  "elementOrder",
  "elementShape",
  "stlAngle",
];

/**
 * fTetWild-only fields — the mirror set the panel greys out under `"gmsh"`.
 * `dimension`/`sizeMax`/`optimize` apply to both engines (`sizeMax` drives
 * fTetWild's `idealEdgeLengthRel`; `dimension: 3` gates fTetWild
 * effectiveness via `effectiveEngine`, it doesn't disable the field).
 */
const FTETWILD_ONLY_FIELDS: readonly (keyof MeshOptions)[] = [
  "ftetwildEpsRel",
  "ftetwildManifoldSurface",
  "ftetwildCoarsen",
  "ftetwildDisableFiltering",
];

/**
 * Names the stored fields the preset's own engine ignores — but only ones
 * that actually differ from the default (a default-valued field is inert
 * under either engine, so listing it would be noise). The FE Mesh panel's
 * greyed-not-hidden idiom as data: reported, never stripped.
 */
export function inapplicablePresetFields(preset: MeshPreset): (keyof MeshOptions)[] {
  const ignored =
    preset.engine === "ftetwild" ? GMSH_ONLY_FIELDS : preset.engine === "gmsh" ? FTETWILD_ONLY_FIELDS : [];
  return ignored.filter(
    (f) => JSON.stringify(preset.options[f]) !== JSON.stringify(DEFAULT_MESH_OPTIONS[f])
  );
}

export interface EffectivePresetOptions {
  /** mm-native options, ready to store as the document's `MeshOptions`. */
  options: MeshOptions;
  /** Every fallback/conversion reported, never silent. */
  warnings: string[];
}

/**
 * Derives the mm-native effective options for a preset: the stored options
 * re-validated (defensive — the library file may have been hand-edited since
 * parsing), sizes converted from the preset's authored `unit` into mm, and
 * the preset's pinned engine applied. `SIZE_MAX_SENTINEL` is never converted.
 */
export function effectivePresetOptions(preset: MeshPreset): EffectivePresetOptions {
  const warnings: string[] = [];
  const validated = validateMeshOptions(preset.options) ?? { ...DEFAULT_MESH_OPTIONS };
  const factor = unitScaleFactor(preset.unit);
  const sizeMin = validated.sizeMin / factor;
  const sizeMax = validated.sizeMax === SIZE_MAX_SENTINEL ? SIZE_MAX_SENTINEL : validated.sizeMax / factor;
  if (preset.unit !== "mm") {
    warnings.push(
      `Sizes converted from ${preset.unit} to mm (sizeMin ${validated.sizeMin} → ${sizeMin}, sizeMax ${validated.sizeMax === SIZE_MAX_SENTINEL ? "auto" : `${validated.sizeMax} → ${sizeMax}`}).`
    );
  }
  const options: MeshOptions = { ...validated, sizeMin, sizeMax, engine: preset.engine };
  for (const field of inapplicablePresetFields(preset)) {
    const other = preset.engine === "ftetwild" ? "fTetWild" : "Gmsh";
    warnings.push(`"${field}" is ${JSON.stringify(preset.options[field])} in the preset but is ignored by ${other} — it has no effect under this preset's engine.`);
  }
  return { options, warnings };
}
