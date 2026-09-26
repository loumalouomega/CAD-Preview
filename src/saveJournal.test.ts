import { describe, expect, it } from "vitest";
import {
  SAVE_JOURNAL_VERSION,
  hashBytes,
  parseSaveJournal,
  planRecovery,
  recoveryMessage,
  serializeSaveJournal,
  type SaveJournal,
} from "./saveJournal";

const PRE = "a".repeat(64);
const BAKED = "b".repeat(64);

function journal(overrides: Partial<SaveJournal> = {}): SaveJournal {
  return {
    version: SAVE_JOURNAL_VERSION,
    source: "cube.stl",
    saveId: "save-1",
    startedAt: "2026-09-26T00:00:00.000Z",
    format: "stl",
    bakedThrough: 1,
    preSaveSha256: PRE,
    bakedSha256: BAKED,
    ...overrides,
  };
}

describe("save journal parse/serialize", () => {
  it("round-trips exactly", () => {
    const j = journal();
    expect(parseSaveJournal(serializeSaveJournal(j))).toEqual(j);
  });

  it("round-trips a recorded resolution", () => {
    const j = journal({ resolution: "decided" });
    expect(parseSaveJournal(serializeSaveJournal(j))?.resolution).toBe("decided");
  });

  it("drops an unknown resolution rather than trusting it", () => {
    const text = JSON.stringify({ ...journal(), resolution: "nonsense" });
    expect(parseSaveJournal(text)?.resolution).toBeUndefined();
  });

  it("returns null for malformed, truncated or non-object input", () => {
    expect(parseSaveJournal("")).toBeNull();
    expect(parseSaveJournal("{")).toBeNull();
    expect(parseSaveJournal("[]")).toBeNull();
    expect(parseSaveJournal("null")).toBeNull();
    expect(parseSaveJournal("42")).toBeNull();
  });

  it("rejects a journal missing any required field", () => {
    for (const key of ["source", "saveId", "startedAt", "format", "preSaveSha256", "bakedSha256"] as const) {
      const text = JSON.stringify({ ...journal(), [key]: undefined });
      expect(parseSaveJournal(text), `missing ${key}`).toBeNull();
      expect(parseSaveJournal(JSON.stringify({ ...journal(), [key]: "" })), `empty ${key}`).toBeNull();
    }
  });

  it("rejects a malformed hash, a wrong version and a bad watermark", () => {
    expect(parseSaveJournal(JSON.stringify({ ...journal(), preSaveSha256: "abc" }))).toBeNull();
    expect(parseSaveJournal(JSON.stringify({ ...journal(), bakedSha256: "A".repeat(64) }))).toBeNull();
    expect(parseSaveJournal(JSON.stringify({ ...journal(), version: 2 }))).toBeNull();
    expect(parseSaveJournal(JSON.stringify({ ...journal(), bakedThrough: 1.5 }))).toBeNull();
    expect(parseSaveJournal(JSON.stringify({ ...journal(), bakedThrough: -1 }))).toBeNull();
  });

  it("hashes real bytes", () => {
    expect(hashBytes(Buffer.from("abc"))).toHaveLength(64);
    expect(hashBytes(Buffer.from("abc"))).toBe(hashBytes(Buffer.from("abc")));
    expect(hashBytes(Buffer.from("abc"))).not.toBe(hashBytes(Buffer.from("abd")));
  });
});

