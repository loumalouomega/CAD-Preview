import { describe, expect, it, vi } from "vitest";
import { hashBytes, parseSaveJournal, serializeSaveJournal, type SaveJournal } from "./saveJournal";
import {
  beginMeshSave,
  endMeshSave,
  meshSavePaths,
  recoverInterruptedMeshSave,
  type MeshSavePaths,
} from "./meshSaveRecovery";
import type { ParsedEdits } from "./editsSidecar";
import type { MeshSaveRecoveryDeps } from "./meshSaveRecovery";
import type { EditOp } from "./editOps";
import type { ParamVariable } from "./editVariables";

/** Real distinct byte buffers, so every hash in this suite is a real SHA-256. */
const ORIGINAL = Buffer.from("original-geometry-0000000000", "utf8");
const BAKED = Buffer.from("baked-geometry-1111111111111111", "utf8");
const TORN = Buffer.from("baked-geometry-1111", "utf8");

const OP: EditOp = { op: "translate", targets: ["node-0"], vec: [100, 0, 0] };

/** The argument the recovery asks its caller about an unrecognised source. */
type AskInfo = Parameters<MeshSaveRecoveryDeps["askUnrecognised"]>[0];

interface Fs {
  files: Map<string, Uint8Array>;
}

function makeFs(): Fs {
  return { files: new Map() };
}

const PATHS: MeshSavePaths = meshSavePaths("cube.stl", "stl");

/**
 * An in-memory filesystem plus a fake sidecar. `sourceWriteCount` records how
 * many times the source was rewritten through `withSourceWrite`, which is how
 * the tests prove the restore branch suppresses the extension's own watcher.
 */
function makeDeps(
  fs: Fs,
  opts: { bakedThrough?: number; ops?: EditOp[]; ask?: MeshSaveRecoveryDeps["askUnrecognised"]; failWriteEdits?: boolean } = {}
) {
  const state = {
    sidecar: { ops: opts.ops ?? [OP], variables: [] as ParamVariable[], bakedThrough: opts.bakedThrough ?? 0 } satisfies ParsedEdits,
    sourceWrites: 0,
  };
  const deps: MeshSaveRecoveryDeps = {
    readBytes: async (p) => {
      const b = fs.files.get(p);
      if (!b) throw new Error(`ENOENT ${p}`);
      return b;
    },
    readBytesOrNull: async (p) => fs.files.get(p) ?? null,
    writeBytes: async (p, bytes) => {
      void fs.files.set(p, bytes);
    },
    renameOver: async (from, to) => {
      const b = fs.files.get(from);
      if (!b) throw new Error(`ENOENT ${from}`);
      fs.files.delete(from);
      fs.files.set(to, b);
    },
    deleteFile: async (p) => {
      if (!fs.files.delete(p)) throw new Error(`ENOENT ${p}`);
    },
    readEdits: async () => ({ ...state.sidecar }),
    writeEdits: async (ops, variables, bakedThrough) => {
      if (opts.failWriteEdits) throw new Error("sidecar locked");
      state.sidecar = { ops, variables, bakedThrough };
    },
    askUnrecognised: opts.ask ?? (async () => null),
    withSourceWrite: async (fn) => {
      state.sourceWrites += 1;
      return fn();
    },
  };
  return { deps, state };
}

function journalOnDisk(overrides: Partial<SaveJournal> = {}): string {
  return serializeSaveJournal({
    version: 1,
    source: "cube.stl",
    saveId: "save-1",
    startedAt: "2026-09-26T00:00:00.000Z",
    format: "stl",
    bakedThrough: 1,
    preSaveSha256: hashBytes(ORIGINAL),
    bakedSha256: hashBytes(BAKED),
    ...overrides,
  });
}

/** The four crash boundaries of a save, as they would be found on disk. */
function stageCrashPoint(point: "before-source" | "after-source" | "after-watermark" | "after-journal") {
  const fs = makeFs();
  fs.files.set(PATHS.source, point === "after-source" || point === "after-watermark" || point === "after-journal" ? BAKED : ORIGINAL);
  fs.files.set(PATHS.backup, ORIGINAL);
  fs.files.set(PATHS.journal, Buffer.from(journalOnDisk(), "utf8"));
  // A death between the temp write and the rename also leaves the temp behind.
  if (point === "before-source") fs.files.set(PATHS.temp, BAKED);
  return fs;
}

