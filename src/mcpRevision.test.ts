import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  REVISION_GUARDED_TOOLS,
  StaleRevisionError,
  assertRevision,
  currentRevision,
  revisionsOf,
  withSidecarLock,
} from "./mcpRevision";
import { classifyToolError } from "./mcpErrors";
import { fingerprint } from "./sidecarRevision";
import { editsSidecarPath } from "./mcpSidecars";

let dir: string;
let model: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-rev-"));
  model = path.join(dir, "m.step");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("currentRevision", () => {
  it("is 'absent' for a missing sidecar and the sha256 of the bytes otherwise", async () => {
    expect(await currentRevision(model, "edits")).toBe("absent");
    await fs.writeFile(editsSidecarPath(model), "{}");
    const rev = await currentRevision(model, "edits");
    expect(rev).toBe(fingerprint(Buffer.from("{}")));
    expect(rev).not.toBe("absent");
    expect((await revisionsOf(model)).parts).toBe("absent");
  });

  it("changes only for the kind that was written", async () => {
    const before = await revisionsOf(model);
    await fs.writeFile(editsSidecarPath(model), "x");
    const after = await revisionsOf(model);
    expect(after.edits).not.toBe(before.edits);
    expect({ ...after, edits: "" }).toEqual({ ...before, edits: "" });
  });
});

describe("assertRevision", () => {
  it("passes on a match and throws a StaleRevisionError carrying the current revision on a mismatch", async () => {
    await fs.writeFile(editsSidecarPath(model), "a");
    const r1 = await currentRevision(model, "edits");
    await assertRevision(model, "edits", r1);
    await fs.writeFile(editsSidecarPath(model), "b");
    const r2 = await currentRevision(model, "edits");
    const err = await assertRevision(model, "edits", r1).catch((e) => e);
    expect(err).toBeInstanceOf(StaleRevisionError);
    expect(err.currentRevision).toBe(r2);
    expect(classifyToolError(err)).toMatchObject({ code: "stale-revision", retryable: false, currentRevision: r2 });
  });
});

describe("withSidecarLock", () => {
  it("serialises overlapping callers and survives a failing one", async () => {
    const order: string[] = [];
    const slow = withSidecarLock("k", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
    });
    const failing = withSidecarLock("k", async () => {
      order.push("b");
      throw new Error("boom");
    });
    const last = withSidecarLock("k", async () => {
      order.push("c");
    });
    await slow;
    await expect(failing).rejects.toThrow("boom");
    await last;
    expect(order).toEqual(["a-start", "a-end", "b", "c"]);
  });

  it("does not serialise different keys", async () => {
    const order: string[] = [];
    const a = withSidecarLock("x", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("x");
    });
    const b = withSidecarLock("y", async () => {
      order.push("y");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["y", "x"]);
  });
});

describe("REVISION_GUARDED_TOOLS", () => {
  it("maps each write tool to the sidecar it persists", () => {
    expect(REVISION_GUARDED_TOOLS).toMatchObject({
      apply_edit_ops: "edits",
      set_variables: "edits",
      set_part: "parts",
      set_plane: "planes",
      assign_layer: "layers",
      pin_annotation: "annotations",
      set_mesh_options: "mesh",
    });
  });
});
