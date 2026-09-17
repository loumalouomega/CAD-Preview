import { beforeEach, describe, expect, it } from "vitest";
import { Uri, __readFileText, __resetVscodeStub, __seedFile, workspace } from "./vscodeStub";
import { restoreCustomBackup, writeCustomBackup } from "./customBackup";

const MODEL = Uri.file("/work/block.stp");
const EDITS = Uri.file("/work/block.stp.edits.json");
const PARTS = Uri.file("/work/block.stp.parts.json");
const DEST = Uri.file("/backup/1");

beforeEach(() => {
  __resetVscodeStub();
});

describe("writeCustomBackup", () => {
  it("snapshots the source plus whichever sidecars exist", async () => {
    __seedFile(MODEL, "SOURCE-BYTES");
    __seedFile(EDITS, '{"ops":[]}');
    // PARTS deliberately absent — a panel never touched simply has no sidecar.
    const backup = await writeCustomBackup(MODEL, [EDITS, PARTS], DEST);
    expect(backup.id).toBe(DEST.fsPath);
    expect(__readFileText(Uri.joinPath(DEST, "source.bin"))).toBe("SOURCE-BYTES");
    expect(__readFileText(Uri.joinPath(DEST, "block.stp.edits.json"))).toBe('{"ops":[]}');
    expect(workspace.fs.files.has("/backup/1/block.stp.parts.json")).toBe(false);
    const manifest = JSON.parse(__readFileText(Uri.joinPath(DEST, "manifest.json")));
    expect(manifest.source).toBe("block.stp");
    expect(manifest.sidecars).toEqual(["block.stp.edits.json"]);
    backup.delete();
  });

  it("writes only a manifest when nothing exists yet", async () => {
    const backup = await writeCustomBackup(MODEL, [EDITS], DEST);
    expect(JSON.parse(__readFileText(Uri.joinPath(DEST, "manifest.json"))).sidecars).toEqual([]);
    backup.delete();
  });
});

describe("restoreCustomBackup", () => {
  it("copies the snapshot back over the workspace files", async () => {
    __seedFile(MODEL, "SOURCE-BYTES");
    __seedFile(EDITS, '{"ops":[1]}');
    __seedFile(PARTS, '{"parts":[2]}');
    const backup = await writeCustomBackup(MODEL, [EDITS, PARTS], DEST);
    // Mutate the workspace past the snapshot (unsaved tail + a dirty sidecar).
    __seedFile(MODEL, "MUTATED");
    __seedFile(EDITS, '{"ops":[1,2,3]}');
    await restoreCustomBackup(backup.id, MODEL);
    expect(__readFileText(MODEL)).toBe("SOURCE-BYTES");
    expect(__readFileText(EDITS)).toBe('{"ops":[1]}');
    expect(__readFileText(PARTS)).toBe('{"parts":[2]}');
    backup.delete();
  });

  it("throws on a missing or corrupt snapshot (callers fail open)", async () => {
    await expect(restoreCustomBackup("/backup/never-written", MODEL)).rejects.toThrow();
    __seedFile(Uri.joinPath(Uri.file("/backup/bad"), "manifest.json"), "not json{{{");
    await expect(restoreCustomBackup("/backup/bad", MODEL)).rejects.toThrow();
  });
});
