import { describe, it, expect } from "vitest";
import * as path from "path";
import { batchReportHtml, batchTsv, outputNameFor, resolveCollision, runBatch } from "./batchExport";

describe("outputNameFor", () => {
  it("strips a compound extension and fills the pattern", () => {
    expect(outputNameFor("/a/bracket.stp", "iges")).toBe("bracket.iges");
    expect(outputNameFor("/a/two-tets.post.msh", "svg")).toBe("two-tets.svg");
    expect(outputNameFor("/a/b.stp", "dxf", "{stem}-sheet.{ext}")).toBe("b-sheet.dxf");
    expect(outputNameFor("/a/b.stp", "brep", "{name}.{ext}")).toBe("b.stp.brep");
    expect(() => outputNameFor("/a/b.stp", "x", "../{stem}")).toThrow(/bare file name/);
  });
});

describe("resolveCollision", () => {
  const none = () => false;
  it("never overwrites an input, whatever the policy", () => {
    const inputs = new Set([path.resolve("/w/a.step")]);
    expect(resolveCollision("/w/a.step", "overwrite", none, inputs, new Set()).path).toBeNull();
    expect(resolveCollision("/w/a.step", "skip", none, inputs, new Set()).path).toBeNull();
    expect(resolveCollision("/w/a.step", "suffix", none, inputs, new Set()).path).toBe("/w/a-2.step");
  });
  it("follows the policy for an existing output", () => {
    const exists = (p: string) => p === "/o/a.step";
    expect(resolveCollision("/o/a.step", "skip", exists, new Set(), new Set()).reason).toMatch(/skipped/);
    expect(resolveCollision("/o/a.step", "overwrite", exists, new Set(), new Set()).path).toBe("/o/a.step");
    expect(resolveCollision("/o/a.step", "suffix", exists, new Set(), new Set()).path).toBe("/o/a-2.step");
  });
  it("never lets two batch files overwrite each other", () => {
    const taken = new Set([path.resolve("/o/a.step")]);
    expect(resolveCollision("/o/a.step", "overwrite", () => false, new Set(), taken).path).toBeNull();
    expect(resolveCollision("/o/a.step", "suffix", () => false, new Set(), taken).path).toBe("/o/a-2.step");
  });
});

