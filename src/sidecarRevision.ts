/**
 * Sidecar revision tracking for explicit external-change conflicts (roadmap
 * "Explicit external-change conflict handling"). Pure — no vscode — so the
 * decision rules are unit-testable apart from the watcher plumbing in
 * `provider.ts`.
 *
 * The model: each document sidecar kind has a KNOWN disk revision (the
 * fingerprint of the bytes this editor last read or wrote) and may have a
 * LOCAL PENDING change (an autosave armed but not yet written). An external
 * write that lands while a local change is pending is a conflict — neither
 * version is silently discarded; the user picks one.
 *
 * Honest limits, stated once: this is detection, not a transaction. Between
 * the pre-write fingerprint check and the write itself another process can
 * still write (a narrow TOCTOU window); nothing here is a cross-process lock.
 * The watcher fires after such a race, so the loser is at least visible.
 */

import { sha256Hex } from "./hash";

export type SidecarKind = "edits" | "parts" | "planes" | "annotations" | "mesh";

export const SIDECAR_KIND_LABELS: Record<SidecarKind, string> = {
  edits: "Edits",
  parts: "Parts",
  planes: "Construction planes",
  annotations: "Annotations",
  mesh: "Mesh options",
};

/** Fingerprint of a file's bytes; `null` (missing/unreadable) is its own value. */
export function fingerprint(bytes: Uint8Array | null): string {
  return bytes === null ? "absent" : sha256Hex(bytes);
}

/** What an external disk change means for one kind. */
export type DiskChangeVerdict =
  /** Disk matches what this editor holds — an echo of our own write, or a no-op. */
  | "echo"
  /** Disk changed and nothing local is pending — adopt the disk version. */
  | "adopt"
  /** Disk changed while a local change is pending — ask the user. */
  | "conflict";

export class SidecarRevisionTracker {
  private readonly known = new Map<SidecarKind, string>();
  private readonly pending = new Set<SidecarKind>();
  private readonly paused = new Set<SidecarKind>();

  /** Records that disk and this editor agree at `fp` (after a read, an own write, or an adopt). */
  noteSynced(kind: SidecarKind, fp: string): void {
    this.known.set(kind, fp);
  }

  knownRevision(kind: SidecarKind): string | undefined {
    return this.known.get(kind);
  }

  markLocalPending(kind: SidecarKind): void {
    this.pending.add(kind);
  }

  isLocalPending(kind: SidecarKind): boolean {
    return this.pending.has(kind);
  }

  /** A resolution (write succeeded, reload chosen, overwrite chosen) ends both states. */
  resolve(kind: SidecarKind): void {
    this.pending.delete(kind);
    this.paused.delete(kind);
  }

  /** Autosave for `kind` is held until the user resolves the conflict. */
  pause(kind: SidecarKind): void {
    this.paused.add(kind);
  }

  isPaused(kind: SidecarKind): boolean {
    return this.paused.has(kind);
  }

  pausedKinds(): SidecarKind[] {
    return [...this.paused];
  }

  /**
   * Classifies a watcher event. `contentMatchesLocal` is the caller's own
   * semantic comparison (parsed content vs in-memory state) — the echo test
   * that has always made own writes harmless.
   */
  classifyDiskChange(kind: SidecarKind, contentMatchesLocal: boolean): DiskChangeVerdict {
    if (contentMatchesLocal) return "echo";
    return this.pending.has(kind) || this.paused.has(kind) ? "conflict" : "adopt";
  }

  /**
   * Whether an autosave may write now: false when paused, or when disk moved
   * away from the last known revision (someone wrote since we last synced).
   * An unknown revision (never read) never blocks.
   */
  canWrite(kind: SidecarKind, diskFp: string): boolean {
    if (this.paused.has(kind)) return false;
    const known = this.known.get(kind);
    return known === undefined || known === diskFp;
  }
}

/** Short item counts for the conflict prompt; `null` when the kind has no count. */
export interface ConflictSides {
  local: number | null;
  disk: number | null;
}

const NOUNS: Record<SidecarKind, [string, string]> = {
  edits: ["op", "ops"],
  parts: ["part", "parts"],
  planes: ["plane", "planes"],
  annotations: ["annotation", "annotations"],
  mesh: ["setting", "settings"],
};

function counted(n: number, kind: SidecarKind): string {
  const [one, many] = NOUNS[kind];
  return `${n} ${n === 1 ? one : many}`;
}

/** The one-line human summary shown in the conflict prompt. */
export function summarizeConflict(kind: SidecarKind, fileName: string, sides: ConflictSides): string {
  const label = SIDECAR_KIND_LABELS[kind];
  const counts =
    sides.local !== null && sides.disk !== null
      ? ` — disk now has ${counted(sides.disk, kind)}, this editor has ${counted(sides.local, kind)} with unsaved changes`
      : " — both the file on disk and this editor changed";
  return `${label} for ${fileName} changed on disk while you had unsaved changes${counts}.`;
}