describe("meshSavePaths", () => {
  it("derives all four names as siblings of the source", () => {
    expect(PATHS).toEqual({
      source: "cube.stl",
      journal: "cube.stl.save-journal.json",
      backup: "cube.stl.bak",
      temp: "cube.save-tmp.stl",
    });
  });

  it("keeps a compound extension's stem in the temp name", () => {
    expect(meshSavePaths("beam.post.msh", "msh").temp).toBe("beam.post.save-tmp.msh");
  });
});

describe("recoverInterruptedMeshSave — every crash boundary", () => {
  it("finishes the save when the source holds the baked bytes and the watermark never landed", async () => {
    const fs = stageCrashPoint("after-source");
    const { deps, state } = makeDeps(fs);
    const result = await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);

    expect(result.action).toBe("finish");
    expect(result.sidecarChanged).toBe(true);
    expect(result.bakedThrough).toBe(1);
    expect(state.sidecar.bakedThrough).toBe(1);
    // The whole op list is kept — history preserved, only the watermark moved.
    expect(state.sidecar.ops).toEqual([OP]);
    expect(fs.files.has(PATHS.journal)).toBe(false);
    expect(result.message).toMatch(/completed/i);
  });

  it("discards the journal when the source was never rewritten", async () => {
    const fs = stageCrashPoint("before-source");
    const { deps, state } = makeDeps(fs);
    const result = await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);

    expect(result.action).toBe("discard");
    expect(result.bakedThrough).toBe(0);
    expect(state.sidecar.bakedThrough).toBe(0);
    // The temp sibling is swept — a death between writing it and renaming it.
    expect(fs.files.has(PATHS.temp)).toBe(false);
    expect(fs.files.has(PATHS.journal)).toBe(false);
    // The source is byte-identical: nothing was restored over it.
    expect(fs.files.get(PATHS.source)).toEqual(ORIGINAL);
    expect(result.message).toMatch(/never rewritten/i);
  });

  it("does nothing when the watermark already landed (only the journal removal was lost)", async () => {
    const fs = stageCrashPoint("after-watermark");
    const { deps, state } = makeDeps(fs, { bakedThrough: 1 });
    const result = await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);

    expect(result).toMatchObject({ action: "none", reason: "already-advanced", message: null });
    expect(state.sidecar.bakedThrough).toBe(1);
    expect(fs.files.has(PATHS.journal)).toBe(false);
    expect(fs.files.get(PATHS.source)).toEqual(BAKED);
  });

  it("does nothing when the journal itself is already gone", async () => {
    const fs = makeFs();
    fs.files.set(PATHS.source, BAKED);
    const { deps, state } = makeDeps(fs);
    const result = await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);
    expect(result).toMatchObject({ action: "none", reason: "no-journal" });
    expect(state.sidecar.bakedThrough).toBe(0);
  });

  it("leaves the geometry byte-identical at EVERY boundary — the two allowed end states", async () => {
    for (const point of ["before-source", "after-source", "after-watermark"] as const) {
      const fs = stageCrashPoint(point);
      const { deps, state } = makeDeps(fs, { bakedThrough: point === "after-watermark" ? 1 : 0 });
      await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);
      // The invariant: the on-disk source is EITHER the original OR the fully
      // baked file, and the watermark agrees about which.
      const onDisk = fs.files.get(PATHS.source)!;
      if (state.sidecar.bakedThrough === 0) expect(onDisk, point).toEqual(ORIGINAL);
      else expect(onDisk, point).toEqual(BAKED);
    }
  });

  it("is idempotent: a second recovery of the same crash changes nothing", async () => {
    const fs = stageCrashPoint("after-source");
    const { deps, state } = makeDeps(fs);
    const first = await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);
    const sourceAfterFirst = fs.files.get(PATHS.source);
    const second = await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);

    expect(first.action).toBe("finish");
    expect(second).toMatchObject({ action: "none", reason: "no-journal" });
    expect(fs.files.get(PATHS.source)).toEqual(sourceAfterFirst);
    expect(state.sidecar.bakedThrough).toBe(1);
  });
});

