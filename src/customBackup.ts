import * as vscode from "vscode";

/**
 * Hot-exit snapshots for Tier 0 Phase 2 (`backupCustomDocument`).
 *
 * What gets snapshotted: the CAD source bytes plus whichever of the six
 * sidecars exist on disk at snapshot time (edits/parts/annotations/planes/
 * mesh-options + the generated `.geo`, view state). The op tail is the only
 * state that never reaches disk without an explicit save (sidecars
 * self-persist on a ~500 ms debounce), so the snapshot is nearly always
 * identical to what's already on disk — cheap insurance, not a second
 * persistence model.
 *
 * Layout: `<destination>/manifest.json` (`{source, sidecars}` basenames) +
 * `source.bin` + one file per sidecar under its own basename. The backup id
 * IS the destination's filesystem path, so `openCustomDocument` needs no
 * registry to find a snapshot back. All reads tolerate missing files (a
 * document whose panel was never touched simply has no sidecars).
 */

interface CustomBackupManifest {
  source: string;
  sidecars: string[];
}

async function readIfExists(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch {
    return undefined;
  }
}

/**
 * Snapshot `sourceUri` + `sidecarUris` (skipping whichever don't exist) into
 * `destination` (created, parents included). Returns the backup id plus a
 * `delete()` removing the snapshot (called by VS Code when superseded or
 * saved).
 */
export async function writeCustomBackup(
  sourceUri: vscode.Uri,
  sidecarUris: vscode.Uri[],
  destination: vscode.Uri
): Promise<{ id: string; delete(): void }> {
  const fs = vscode.workspace.fs;
  await fs.createDirectory(destination);
  const sourceName = sourceUri.path.slice(sourceUri.path.lastIndexOf("/") + 1);
  const source = await readIfExists(sourceUri);
  if (source !== undefined) {
    await fs.writeFile(vscode.Uri.joinPath(destination, "source.bin"), source);
  }
  const manifest: CustomBackupManifest = { source: sourceName, sidecars: [] };
  for (const sidecarUri of sidecarUris) {
    const bytes = await readIfExists(sidecarUri);
    if (bytes === undefined) continue;
    const name = sidecarUri.path.slice(sidecarUri.path.lastIndexOf("/") + 1);
    await fs.writeFile(vscode.Uri.joinPath(destination, name), bytes);
    manifest.sidecars.push(name);
  }
  await fs.writeFile(
    vscode.Uri.joinPath(destination, "manifest.json"),
    Buffer.from(JSON.stringify(manifest), "utf8")
  );
  const id = destination.fsPath;
  return {
    id,
    delete(): void {
      void fs.delete(vscode.Uri.file(id), { recursive: true }).then(undefined, () => undefined);
    },
  };
}

/**
 * Copy a snapshot back over its workspace files (`targetUri` = the source
 * file's current location; sidecars land beside it). Throws on any failure —
 * callers restoring on open fail OPEN (proceed with what's on disk) rather
 * than blocking the open on a corrupt snapshot.
 */
export async function restoreCustomBackup(backupId: string, targetUri: vscode.Uri): Promise<void> {
  const fs = vscode.workspace.fs;
  const dir = vscode.Uri.file(backupId);
  const manifestRaw = await fs.readFile(vscode.Uri.joinPath(dir, "manifest.json"));
  const manifest = JSON.parse(Buffer.from(manifestRaw).toString("utf8")) as CustomBackupManifest;
  const source = await fs.readFile(vscode.Uri.joinPath(dir, "source.bin"));
  await fs.writeFile(targetUri, source);
  const targetDir = vscode.Uri.joinPath(targetUri, "..");
  for (const name of manifest.sidecars) {
    const bytes = await fs.readFile(vscode.Uri.joinPath(dir, name));
    await fs.writeFile(vscode.Uri.joinPath(targetDir, name), bytes);
  }
}