describe("planRecovery", () => {
  it("does nothing when there is no journal", () => {
    expect(planRecovery({ journal: null, sidecarBakedThrough: 0, sidecarOpsCount: 1, sourceSha256: BAKED, backupSha256: null })).toEqual({
      action: "none",
      reason: "no-journal",
    });
  });

  it("finishes the save when the source provably holds the baked bytes", () => {
    expect(
      planRecovery({ journal: journal(), sidecarBakedThrough: 0, sidecarOpsCount: 1, sourceSha256: BAKED, backupSha256: PRE })
    ).toEqual({ action: "finish" });
  });

  it("discards the journal when the source still holds its pre-save bytes", () => {
    expect(
      planRecovery({ journal: journal(), sidecarBakedThrough: 0, sidecarOpsCount: 1, sourceSha256: PRE, backupSha256: PRE })
    ).toEqual({ action: "discard" });
  });

  it("treats a crash between the watermark write and the journal removal as already advanced", () => {
    expect(
      planRecovery({ journal: journal(), sidecarBakedThrough: 1, sidecarOpsCount: 1, sourceSha256: BAKED, backupSha256: PRE })
    ).toEqual({ action: "none", reason: "already-advanced" });
    // Also when the sidecar has moved past the journal (a later save, then a
    // stale journal) — the watermark is ahead, so nothing to reconcile.
    expect(
      planRecovery({ journal: journal(), sidecarBakedThrough: 3, sidecarOpsCount: 3, sourceSha256: BAKED, backupSha256: null })
    ).toEqual({ action: "none", reason: "already-advanced" });
  });

  it("asks when the source matches neither hash, offering the backup only when it is this transaction's pre-save bytes", () => {
    const other = "c".repeat(64);
    expect(
      planRecovery({ journal: journal(), sidecarBakedThrough: 0, sidecarOpsCount: 1, sourceSha256: other, backupSha256: PRE })
    ).toEqual({ action: "ask", canRestoreBackup: true });
    // A `.bak` from an earlier save in the session is NOT this transaction's
    // pre-save state — restoring it would silently discard that earlier save.
    expect(
      planRecovery({ journal: journal(), sidecarBakedThrough: 0, sidecarOpsCount: 1, sourceSha256: other, backupSha256: BAKED })
    ).toEqual({ action: "ask", canRestoreBackup: false });
    expect(
      planRecovery({ journal: journal(), sidecarBakedThrough: 0, sidecarOpsCount: 1, sourceSha256: other, backupSha256: null })
    ).toEqual({ action: "ask", canRestoreBackup: false });
  });

  it("refuses to finish past a sidecar that no longer holds enough ops", () => {
    // The source IS the baked bytes, but the sidecar holds fewer ops than the
    // journal's watermark — a hand-edited or truncated sidecar. Advancing it
    // would hand the document a watermark past its own op list, so fall
    // through to the ask branch instead of finishing.
    expect(
      planRecovery({ journal: journal({ bakedThrough: 3 }), sidecarBakedThrough: 0, sidecarOpsCount: 1, sourceSha256: BAKED, backupSha256: PRE })
        .action
    ).toBe("ask");
    // With no usable backup either, the ask carries no repair offer.
    expect(
      planRecovery({ journal: journal({ bakedThrough: 3 }), sidecarBakedThrough: 0, sidecarOpsCount: 1, sourceSha256: BAKED, backupSha256: null })
    ).toEqual({ action: "ask", canRestoreBackup: false });
  });

  it("prefers the already-resolved short-circuit over everything else", () => {
    // A recorded decision wins even though the source matches the baked bytes —
    // the user already chose, so re-asking (or re-acting) would be wrong.
    expect(
      planRecovery({ journal: journal({ resolution: "decided" }), sidecarBakedThrough: 0, sidecarOpsCount: 1, sourceSha256: BAKED, backupSha256: PRE })
    ).toEqual({ action: "none", reason: "already-resolved" });
    expect(
      planRecovery({ journal: journal({ resolution: "deferred" }), sidecarBakedThrough: 0, sidecarOpsCount: 1, sourceSha256: BAKED, backupSha256: PRE })
    ).toEqual({ action: "none", reason: "already-resolved" });
  });

  it("is idempotent: every outcome leaves a second call with nothing to do", () => {
    // Recovery deletes the journal (or records a resolution) when it acts, so a
    // second open must find nothing pending. Simulate each post-state.
    const secondPass = (first: ReturnType<typeof planRecovery>, firstJournal: SaveJournal, after: Partial<SaveJournal>) => {
      const settled: SaveJournal = after.resolution ? { ...firstJournal, ...after } : firstJournal;
      const second = planRecovery({
        journal: settled.resolution ? settled : null,
        sidecarBakedThrough: first.action === "finish" ? settled.bakedThrough : 0,
        sidecarOpsCount: settled.bakedThrough,
        sourceSha256: first.action === "finish" ? settled.bakedSha256 : settled.preSaveSha256,
        backupSha256: settled.preSaveSha256,
      });
      expect(second.action).toBe("none");
    };
    const j = journal();
    secondPass(planRecovery({ journal: j, sidecarBakedThrough: 0, sidecarOpsCount: 1, sourceSha256: BAKED, backupSha256: PRE }), j, {});
    secondPass(planRecovery({ journal: j, sidecarBakedThrough: 0, sidecarOpsCount: 1, sourceSha256: PRE, backupSha256: PRE }), j, {});
    secondPass(planRecovery({ journal: j, sidecarBakedThrough: 0, sidecarOpsCount: 1, sourceSha256: "c".repeat(64), backupSha256: PRE }), j, {
      resolution: "decided",
    });
    secondPass(planRecovery({ journal: j, sidecarBakedThrough: 0, sidecarOpsCount: 1, sourceSha256: "c".repeat(64), backupSha256: null }), j, {
      resolution: "deferred",
    });
  });
});

describe("recoveryMessage", () => {
  it("has wording for every action and none for a no-op", () => {
    expect(recoveryMessage({ action: "none", reason: "no-journal" }, "cube.stl", "cube.stl.bak")).toBeNull();
    expect(recoveryMessage({ action: "finish" }, "cube.stl", "cube.stl.bak")).toMatch(/completed/i);
    expect(recoveryMessage({ action: "discard" }, "cube.stl", "cube.stl.bak")).toMatch(/never rewritten/i);
    expect(recoveryMessage({ action: "ask", canRestoreBackup: true }, "cube.stl", "cube.stl.bak")).toMatch(/cube\.stl\.bak/);
    expect(recoveryMessage({ action: "ask", canRestoreBackup: false }, "cube.stl", "cube.stl.bak")).toMatch(/Nothing has been changed/);
  });
});
