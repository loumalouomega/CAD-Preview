import * as vscode from "vscode";

/**
 * The `.scad` conversion settings, read fresh from the user's configuration.
 * Spread into `resolveEffectiveSource({...})` at every interactive call site so
 * the binary, backend and library paths can never be configured for one entry
 * point and forgotten at another. The headless twins are the `OPENSCAD_BINARY`
 * / `OPENSCAD_BACKEND` / `OPENSCADPATH` environment variables, which
 * `scadService.ts` reads when a field here is unset.
 */
export function readScadSettings(): { binary?: string; backend?: string; libraryPaths?: string[] } {
  const cfg = vscode.workspace.getConfiguration("cadPreview");
  const paths = cfg.get<string[]>("openscadLibraryPaths");
  return {
    binary: cfg.get<string>("openscadBinary") ?? undefined,
    backend: cfg.get<string>("openscadBackend") ?? undefined,
    libraryPaths: Array.isArray(paths) ? paths.filter((p) => typeof p === "string") : undefined,
  };
}