describe("recoverInterruptedMeshSave — the unrecognised source", () => {
  function stageTorn() {
    const fs = stageCrashPoint("after-source");
    fs.files.set(PATHS.source, TORN);
    return fs;
  }

  it("asks, and leaves everything untouched when the user keeps the file", async () => {
    const fs = stageTorn();
    const ask = vi.fn(async (_info: AskInfo) => "keep" as const);
    const { deps, state } = makeDeps(fs, { ask });
    const result = await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);

    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0][0]).toMatchObject({ fileName: "cube.stl", canRestoreBackup: true });
    expect(result.action).toBe("ask");
    expect(result.sourceChanged).toBe(false);
    expect(fs.files.get(PATHS.source)).toEqual(TORN);
    expect(state.sidecar.bakedThrough).toBe(0);
    // The journal is KEPT, carrying the recorded decision, so the evidence and
    // the "do not ask again" marker both survive.
    const kept = parseSaveJournal(Buffer.from(fs.files.get(PATHS.journal)!).toString("utf8"));
    expect(kept?.resolution).toBe("decided");
  });

  it("restores the pre-save backup through the watcher's suppression when offered", async () => {
    const fs = stageTorn();
    const { deps, state } = makeDeps(fs, { ask: async () => "restore" });
    const result = await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);

    expect(result.action).toBe("ask");
    expect(result.sourceChanged).toBe(true);
    expect(fs.files.get(PATHS.source)).toEqual(ORIGINAL);
    // One source write, and it went through withSourceWrite — without that the
    // extension's own file watcher would reload the document mid-recovery.
    expect(state.sourceWrites).toBe(1);
    expect(state.sidecar.bakedThrough).toBe(0);
  });

  it("refuses to restore when the .bak is not this transaction's pre-save bytes", async () => {
    // A second save in the same session: `.bak` still holds the pre-FIRST-save
    // bytes, so restoring it would silently discard that earlier save.
    const fs = stageTorn();
    fs.files.set(PATHS.backup, TORN);
    const ask = vi.fn(async (_info: AskInfo) => "restore" as const);
    const { deps } = makeDeps(fs, { ask });
    const result = await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);

    expect(ask.mock.calls[0][0]).toMatchObject({ canRestoreBackup: false });
    expect(result.sourceChanged).toBe(false);
    expect(fs.files.get(PATHS.source)).toEqual(TORN);
  });

  it("treats a dismissed prompt as a decision, never as a repair", async () => {
    const fs = stageTorn();
    const { deps, state } = makeDeps(fs, { ask: async () => null });
    const result = await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);

    expect(result.sourceChanged).toBe(false);
    expect(state.sourceWrites).toBe(0);
    expect(fs.files.get(PATHS.source)).toEqual(TORN);
    const kept = parseSaveJournal(Buffer.from(fs.files.get(PATHS.journal)!).toString("utf8"));
    expect(kept?.resolution).toBe("deferred");
  });

  it("does not prompt a second time", async () => {
    const fs = stageTorn();
    const ask = vi.fn(async (_info: AskInfo) => "keep" as const);
    const { deps } = makeDeps(fs, { ask });
    await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);
    const second = await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);

    expect(ask).toHaveBeenCalledOnce();
    expect(second).toMatchObject({ action: "none", reason: "already-resolved" });
  });

  it("still opens (and changes nothing) when the sidecar write is refused", async () => {
    const fs = stageCrashPoint("after-source");
    const { deps, state } = makeDeps(fs, { failWriteEdits: true });
    const result = await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);

    expect(result.sidecarChanged).toBe(false);
    expect(state.sidecar.bakedThrough).toBe(0);
    // The journal survives so a later open retries, and the document still opens.
    expect(fs.files.has(PATHS.journal)).toBe(true);
    expect(result.message).toMatch(/completed/i);
  });

  it("does nothing at all when the source cannot be read", async () => {
    const fs = makeFs();
    fs.files.set(PATHS.journal, Buffer.from(journalOnDisk(), "utf8"));
    const { deps, state } = makeDeps(fs);
    const result = await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);
    expect(result).toMatchObject({ action: "none", reason: "unreadable" });
    expect(state.sidecar.bakedThrough).toBe(0);
    expect(fs.files.has(PATHS.journal)).toBe(true);
  });

  it("treats a corrupt journal as no transaction at all", async () => {
    const fs = stageCrashPoint("after-source");
    fs.files.set(PATHS.journal, Buffer.from("{ truncated", "utf8"));
    const { deps, state } = makeDeps(fs);
    const result = await recoverInterruptedMeshSave(PATHS, "cube.stl", deps);
    expect(result).toMatchObject({ action: "none", reason: "no-journal" });
    expect(state.sidecar.bakedThrough).toBe(0);
  });
});

