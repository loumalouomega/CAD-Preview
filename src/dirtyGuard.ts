/**
 * Refuses to overwrite a sidecar the user has open with unsaved changes.
 *
 * The CAD source is never written (that invariant is enforced elsewhere), but
 * the `.edits.json` / `.parts.json` / `.annotations.json` / `.mesh.json`
 * sidecars are ordinary JSON files a user may well have open and hand-edited —
 * and the extension autosaves them on a debounce. Without this guard, a
 * keystroke in the viewer silently clobbers work the user typed by hand.
 *
 * **The seam is the four store modules, not `provider.ts`.** There are a dozen
 * sidecar write sites scattered through the provider with no choke point, but
 * each store has exactly one `writeX(uri, …)`, so guarding there covers every
 * call site — including the preprocess-restore path — for a few lines apiece.
 *
 * **Guards fail open, never closed.** If the check itself cannot run, the write
 * proceeds: a broken guard must not also break saving. The only thing it may do
 * is decline a write it is *sure* would destroy unsaved work.
 *
 * Scoped to the interactive extension. `dist/mcp-server.js` runs as its own
 * process with no VS Code API and cannot see dirty buffers at all; giving it
 * the same protection would need a cross-process channel, which is recorded as
 * a known gap rather than invented here.
 */

import * as vscode from "vscode";

/** Thrown by a store's write when the target has unsaved edits open. */
export class DirtyBufferError extends Error {
  constructor(readonly uri: vscode.Uri) {
    super(
      `Not saving ${basename(uri)} — you have unsaved changes to it open in an editor. ` +
        `Save or revert that tab, then try again.`
    );
    this.name = "DirtyBufferError";
  }
}

function basename(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf("/") + 1);
}

/**
 * True when `uri` is open in an editor with unsaved changes.
 *
 * Compares on `fsPath` rather than `toString()`: the same file can be addressed
 * by URIs that differ in casing or query, and a false negative here silently
 * costs the user their edits, which is the failure this exists to prevent.
 */
export function hasUnsavedChanges(uri: vscode.Uri): boolean {
  try {
    return vscode.workspace.textDocuments.some((doc) => doc.isDirty && doc.uri.fsPath === uri.fsPath);
  } catch {
    return false; // fail open
  }
}

/**
 * Throws {@link DirtyBufferError} if writing `uri` would discard unsaved edits.
 *
 * Call at the top of every sidecar write.
 */
export function assertNotDirty(uri: vscode.Uri): void {
  if (hasUnsavedChanges(uri)) throw new DirtyBufferError(uri);
}