describe("runBatch", () => {
  it("one bad file is a failed row; the others still export; the summary counts all", async () => {
    const written: string[] = [];
    const r = await runBatch(["/in/a.stp", "/in/bad.stp", "/in/c.stp"], {
      outDir: "/out",
      ext: "iges",
      exists: () => false,
      exportOne: async (input, out) => {
        if (input.includes("bad")) throw new Error("STEP ReadFile failed (code 2)\nstack…");
        written.push(out);
        return { outputs: [out], editsBaked: input.includes("a") ? 2 : 0, warnings: [] };
      },
    });
    expect(r.rows.map((x) => x.status)).toEqual(["ok", "failed", "ok"]);
    expect(r.rows[1].error).toBe("STEP ReadFile failed (code 2)");
    expect(written).toEqual(["/out/a.iges", "/out/c.iges"]);
    expect(r.summary).toEqual({ total: 3, ok: 2, failed: 1, skipped: 0, cancelled: 0 });
    expect(r.rows[0].editsBaked).toBe(2);
  });
  it("retries ONCE after a kernel reset, and the retry succeeds", async () => {
    // The real CI failure: OCCT aborted with a memory-access error, the kernel
    // client reset the singleton, and the batch recorded the good file as
    // failed. The client respawns a fresh worker, so one clean retry recovers.
    let calls = 0;
    const r = await runBatch(["/in/a.stp"], {
      outDir: "/out",
      ext: "brep",
      exists: () => false,
      exportOne: async (_input, out) => {
        calls++;
        if (calls === 1) throw new Error("OCCT crashed (memory access out of bounds) — the kernel has been reset; try the operation again.");
        return { outputs: [out], editsBaked: 0, warnings: [] };
      },
    });
    expect(calls).toBe(2);
    expect(r.rows[0].status).toBe("ok");
    expect(r.summary).toEqual({ total: 1, ok: 1, failed: 0, skipped: 0, cancelled: 0 });
  });
  it("does NOT retry a second reset — that is a real failure, recorded once", async () => {
    let calls = 0;
    const r = await runBatch(["/in/a.stp"], {
      outDir: "/out",
      ext: "brep",
      exists: () => false,
      exportOne: async () => {
        calls++;
        throw new Error("OCCT crashed (memory access out of bounds) — the kernel has been reset; try the operation again.");
      },
    });
    expect(calls).toBe(2);
    expect(r.rows[0].status).toBe("failed");
    expect(r.rows[0].error).toMatch(/kernel has been reset/);
  });
  it("does NOT retry an ordinary error", async () => {
    let calls = 0;
    const r = await runBatch(["/in/a.stp"], {
      outDir: "/out",
      ext: "brep",
      exists: () => false,
      exportOne: async () => {
        calls++;
        throw new Error("STEP ReadFile failed (code 2)");
      },
    });
    expect(calls).toBe(1);
    expect(r.rows[0].status).toBe("failed");
  });
  it("the retry reuses the already-resolved path, so it cannot collide onto a new name", async () => {
    const written: string[] = [];
    let calls = 0;
    await runBatch(["/in/a.stp"], {
      outDir: "/out",
      ext: "brep",
      exists: () => false,
      exportOne: async (_input, out) => {
        calls++;
        // A partial file from the aborted attempt must not push the retry onto a
        // suffixed name — the path is resolved once, before the first attempt.
        if (calls === 1) throw new Error("the kernel has been reset");
        written.push(out);
        return { outputs: [out], editsBaked: 0, warnings: [] };
      },
    });
    expect(written).toEqual(["/out/a.brep"]);
  });
  it("two inputs with the same stem don't collide under skip — the second is skipped, never overwrites", async () => {
    const r = await runBatch(["/x/p.stp", "/y/p.step"], {
      outDir: "/out",
      ext: "brep",
      exists: () => false,
      exportOne: async (_i, out) => ({ outputs: [out], editsBaked: 0, warnings: [] }),
    });
    expect(r.rows.map((x) => x.status)).toEqual(["ok", "skipped"]);
  });
  it("cancellation stops before the next file and reports the rest", async () => {
    let n = 0;
    const r = await runBatch(["/a.stp", "/b.stp", "/c.stp"], {
      outDir: "/o",
      ext: "brep",
      exists: () => false,
      isCancelled: () => n >= 1,
      exportOne: async (_i, out) => {
        n++;
        return { outputs: [out], editsBaked: 0, warnings: [] };
      },
    });
    expect(r.rows.map((x) => x.status)).toEqual(["ok", "cancelled", "cancelled"]);
    expect(r.summary.cancelled).toBe(2);
  });
  it("renders a TSV with one row per input", async () => {
    const tsv = batchTsv([{ input: "/a.stp", status: "failed", outputs: [], editsBaked: 0, error: "bad\ttab", warnings: [] }]);
    expect(tsv.split("\n")[1]).toBe("/a.stp\tfailed\t\t0\tbad tab\t");
  });
});

describe("batchReportHtml", () => {
  it("escapes document-derived text and has no scripts or external URLs", () => {
    const html = batchReportHtml(
      [{ input: "/a/<b>.stp", status: "failed", outputs: [], editsBaked: 0, error: "bad <script>", warnings: ["w&1"] }],
      { total: 1, ok: 0, failed: 1, skipped: 0, cancelled: 0 },
      "Batch"
    );
    expect(html).toContain("&lt;b&gt;.stp");
    expect(html).toContain("bad &lt;script&gt;");
    expect(html).toContain("⚠ w&amp;1");
    expect(html).not.toMatch(/<script|https?:/);
    expect(html).toContain("0 ok · 1 failed");
  });
});
