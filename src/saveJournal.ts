import { sha256Hex } from "./hash";

/**
 * The recoverable save transaction (roadmap 1.5, "Recoverable mesh source
 * saves") — pure (vscode-free, DOM-free) so the decision rules unit-test like
 * `sidecarRevision.ts`, which shares the `sha256Hex` helper.
 *
 * ## The hazard
 *
 * A save-in-place writes the CAD source and then advances the `.edits.json`
 * `bakedThrough` watermark, in that order. Both interactive
 * (`bakeMeshToSource`) and headless (`saveMeshModel`) paths already roll the
 * source back when the watermark write *throws* — but a process that simply
 * stops between the two writes leaves the pair disagreeing: the file on disk is
 * baked while the sidecar still says otherwise, so reopening replays the same
 * edit over already-baked geometry.
 *
 * ## The mechanism
 *
 * A journal file beside the source, written BEFORE the source write and deleted
 * AFTER the watermark write. Its mere presence means "a save was in flight";
 * its two content hashes say which of the two writes landed. Both hashes are
 * computable at every boundary from bytes the caller already holds, so opening
 * a transaction costs one small file write and one SHA-256 over each buffer.
 *
 * This is deliberately NOT a seventh sidecar. It is per-save transaction state,
 * not per-document state: it is never read as a document's history, never
 * archived by `save_preprocess`, and absent from `list_workspace_models`'s
 * companion set. Its presence is reported by recovery itself, which is the only
 * thing that needs to act on it.
 *
 * ## What is NOT handled here
 *
 * A second process that is *mid-save* is undetectable — the same cross-process
 * gap `save_model` already documents. What the journal does guarantee is that a
 * completing save removes the journal only when its own `saveId` is still the
 * one on disk, so a save can never delete a *newer* transaction's journal.
 */
export const SAVE_JOURNAL_VERSION = 1;

/** A user decision already recorded for an unrecognised source. Present at all
 *  means "do not prompt again" — the two values differ only in whether
 *  something was actually repaired. */
export type SaveJournalResolution = "decided" | "deferred";

export interface SaveJournal {
  version: number;
  /** The source file's own basename — provenance only, never a path. */
  source: string;
  /** Unique per save attempt; guards the compare-before-delete in the stores. */
  saveId: string;
  /** ISO timestamp of the write that opened the transaction. */
  startedAt: string;
  /** The source's own format id (stl/obj/ply in the first increment). */
  format: string;
  /** The watermark this transaction intends to advance to. */
  bakedThrough: number;
  /** sha256 of the source bytes as they were before this transaction. */
  preSaveSha256: string;
  /** sha256 of the bytes this transaction intends to write. */
  bakedSha256: string;
  /** Present once a user decision has been recorded for an unrecognised source. */
  resolution?: SaveJournalResolution;
}

interface SaveJournalFile extends Omit<SaveJournal, "resolution"> {
  resolution?: SaveJournalResolution;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Tolerant parse, exactly like every other sidecar parser here: a malformed or
 * truncated journal yields `null` rather than throwing, so a corrupt marker can
 * never block opening the model. Recovery treats `null` as "no transaction" and
 * the document opens with today's behaviour.
 */
export function parseSaveJournal(text: string): SaveJournal | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const file = data as Partial<SaveJournalFile> | null;
  if (!file || typeof file !== "object") return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const source = str(file.source);
  const saveId = str(file.saveId);
  const startedAt = str(file.startedAt);
  const format = str(file.format);
  const preSaveSha256 = str(file.preSaveSha256);
  const bakedSha256 = str(file.bakedSha256);
  if (!source || !saveId || !startedAt || !format || !preSaveSha256 || !bakedSha256) return null;
  if (!SHA256.test(preSaveSha256) || !SHA256.test(bakedSha256)) return null;
  if (file.version !== SAVE_JOURNAL_VERSION) return null;
  if (!Number.isInteger(file.bakedThrough) || (file.bakedThrough as number) < 0) return null;
  const resolution = file.resolution === "decided" || file.resolution === "deferred" ? file.resolution : undefined;
  const journal: SaveJournal = {
    version: SAVE_JOURNAL_VERSION,
    source,
    saveId,
    startedAt,
    format,
    bakedThrough: file.bakedThrough as number,
    preSaveSha256,
    bakedSha256,
  };
  if (resolution) journal.resolution = resolution;
  return journal;
}

/** Pretty-printed, trailing newline — the same shape every other sidecar writes. */
export function serializeSaveJournal(journal: SaveJournal): string {
  return JSON.stringify(journal, null, 2) + "\n";
}

export type RecoveryAction = "none" | "discard" | "finish" | "ask";

export type RecoveryPlan =
  /** Nothing to do: no transaction, or one already resolved in either direction. */
  | { action: "none"; reason: "no-journal" | "already-resolved" | "already-advanced" }
  /** The source still holds its pre-save bytes, so the stale watermark is correct — drop the journal. */
  | { action: "discard" }
  /** The source provably holds the baked bytes — advance the watermark to finish the save. */
  | { action: "finish" }
  /** The source matches neither hash: never guess. */
  | { action: "ask"; canRestoreBackup: boolean };

