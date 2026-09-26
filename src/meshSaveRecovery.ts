/**
 * The recoverable mesh save-in-place transaction (roadmap 1.5, "Recoverable
 * mesh source saves") — vscode-free and DOM-free, with all file I/O injected,
 * so the whole open-and-recover path is unit-testable headlessly. Follows
 * `meshSourceInput.ts`'s exact shape: one implementation, two consumers.
 *
 * `provider.ts` passes `vscode.workspace.fs` readers plus the ask/user-decision
 * and watcher-suppression callbacks; `mcpTools.ts` passes `node:fs` and turns
 * the ask into a `load_model` warning (headless has no UI to ask with, so it
 * never acts on the unrecognised branch).
 *
 * See `saveJournal.ts` for the hazard and the pure decision rules. This module
 * is the I/O choreography around them:
 *
 *   open:   journal ← {preSaveSha256, bakedSha256, bakedThrough}
 *   save:   `.bak` → temp sibling → rename over the source
 *   then:   edits sidecar watermark
 *   close:  journal deleted
 *
 * Any process death between the rename and the watermark write is repaired on
 * the next open by comparing the two hashes the journal already carries. Any
 * process death before the rename needs nothing (the watermark is still
 * correct) and the leftover temp sibling is swept.
 */

import {
  hashBytes,
  parseSaveJournal,
  planRecovery,
  recoveryMessage,
  saveJournalFileName,
  saveTempFileName,
  serializeSaveJournal,
  type RecoveryAction,
  type SaveJournal,
  type SaveJournalResolution,
} from "./saveJournal";
import type { ParsedEdits } from "./editsSidecar";
import type { EditOp } from "./editOps";
import type { ParamVariable } from "./editVariables";

