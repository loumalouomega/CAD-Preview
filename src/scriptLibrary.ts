/**
 * A persistent library of named, parameterized scripts — the "macro" store.
 *
 * Pure (no vscode, no node fs, no WASM), mirroring `partsSidecar.ts`'s
 * parse/serialize split: `mcpSidecars.ts` adds the node-fs I/O, exactly as it
 * does for every other sidecar.
 *
 * **There is no macro language here, deliberately.** `parametricScript.ts`
 * already compiles a declarative `{variables?, steps}` document with a `repeat`
 * loop and a full expression evaluator, and `compileParametricScript` takes
 * `unknown` and self-validates — so a stored script is handed to it verbatim
 * with no pre-validation. What was missing was only a name and a place to keep
 * it, which is all this module adds.
 *
 * **A script's own `variables` block IS its parameter list.** Calling a saved
 * script with overrides is a by-name merge onto that array before compiling —
 * no separate parameter schema exists or is needed.
 *
 * Storage is one explicit caller-named JSON file, not a hidden per-workspace
 * convention: there is no notion of a workspace root anywhere in the MCP server
 * (every path is caller-supplied), and a macro is not tied to one CAD document
 * the way `.edits.json` is tied to one source file.
 */

import type { ParamVariable } from "./editVariables";

export const SCRIPT_LIBRARY_VERSION = 1;

/** One saved macro. */
export interface ScriptLibraryEntry {
  /** Unique within the library; the key callers run it by. */
  name: string;
  description?: string;
  /**
   * The script document, kept as raw JSON on purpose — `compileParametricScript`
   * is the real (tolerant, always-current) gate, and duplicating its step/op
   * validation here would drift against it.
   */
  script: Record<string, unknown>;
}

/** The whole library: entries keyed by name. */
export type ScriptLibrary = Record<string, ScriptLibraryEntry>;

interface ScriptLibraryFile {
  version: number;
  scripts: Record<string, unknown>;
}

/** Guards against a pathological file; a macro library is small by nature. */
const MAX_ENTRIES = 500;
const MAX_NAME_LENGTH = 120;

/**
 * Tolerant: unknown or malformed entries are dropped rather than throwing, so a
 * hand-edited or partially-corrupt library never blocks the entries that are
 * still fine. Same discipline as every other sidecar parser in this codebase.
 */
export function parseScriptLibraryJson(text: string): ScriptLibrary {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  const raw = (data as Partial<ScriptLibraryFile> | null)?.scripts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out: ScriptLibrary = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_ENTRIES) break;
    const entry = validateEntry(key, value);
    if (entry) out[entry.name] = entry;
  }
  return out;
}

/**
 * One entry, or `null` if it cannot be trusted.
 *
 * The entry's own `name` field wins over its object key when both are present
 * and valid — the key is a convenience index, the field is the record. A key
 * with no usable name at all is dropped rather than guessed at.
 */
function validateEntry(key: string, value: unknown): ScriptLibraryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : key.trim();
  if (name === "" || name.length > MAX_NAME_LENGTH) return null;

  // A script must at least be an object; its contents are `compileParametricScript`'s
  // problem, not this parser's.
  if (!raw.script || typeof raw.script !== "object" || Array.isArray(raw.script)) return null;

  const entry: ScriptLibraryEntry = { name, script: raw.script as Record<string, unknown> };
  if (typeof raw.description === "string") entry.description = raw.description;
  return entry;
}

export function serializeScriptLibraryJson(library: ScriptLibrary): string {
  const file: ScriptLibraryFile = { version: SCRIPT_LIBRARY_VERSION, scripts: library };
  return JSON.stringify(file, null, 2) + "\n";
}

/** A saved script's declared parameters, for `list_parametric_scripts`. */
export interface ScriptParameter {
  name: string;
  /** The saved default expression. */
  expr: string;
}

/**
 * The parameter list a caller can override — i.e. the script's own `variables`.
 *
 * Reads defensively because the script body is unvalidated raw JSON: anything
 * that isn't a well-formed variable array yields `[]` rather than throwing.
 */
export function scriptParameters(script: Record<string, unknown>): ScriptParameter[] {
  const vars = script.variables;
  if (!Array.isArray(vars)) return [];
  const out: ScriptParameter[] = [];
  for (const v of vars) {
    if (!v || typeof v !== "object") continue;
    const raw = v as Record<string, unknown>;
    if (typeof raw.name !== "string" || typeof raw.expr !== "string") continue;
    out.push({ name: raw.name, expr: raw.expr });
  }
  return out;
}

export interface MergeResult {
  /** The script with overrides applied — a deep-ish copy; the input is untouched. */
  script: Record<string, unknown>;
  /** Override names that matched no declared variable. */
  unknownNames: string[];
}

/**
 * Applies caller-supplied `{name: value}` overrides onto a saved script's own
 * `variables` array, by name.
 *
 * An override for an undeclared name is **reported, not applied, and never
 * fatal** — the standing per-field-tolerant convention. Silently inventing the
 * variable would be worse: it would shadow a document variable of the same name
 * for that compile, which is a surprising action to take on a typo.
 *
 * A numeric override is written as its literal string, so it flows through
 * `compileParametricScript`'s ordinary expression path with no special casing.
 */
export function mergeScriptOverrides(
  script: Record<string, unknown>,
  overrides: Record<string, number | string> | undefined
): MergeResult {
  const copy: Record<string, unknown> = { ...script };
  if (!overrides || Object.keys(overrides).length === 0) {
    return { script: copy, unknownNames: [] };
  }

  const declared = scriptParameters(script);
  const declaredNames = new Set(declared.map((p) => p.name));
  const unknownNames = Object.keys(overrides).filter((n) => !declaredNames.has(n));

  // Rebuild the variables array from the DECLARED list rather than from the raw
  // one, so a malformed entry cannot survive an override pass. `value: 0` is the
  // same last-good-cache seed `setVariables` uses for a newly-named variable.
  const merged: ParamVariable[] = declared.map((p) => ({
    name: p.name,
    expr: Object.prototype.hasOwnProperty.call(overrides, p.name) ? String(overrides[p.name]) : p.expr,
    value: 0,
  }));
  copy.variables = merged;
  return { script: copy, unknownNames };
}