export interface RecoveryInputs {
  /** The journal read from disk, or `null` when absent/unreadable. */
  journal: SaveJournal | null;
  /** The watermark currently recorded in the edits sidecar. */
  sidecarBakedThrough: number;
  /** How many ops the edits sidecar currently holds. */
  sidecarOpsCount: number;
  /** sha256 of the source file as it is on disk right now. */
  sourceSha256: string;
  /** sha256 of `<model>.bak`, or `null` when it is absent. */
  backupSha256: string | null;
}

/**
 * The whole recovery policy, as one pure function.
 *
 * Order matters and each step is a reason to stop:
 *
 * 1. **no journal** — nothing was in flight.
 * 2. **already resolved** — an unrecognised source got a decision recorded on a
 *    previous open. This is what makes recovery idempotent in the `ask`
 *    branch: a second open sees the marker and does nothing.
 * 3. **already advanced** — the watermark write landed and only the journal
 *    removal was lost. The pair agrees; drop the journal.
 * 4. **finish** — the source provably holds this transaction's baked bytes, so
 *    the watermark write is all that is missing. Guarded on the sidecar still
 *    holding at least `bakedThrough` ops, so a hand-edited or truncated sidecar
 *    can never be handed a watermark past its own op list.
 * 5. **discard** — the source still holds its pre-save bytes (the write never
 *    landed, or landed only as a temp file), so the existing watermark is
 *    already correct and there is nothing to restore.
 * 6. **ask** — the source matches neither hash: a torn write, or an external
 *    edit landing inside the crash window. We cannot tell which, and guessing
 *    either way is a silently-wrong result. The backup is offered as a repair
 *    ONLY when it genuinely is this transaction's pre-save bytes: `.bak` is
 *    one-deep per *session*, so on a second save it holds the pre-*first*-save
 *    bytes and restoring it would silently discard an earlier successful save.
 */
export function planRecovery(inputs: RecoveryInputs): RecoveryPlan {
  const { journal, sidecarBakedThrough, sidecarOpsCount, sourceSha256, backupSha256 } = inputs;
  if (!journal) return { action: "none", reason: "no-journal" };
  if (journal.resolution) return { action: "none", reason: "already-resolved" };
  if (sidecarBakedThrough >= journal.bakedThrough) return { action: "none", reason: "already-advanced" };
  if (sourceSha256 === journal.bakedSha256 && sidecarOpsCount >= journal.bakedThrough) return { action: "finish" };
  if (sourceSha256 === journal.preSaveSha256) return { action: "discard" };
  return { action: "ask", canRestoreBackup: backupSha256 !== null && backupSha256 === journal.preSaveSha256 };
}

/** sha256 of a byte buffer, for the stores' on-disk comparisons. */
export function hashBytes(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

// --- file names -------------------------------------------------------------
// The single source of truth for the two new on-disk names. Each surface joins
// them onto its own path type (`vscode.Uri.joinPath` beside the model, or
// `path.join` headlessly) so a name can never drift between them.

/** `<model>.save-journal.json` — the transaction marker. */
export function saveJournalFileName(modelFileName: string): string {
  return `${modelFileName}.save-journal.json`;
}

/**
 * `<base>.save-tmp.<ext>` — the write-then-rename sibling both save paths
 * already use, so a crash mid-write can never truncate the source. The base
 * strips only the LAST extension, so a compound extension keeps its stem
 * (`two-tets.post.msh` → `two-tets.post.save-tmp.msh`) exactly as the existing
 * inline constructions did.
 */
export function saveTempFileName(modelFileName: string, ext: string): string {
  return `${modelFileName.replace(/\.[^.]+$/, "")}.save-tmp.${ext}`;
}

/**
 * The user-facing wording for each outcome, shared by both surfaces so the
 * interactive status line and the MCP warning can never disagree. `fileName` is
 * the source's own basename; `backupName` the `.bak` filename.
 */
export function recoveryMessage(plan: RecoveryPlan, fileName: string, backupName: string): string | null {
  switch (plan.action) {
    case "none":
      return null;
    case "finish":
      return `Recovered an interrupted save of ${fileName}: the file on disk held the saved geometry but the edit history had not caught up, so the save was completed.`;
    case "discard":
      return `Recovered an interrupted save of ${fileName}: the file on disk was never rewritten, so the pending edit list is unchanged.`;
    case "ask":
      return `An interrupted save of ${fileName} was found, and the file on disk matches neither the pre-save nor the saved geometry — it was most likely left half-written, or changed by something else during the interrupted save. Nothing has been changed. Save again to re-bake the pending edits, or restore ${backupName} (the pre-save backup) to go back to the state before the save.`;
  }
}
