import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDocOpCoverage,
  extractOpMentions,
  parseOpCoverageAllowlist,
  readDocOpMentions,
} from "./docOpCoverage";
import { allOpKinds } from "./mcpTools";

// `__dirname`-relative, matching `docExamples.test.ts` and
// `gltfParser.crossvalidation.test.ts`.
const DOC_ROOT = path.join(__dirname, "..", "doc");
const ALLOWLIST_FILE = path.join(DOC_ROOT, "op-coverage-allowlist.txt");

const KINDS = ["addBox", "extrude", "rib", "section"] as const;

describe("extractOpMentions", () => {
  it("matches a backticked kind with its file and 1-based line", () => {
    const { mentions, stale } = extractOpMentions("a.md", "# T\n\nUse `addBox` here.\n", KINDS);
    expect(stale).toEqual([]);
    expect(mentions).toEqual([{ file: "a.md", line: 3, kind: "addBox" }]);
  });

  it("strips a trailing call-shape paren, so `rib()` counts for rib", () => {
    const { mentions } = extractOpMentions("a.md", "The `rib()` op builds a rib.\n", KINDS);
    expect(mentions).toEqual([{ file: "a.md", line: 1, kind: "rib" }]);
  });

  it("matches single- and double-quoted kinds (protocol tables, prose)", () => {
    const text = ["| { op: 'addBox'; center: Vec3 } |", 'The "extrude" op extrudes.'].join("\n");
    const { mentions } = extractOpMentions("a.md", text, KINDS);
    // The table row reports twice — once via the op-position channel, once
    // via the quoted channel. Harmless downstream (the gate reads a set),
    // pinned here so a dedupe change shows up deliberately, not silently.
    expect(mentions.map((m) => m.kind).sort()).toEqual(["addBox", "addBox", "extrude"]);
  });

  it("splits multi-kind spans (`extrude/revolve`, comma lists)", () => {
    const { mentions } = extractOpMentions("a.md", "See `extrude/revolve` and `addBox, rib`.\n", KINDS);
    expect(mentions.map((m) => m.kind).sort()).toEqual(["addBox", "extrude", "rib"]);
  });

  it("counts a parametric op value as a mention", () => {
    const { mentions, stale } = extractOpMentions("a.md", '```parametric\n[{ "op": "addBox" }]\n```\n', KINDS);
    expect(stale).toEqual([]);
    // Op-position + quoted channels overlap here too (see above).
    expect(mentions).toEqual([
      { file: "a.md", line: 2, kind: "addBox" },
      { file: "a.md", line: 2, kind: "addBox" },
    ]);
  });

  it("ignores bare prose and non-kind identifiers", () => {
    const text = "A section below describes scaling. See `solid-1` and `describe_capabilities`.\n";
    const { mentions, stale } = extractOpMentions("a.md", text, KINDS);
    expect(mentions).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("never goes stale on prose backticks — `wrap()` is a concept, not a claim", () => {
    const { mentions, stale } = extractOpMentions("a.md", "Unlike `wrap()`, this ships.\n", KINDS);
    expect(mentions).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("goes stale on op-position claims about removed kinds, both quote styles", () => {
    const text = ['[{ "op": "addBoxx" }]', "{ op: 'extrudee'; dir: Vec3 }"].join("\n");
    const { mentions, stale } = extractOpMentions("a.md", text, KINDS);
    expect(mentions).toEqual([]);
    expect(stale).toEqual([
      { file: "a.md", line: 1, claimed: "addBoxx" },
      { file: "a.md", line: 2, claimed: "extrudee" },
    ]);
  });
});

describe("parseOpCoverageAllowlist", () => {
  it("skips blanks and #-comments, keeping entries in order", () => {
    expect(parseOpCoverageAllowlist("# why\n\nrib\n# other\ndraft\n")).toEqual(["rib", "draft"]);
  });
});

describe("checkDocOpCoverage", () => {
  const mention = (kind: string) => ({ file: "a.md", line: 1, kind });

  it("passes a fully-documented catalog", () => {
    const mentions = KINDS.map(mention);
    expect(checkDocOpCoverage(KINDS, mentions, [], [])).toEqual({ missing: [], stale: [], unusedAllowlist: [] });
  });

  it("reports a documented-nowhere kind as missing", () => {
    const mentions = KINDS.filter((k) => k !== "rib").map(mention);
    const result = checkDocOpCoverage(KINDS, mentions, [], []);
    expect(result.missing).toEqual(["rib"]);
    expect(result.stale).toEqual([]);
  });

  it("an allowlist entry excuses a missing kind", () => {
    const mentions = KINDS.filter((k) => k !== "rib").map(mention);
    const result = checkDocOpCoverage(KINDS, mentions, [], ["rib"]);
    expect(result.missing).toEqual([]);
    expect(result.unusedAllowlist).toEqual([]);
  });

  it("an allowlist entry for a documented kind is unused", () => {
    const mentions = KINDS.map(mention);
    const result = checkDocOpCoverage(KINDS, mentions, [], ["rib"]);
    expect(result.unusedAllowlist).toEqual(["rib"]);
  });

  it("an allowlist entry for a removed kind is unused", () => {
    const result = checkDocOpCoverage(KINDS, KINDS.map(mention), [], ["addBoxx"]);
    expect(result.unusedAllowlist).toEqual(["addBoxx"]);
  });

  it("surfaces stale claims by claimed name", () => {
    const stale = [{ file: "a.md", line: 1, claimed: "addBoxx" }];
    const result = checkDocOpCoverage(KINDS, KINDS.map(mention), stale, []);
    expect(result.stale).toEqual(["addBoxx"]);
  });
});

describe("readDocOpMentions over a fixture tree", () => {
  it("walks nested files and skips dotted directories", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-coverage-"));
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      fs.mkdirSync(path.join(dir, ".hidden"));
      fs.writeFileSync(path.join(dir, "a.md"), "Use `addBox`.\n");
      fs.writeFileSync(path.join(dir, "sub", "b.md"), '`"op": "rib"`\n');
      fs.writeFileSync(path.join(dir, ".hidden", "c.md"), "`extrude`\n");
      fs.writeFileSync(path.join(dir, "notes.txt"), "`section`\n");
      const { mentions, stale } = readDocOpMentions(dir, KINDS);
      expect(stale).toEqual([]);
      // sub/b.md reports twice (op-position + quoted channels) — same
      // pinned overlap as the protocol-table case above.
      expect(mentions).toEqual([
        { file: "a.md", line: 1, kind: "addBox" },
        { file: "sub/b.md", line: 1, kind: "rib" },
        { file: "sub/b.md", line: 1, kind: "rib" },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The gate itself: every live op kind must be named somewhere in `doc/**`,
 * no op-position snippet may claim a kind that no longer exists, and the
 * allowlist must contain no entry that has rotted. Runs in `npm test`, so
 * it gates CI — a renamed kind or field breaks the build instead of quietly
 * rotting on a docs page.
 */
describe("doc op coverage over the real tree", () => {
  const kinds = allOpKinds();
  const { mentions, stale } = readDocOpMentions(DOC_ROOT, kinds);
  const allowlist = parseOpCoverageAllowlist(fs.readFileSync(ALLOWLIST_FILE, "utf8"));

  it("documents every live op kind", () => {
    const { missing } = checkDocOpCoverage(kinds, mentions, stale, allowlist);
    expect(missing, `undocumented op kinds: ${missing.join(", ")}`).toEqual([]);
  });

  it("claims no removed op kind in an op position", () => {
    const { stale: staleClaims } = checkDocOpCoverage(kinds, mentions, stale, allowlist);
    expect(staleClaims, `stale op claims: ${staleClaims.join(", ")}`).toEqual([]);
  });

  it("keeps no unused allowlist entry", () => {
    const { unusedAllowlist } = checkDocOpCoverage(kinds, mentions, stale, allowlist);
    expect(unusedAllowlist, `unused allowlist entries: ${unusedAllowlist.join(", ")}`).toEqual([]);
  });
});