export interface MeshSaveRecoveryDeps {
  /** Reads a sibling file's bytes, by name; throws when it does not exist. */
  readBytes: (fileName: string) => Promise<Uint8Array>;
  /** Reads a sibling file's bytes, by name, or `null` when absent/unreadable. */
  readBytesOrNull: (fileName: string) => Promise<Uint8Array | null>;
  writeBytes: (fileName: string, bytes: Uint8Array) => Promise<void>;
  /** Renames one sibling over another; must be atomic enough that a reader
   *  never sees a partially written file. */
  renameOver: (fromFileName: string, toFileName: string) => Promise<void>;
  deleteFile: (fileName: string) => Promise<void>;
  /** The edits sidecar's current parsed state. */
  readEdits: () => Promise<ParsedEdits>;
  writeEdits: (ops: EditOp[], variables: ParamVariable[], bakedThrough: number) => Promise<void>;
  /**
   * Asks about a source that matches neither the pre-save nor the baked bytes.
   * Returns `"restore"` to roll back to the pre-save backup, `"keep"` to leave
   * the file alone, or `null` for a dismissed prompt (treated as `"keep"`, so
   * a dismissal can never destroy the evidence). The MCP server passes a stub
   * returning `null` and surfaces `recoveryMessage` as a warning instead.
   */
  askUnrecognised: (info: {
    fileName: string;
    backupName: string;
    canRestoreBackup: boolean;
    message: string;
  }) => Promise<"restore" | "keep" | null>;
  /**
   * Runs `fn` with the extension's own source-file watcher suppressed. Only
   * the restore branch needs it (every other branch leaves the source alone);
   * without it the watcher would reload the document underneath the recovery.
   */
  withSourceWrite: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * The four on-disk names, all SIBLINGS of the source and all expressed as bare
 * file names rather than paths. That is what lets one implementation serve both
 * surfaces: each caller joins the name onto its own root (`vscode.workspace.fs`
 * addresses a `vscode.Uri`, `node:fs` a string), so no path-separator or URI
 * scheme question ever leaks into this module.
 */
export interface MeshSavePaths {
  /** The source file's own name. */
  source: string;
  /** The transaction marker. */
  journal: string;
  /** The one-deep pre-save backup. */
  backup: string;
  /** The write-then-rename sibling. */
  temp: string;
}

/** Derives all four names from the source's own file name. */
export function meshSavePaths(fileName: string, exportExt: string): MeshSavePaths {
  return {
    source: fileName,
    journal: saveJournalFileName(fileName),
    backup: `${fileName}.bak`,
    temp: saveTempFileName(fileName, exportExt),
  };
}

// --- write side -------------------------------------------------------------

let saveCounter = 0;

/** A per-save unique id, without a new dependency (`randomUUID` lives in mcpTools.ts). */
function newSaveId(): string {
  saveCounter += 1;
  return `${Date.now().toString(36)}-${saveCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface BeginMeshSaveInput {
  paths: MeshSavePaths;
  fileName: string;
  format: string;
  /** The watermark this save intends to advance to. */
  bakedThrough: number;
  /** The source's bytes as they are right now (before this save). */
  preSaveBytes: Uint8Array;
  /** The bytes this save intends to write. */
  bakedBytes: Uint8Array;
  /** One-deep per session: only copy the `.bak` when asked (the interactive
   *  path's `madeSourceBackupThisSession`, the crash guard's own contract). */
  writeBackup: boolean;
}

/**
 * Opens a transaction: writes the journal (both hashes are computable right
 * now from bytes the caller already holds) and, when `writeBackup`, refreshes
 * the one-deep `.bak`. Returns the journal to hand back to {@link endMeshSave}.
 *
 * The journal is written BEFORE the backup, so a crash at every point after
 * this call is recoverable; a crash before it changed nothing at all.
 */
export async function beginMeshSave(input: BeginMeshSaveInput, deps: Pick<MeshSaveRecoveryDeps, "writeBytes">): Promise<SaveJournal> {
  const journal: SaveJournal = {
    version: 1,
    source: input.fileName,
    saveId: newSaveId(),
    startedAt: new Date().toISOString(),
    format: input.format,
    bakedThrough: input.bakedThrough,
    preSaveSha256: hashBytes(input.preSaveBytes),
    bakedSha256: hashBytes(input.bakedBytes),
  };
  await deps.writeBytes(input.paths.journal, Buffer.from(serializeSaveJournal(journal), "utf8"));
  if (input.writeBackup) await deps.writeBytes(input.paths.backup, input.preSaveBytes);
  return journal;
}

/**
 * Closes a transaction by deleting its journal — but only when the journal on
 * disk is still THIS save's. Compare-before-delete is what stops a completing
 * save from removing a *newer* transaction's marker when two editors target the
 * same source concurrently. (It does not, and cannot, stop recovery from
 * racing a save that is genuinely in flight: that is the documented
 * cross-process gap `save_model` already states.)
 */
export async function endMeshSave(
  paths: MeshSavePaths,
  journal: SaveJournal,
  deps: Pick<MeshSaveRecoveryDeps, "readBytesOrNull" | "deleteFile">
): Promise<void> {
  const onDisk = await deps.readBytesOrNull(paths.journal);
  if (!onDisk) return;
  const current = parseSaveJournal(Buffer.from(onDisk).toString("utf8"));
  if (current && current.saveId !== journal.saveId) return;
  await deps.deleteFile(paths.journal);
}

// --- read side --------------------------------------------------------------

export interface MeshSaveRecoveryResult {
  /** The plan that was carried out. */
  action: RecoveryAction;
  /** Why, for the caller's own messaging. */
  reason: string;
  /** The watermark the caller should now hold — advanced by a `finish`, otherwise unchanged. */
  bakedThrough: number;
  /** The human-facing line, or `null` when nothing happened. */
  message: string | null;
  /** True when the caller must re-read the edits sidecar (a `finish` wrote it). */
  sidecarChanged: boolean;
  /** True when the caller must reload the source (a `restore` rewrote it). */
  sourceChanged: boolean;
}

const NO_RECOVERY: MeshSaveRecoveryResult = {
  action: "none",
  reason: "no-journal",
  bakedThrough: 0,
  message: null,
  sidecarChanged: false,
  sourceChanged: false,
};

/**
 * Repairs an interrupted save-in-place, if there was one. Call this before the
 * source is read and before a new save is opened. The caller gates on
 * `MESH_SAVE_IN_PLACE_FORMATS` — this module deliberately holds no format set
 * of its own, since a second, drifting copy of that list is exactly the hazard
 * this codebase keeps recording — so a B-rep, glTF or meshio source never
 * reaches the journal machinery at all.
 *
 * Four outcomes, and only two of them write anything:
 *
 * - `finish` — the source provably holds this transaction's baked bytes, so the
 *   only missing step is the watermark. Advances it, which is what stops the
 *   pending edits replaying over already-baked geometry.
 * - `discard` — the source never changed; the existing watermark was already
 *   correct. Journal removed, nothing else touched.
 * - `ask` — the source matches neither hash. The user is asked; `"restore"`
 *   copies the pre-save backup back over the source (offered only when that
 *   backup genuinely is this transaction's pre-save state), and either answer
 *   records a `resolution` so the prompt cannot reappear.
 * - `none` — nothing was in flight, or a previous open already settled it.
 *
 * Any failure here is non-fatal by design: the caller keeps today's behaviour
 * and reports the message, because a recovery problem must never be the reason
 * a model refuses to open.
 */
export async function recoverInterruptedMeshSave(
  paths: MeshSavePaths,
  fileName: string,
  deps: MeshSaveRecoveryDeps
): Promise<MeshSaveRecoveryResult> {
  let journal: SaveJournal | null = null;
  try {
    const raw = await deps.readBytesOrNull(paths.journal);
    journal = raw ? parseSaveJournal(Buffer.from(raw).toString("utf8")) : null;
  } catch {
    return NO_RECOVERY;
  }
  if (!journal) return NO_RECOVERY;

  let parsed: ParsedEdits;
  let sourceSha: string;
  let backupSha: string | null = null;
  try {
    parsed = await deps.readEdits();
    const sourceBytes = await deps.readBytes(paths.source);
    sourceSha = hashBytes(sourceBytes);
    const backupBytes = await deps.readBytesOrNull(paths.backup);
    if (backupBytes) backupSha = hashBytes(backupBytes);
  } catch {
    // Unreadable source or sidecar: we cannot compare anything, so do nothing
    // rather than guess. The journal stays for a later open.
    return {
      action: "none",
      reason: "unreadable",
      bakedThrough: 0,
      message: null,
      sidecarChanged: false,
      sourceChanged: false,
    };
  }

  const plan = planRecovery({
    journal,
    sidecarBakedThrough: parsed.bakedThrough,
    sidecarOpsCount: parsed.ops.length,
    sourceSha256: sourceSha,
    backupSha256: backupSha,
  });
  const message = recoveryMessage(plan, fileName, `${fileName}.bak`);

  /** Removes the journal only when it is still THIS transaction's, so a
   *  completing save/recovery never deletes a newer transaction's marker. */
  const settle = async (): Promise<void> => {
    const onDisk = await deps.readBytesOrNull(paths.journal);
    if (onDisk) {
      const current = parseSaveJournal(Buffer.from(onDisk).toString("utf8"));
      if (current && current.saveId !== journal.saveId) return;
    }
    await deleteIfPresent(paths.journal, deps);
    // A leftover temp sibling from a death between writing it and renaming it
    // is pure garbage once the transaction is settled.
    await deleteIfPresent(paths.temp, deps);
  };

  try {
    switch (plan.action) {
      case "none":
        // `already-advanced` is a crash between the watermark write and the
        // journal removal: the pair already agrees, so there is nothing to say,
        // but the marker (and any temp sibling) must still be swept or it would
        // linger for the life of the document. `already-resolved` deliberately
        // does NOT settle — its journal carries the recorded decision.
        if (plan.reason === "already-advanced") await settle();
        return {
          action: "none",
          reason: plan.reason,
          bakedThrough: parsed.bakedThrough,
          message: null,
          sidecarChanged: false,
          sourceChanged: false,
        };
      case "finish":
        await deps.writeEdits(parsed.ops, parsed.variables, journal.bakedThrough);
        await settle();
        return {
          action: "finish",
          reason: "watermark-advanced",
          bakedThrough: journal.bakedThrough,
          message,
          sidecarChanged: true,
          sourceChanged: false,
        };
      case "discard":
        await settle();
        return {
          action: "discard",
          reason: "source-unchanged",
          bakedThrough: parsed.bakedThrough,
          message,
          sidecarChanged: false,
          sourceChanged: false,
        };
      case "ask": {
        const choice = await deps.askUnrecognised({
          fileName,
          backupName: paths.backup,
          canRestoreBackup: plan.canRestoreBackup,
          message: message ?? "",
        });
        const repaired = choice === "restore" && plan.canRestoreBackup;
        if (repaired) {
          const backup = await deps.readBytes(paths.backup);
          await deps.withSourceWrite(() => deps.writeBytes(paths.source, backup));
        }
        // Record the decision INSIDE the journal rather than deleting it: that
        // is what makes a second open a no-op instead of a second prompt, and
        // it preserves the evidence the user may still want to look at.
        await deps.writeBytes(
          paths.journal,
          Buffer.from(serializeSaveJournal({ ...journal, resolution: repaired || choice === "keep" ? "decided" : "deferred" }), "utf8")
        );
        await deleteIfPresent(paths.temp, deps);
        return {
          action: "ask",
          reason: repaired ? "restored-backup" : "kept-unrecognised",
          bakedThrough: parsed.bakedThrough,
          message: repaired
            ? `Restored ${fileName} from its pre-save backup after an interrupted save; the pending edit list reapplies on open.`
            : message,
          sidecarChanged: false,
          sourceChanged: repaired,
        };
      }
    }
  } catch {
    // The watermark write or the prompt failed. Leave the journal exactly where
    // it is so a later open retries, and report the plan's own wording — the
    // document still opens either way.
    return { action: "none", reason: "recovery-failed", bakedThrough: parsed.bakedThrough, message, sidecarChanged: false, sourceChanged: false };
  }
}

/** Deletes a file, tolerating its absence — every caller is best-effort cleanup. */
async function deleteIfPresent(path: string, deps: Pick<MeshSaveRecoveryDeps, "deleteFile">): Promise<void> {
  await deps.deleteFile(path).catch(() => undefined);
}