describe("beginMeshSave / endMeshSave", () => {
  it("opens a transaction whose journal carries both real hashes, then closes it", async () => {
    const fs = makeFs();
    fs.files.set(PATHS.source, ORIGINAL);
    const { deps } = makeDeps(fs);

    const journal = await beginMeshSave(
      { paths: PATHS, fileName: "cube.stl", format: "stl", bakedThrough: 1, preSaveBytes: ORIGINAL, bakedBytes: BAKED, writeBackup: true },
      deps
    );
    expect(journal.preSaveSha256).toBe(hashBytes(ORIGINAL));
    expect(journal.bakedSha256).toBe(hashBytes(BAKED));
    expect(journal.bakedThrough).toBe(1);
    expect(fs.files.get(PATHS.journal)).toBeDefined();
    expect(fs.files.get(PATHS.backup)).toEqual(ORIGINAL);

    await endMeshSave(PATHS, journal, deps);
    expect(fs.files.has(PATHS.journal)).toBe(false);
  });

  it("skips the .bak refresh when the session already made one", async () => {
    const fs = makeFs();
    fs.files.set(PATHS.source, BAKED);
    fs.files.set(PATHS.backup, ORIGINAL);
    const { deps } = makeDeps(fs);
    await beginMeshSave(
      { paths: PATHS, fileName: "cube.stl", format: "stl", bakedThrough: 2, preSaveBytes: BAKED, bakedBytes: BAKED, writeBackup: false },
      deps
    );
    expect(fs.files.get(PATHS.backup)).toEqual(ORIGINAL);
  });

  it("never deletes a NEWER transaction's journal (two editors, same source)", async () => {
    const fs = makeFs();
    const { deps } = makeDeps(fs);
    const first = await beginMeshSave(
      { paths: PATHS, fileName: "cube.stl", format: "stl", bakedThrough: 1, preSaveBytes: ORIGINAL, bakedBytes: BAKED, writeBackup: false },
      deps
    );
    // A second save opens its own transaction before the first one settles.
    const second = await beginMeshSave(
      { paths: PATHS, fileName: "cube.stl", format: "stl", bakedThrough: 2, preSaveBytes: BAKED, bakedBytes: BAKED, writeBackup: false },
      deps
    );
    expect(second.saveId).not.toBe(first.saveId);

    await endMeshSave(PATHS, first, deps);
    const still = parseSaveJournal(Buffer.from(fs.files.get(PATHS.journal)!).toString("utf8"));
    expect(still?.saveId).toBe(second.saveId);

    await endMeshSave(PATHS, second, deps);
    expect(fs.files.has(PATHS.journal)).toBe(false);
  });

  it("tolerates a journal that vanished before the close", async () => {
    const fs = makeFs();
    const { deps } = makeDeps(fs);
    const journal = await beginMeshSave(
      { paths: PATHS, fileName: "cube.stl", format: "stl", bakedThrough: 1, preSaveBytes: ORIGINAL, bakedBytes: BAKED, writeBackup: false },
      deps
    );
    fs.files.delete(PATHS.journal);
    await expect(endMeshSave(PATHS, journal, deps)).resolves.toBeUndefined();
  });
});
