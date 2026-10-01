import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  findGapNotes,
  allMarkerIds,
  harnessTestTitles,
  parseRegistry,
  checkGaps,
  unresolvedCount,
  type GapRegistry,
  type GapEntry,
} from "./verificationGaps";

/**
 * Three layers, the same shape as `docOpCoverage.test.ts` / `docRoadmapRefs.test.ts`:
 * the pure functions over fixture text, the rule set over a hand-built registry
 * (every rule gets a case that makes it fail), then the real tree.
 */

const entry = (over: Partial<GapEntry> & { id: string }): GapEntry => ({ section: "s", gap: "g", status: "open", ...over });
const reg = (...entries: GapEntry[]): GapRegistry => ({ version: 1, entries });
const HARNESS = `
test("alpha: does a thing", async (page) => {});
test('beta: single quoted', async () => {});
  test("gamma: with \\"escaped\\" quotes", async () => {});
const notATest = foo.test("not-a-title");
`;

describe("findGapNotes", () => {
  it("finds the label forms this repo uses, and reads their markers", () => {
    const md = [
      "# Title",
      "- **Verification gap, stated plainly**: nothing was run. [vg:a]",
      "- **Still F5-only**: the feel. [vg:b,c]",
      "**Verification gap, stated plainly:** a bare paragraph form with no marker",
      "- **F5-only**: the form's feel. [vg:d]",
      "- **Remaining F5 gap, narrowed**: x [vg:e]",
      "Ordinary prose that mentions a verification gap in passing is not a note.",
      "- **Verified**: tests pass. (a different label)",
    ].join("\n");
    const notes = findGapNotes(md);
    expect(notes.map((n) => n.line)).toEqual([2, 3, 4, 5, 6]);
    expect(notes.map((n) => n.ids)).toEqual([["a"], ["b", "c"], [], ["d"], ["e"]]);
  });

  it("reads markers anywhere in the text for the orphan check", () => {
    expect([...allMarkerIds("x [vg:a] y\n- z [vg:b,c]")].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("harnessTestTitles", () => {
  it("reads both quote styles and unescapes, and ignores method calls named test", () => {
    const t = harnessTestTitles(HARNESS);
    expect(t.has("alpha: does a thing")).toBe(true);
    expect(t.has("beta: single quoted")).toBe(true);
    expect(t.has('gamma: with "escaped" quotes')).toBe(true);
    expect(t.has("not-a-title")).toBe(false);
  });
});

describe("parseRegistry", () => {
  it("rejects a malformed registry loudly rather than accepting it", () => {
    expect(() => parseRegistry("{}")).toThrow();
    expect(() => parseRegistry(JSON.stringify({ version: 1, entries: [{ id: "Bad Id", status: "open" }] }))).toThrow(/bad id/);
    expect(() => parseRegistry(JSON.stringify({ version: 1, entries: [{ id: "ok", status: "wat" }] }))).toThrow(/bad status/);
  });
});

describe("checkGaps — every rule fails when it should", () => {
  const md = "- **Verification gap**: x [vg:a]\n- **F5-only**: y [vg:b]\n";
  const base = () => ({
    claudeMd: md,
    registry: reg(entry({ id: "a" }), entry({ id: "b", status: "closed", closedBy: ["alpha: does a thing"] })),
    baseline: { open: 1 },
    harnessSources: [HARNESS],
  });

  it("passes on a consistent tree", () => {
    expect(checkGaps(base())).toEqual([]);
  });

  it("a gap note with no marker fails — a new unverified feature cannot land silently", () => {
    const i = base();
    i.claudeMd += "- **Verification gap, stated plainly**: a brand new feature, never run.\n";
    expect(checkGaps(i).join("\n")).toMatch(/no \[vg:<id>\] marker/);
  });

  it("a marker that names no registry entry fails", () => {
    const i = base();
    i.claudeMd += "- **F5-only**: z [vg:ghost]\n";
    expect(checkGaps(i).join("\n")).toMatch(/\[vg:ghost\], which is not in the registry/);
  });

  it("closing by a test that does not exist fails — renaming the covering test re-opens the debt", () => {
    const i = base();
    i.harnessSources = ["test(\"something else\", async () => {});"];
    expect(checkGaps(i).join("\n")).toMatch(/does not exist: "alpha: does a thing"/);
  });

  it("a closed entry that names no test fails", () => {
    const i = base();
    i.registry = reg(entry({ id: "a" }), entry({ id: "b", status: "closed" }));
    expect(checkGaps(i).join("\n")).toMatch(/names no covering test/);
  });

  it("test-written still COUNTS as unresolved", () => {
    const r = reg(entry({ id: "a", status: "test-written", closedBy: ["alpha: does a thing"] }), entry({ id: "b" }));
    expect(unresolvedCount(r)).toBe(2);
  });

  it("rising above the baseline fails; falling below it fails too, so the ratchet is kept", () => {
    const up = base();
    up.registry = reg(entry({ id: "a" }), entry({ id: "b" }));
    expect(checkGaps(up).join("\n")).toMatch(/rose to 2 \(baseline 1\)/);
    const down = base();
    down.baseline = { open: 2 };
    expect(checkGaps(down).join("\n")).toMatch(/fell to 1 \(baseline 2\)/);
  });

  it("an orphaned registry entry fails — it could not be audited from CLAUDE.md", () => {
    const i = base();
    i.registry = reg(...i.registry.entries, entry({ id: "orphan", status: "none", note: "n/a" }));
    expect(checkGaps(i).join("\n")).toMatch(/"orphan" is not referenced/);
  });

  it("status none must say why; duplicate ids fail", () => {
    const i = base();
    i.registry = reg(entry({ id: "a", status: "none" }), entry({ id: "a" }), entry({ id: "b", status: "closed", closedBy: ["alpha: does a thing"] }));
    const out = checkGaps(i).join("\n");
    expect(out).toMatch(/status none but gives no reason/);
    expect(out).toMatch(/duplicate registry id "a"/);
  });
});

describe("the real tree", () => {
  const ROOT = path.resolve(__dirname, "..");
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

  it("CLAUDE.md, the registry, the baseline and the harness test titles agree", () => {
    const problems = checkGaps({
      claudeMd: read("CLAUDE.md"),
      registry: parseRegistry(read("scripts/verification-gaps/registry.json")),
      baseline: JSON.parse(read("scripts/verification-gaps/baseline.json")),
      harnessSources: [read("scripts/webview-test/run.mjs"), read("test/integration/suite/index.ts")],
    });
    expect(problems).toEqual([]);
  });
});
