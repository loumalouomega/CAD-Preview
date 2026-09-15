/**
 * The bundled starter macro library (roadmap Tier 1 "A bundled starter macro
 * library", closed) — a few parameterized scripts shipped WITH the extension
 * so `list_parametric_scripts`/`run_saved_script` (and the interactive Macros
 * panel) are useful before the user has ever saved anything.
 *
 * Pure (no vscode, no node fs, no WASM): the JSON lives at
 * `macros/starter-library.json` in the repo, is copied to
 * `dist/macros/starter-library.json` by `esbuild.mjs`'s `copyMacros()` (the
 * same recipe `copyWasm()` uses for the WASM binaries), and is READ through
 * `mcpSidecars.ts`'s `readBundledScriptLibrary` (node fs, MCP side) or
 * `provider.ts`'s own `vscode.workspace.fs` read (extension side) — both
 * parsing through the same tolerant `parseScriptLibraryJson` the user library
 * uses, so a malformed bundled entry is dropped, never fatal.
 *
 * The bundled library is READ-ONLY: `save_parametric_script` still requires
 * an explicit caller-named `libraryPath` and never writes into the bundle.
 * On a name collision the caller's own library wins (reported, never silent).
 */

import type { ScriptLibrary } from "./scriptLibrary";

/** Basename of the bundled library file, both in `macros/` and in `dist/macros/`. */
export const BUNDLED_MACROS_FILE = "starter-library.json";

/**
 * Absolute path of the bundled library for a given extension root — the same
 * `<extensionPath>/dist/...` convention the WASM binaries use
 * (`getOcct()` joins the same way), so the MCP server (`CAD_PREVIEW_ROOT`
 * or the bundle dir's parent) and the extension host resolve identically.
 */
export function bundledMacrosPath(extensionPath: string): string {
  return `${extensionPath}/dist/macros/${BUNDLED_MACROS_FILE}`;
}

export interface MergedLibraries {
  /** Caller library wins on collision; bundled-only entries fill the rest. */
  merged: ScriptLibrary;
  /** Names present in both (the caller's entry is the one served). */
  collisions: string[];
}

/**
 * Merges the read-only bundled starters with the caller's own library.
 * Pure object merge — either side may be empty (a missing file reads as `{}`).
 */
export function mergeScriptLibraries(bundled: ScriptLibrary, user: ScriptLibrary): MergedLibraries {
  const merged: ScriptLibrary = { ...bundled };
  const collisions: string[] = [];
  for (const [name, entry] of Object.entries(user)) {
    if (Object.prototype.hasOwnProperty.call(merged, name)) collisions.push(name);
    merged[name] = entry;
  }
  return { merged, collisions };
}
