import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  findBareOrdinalCitations,
  readScannedFiles,
  checkRoadmapCitations,
} from "./docRoadmapRefs";

/**
 * Pure half first (fixture maps, no filesystem), then one fixture-TREE run,
 * then the real-tree gate — the same three-layer shape as
 * `docOpCoverage.test.ts`.
 */

const table = (rows: [string, string][]) => new Map(rows);

function cites(rows: [string, string][]) {
  return findBareOrdinalCitations(table(rows));
}

describe("findBareOrdinalCitations", () => {
  it("flags a bare ordinal citation", () => {
    expect(cites([["a.ts", "// see roadmap item 8 for the details"]])).toEqual([
      {
        file: "a.ts",
        line: 1,
        token: "roadmap item 8",
        text: "// see roadmap item 8 for the details",
      },
    ]);
  });

  it("flags tier-item compound forms and phase suffixes", () => {
    expect(cites([["a.mjs", "roadmap Tier 2 item 1"]]).length).toBe(1);
    expect(cites([["a.mjs", "roadmap item 10 Phase 2"]]).length).toBe(1);
    expect(cites([["a.ts", "roadmap tier 9"]]).length).toBe(1); // case-insensitive
  });

  it("does not flag a citation whose feature NAME is quoted on the same line", () => {
    expect(cites([["a.ts", 'roadmap Tier 1 "Zoom to selection"']]).length).toBe(0);
    expect(cites([["a.ts", 'the "Cheap thin-wrapper ops" feature']]).length).toBe(0);
  });

  it("does not flag a name that wraps onto the immediately-following line", () => {
    const it_flags = cites([
      [
        "a.ts",
        "// Assembly group rows expand to their descendant leaves (roadmap Tier 1\n// \"Assembly-tree group rows are inert\") — preserves the old single-id behavior.",
      ],
    ]);
    expect(it_flags.length).toBe(0);
  });

  it("does not reject a quoted HISTORICAL example", () => {
    expect(cites([['a.ts', 'the earlier write-up asks for "roadmap item 5" quoted above']]).length).toBe(0);
    expect(cites([["a.md", 'prose asking about "roadmap item 5" never gets flagged']]).length).toBe(0);
  });

  it("reports 1-based lines so failures read file:line", () => {
    const one = cites([
      ["a.md", "safe\n"],
      ["b.ts", "safe\nsafe\nroadmap item 9\n"],
    ]);
    expect(one.map((x) => `${x.file}:${x.line}`)).toEqual(["b.ts:3"]);
  });
});

describe("readScannedFiles + checkRoadmapCitations (fixture tree)", () => {
  it("walks doc/src/scripts and skips excluded dirs and historical records", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-refs-"));
    try {
      fs.mkdirSync(path.join(root, "doc"), { recursive: true });
      fs.mkdirSync(path.join(root, "src", "webview"), { recursive: true });
      fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
      fs.mkdirSync(path.join(root, "scripts", "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(root, "doc", "a.md"), "clean prose\n", "utf8");
      fs.writeFileSync(path.join(root, "src", "webview", "b.ts"), "clean code\n", "utf8");
      fs.writeFileSync(path.join(root, "scripts", "c.mjs"), "clean script\n", "utf8");
      fs.writeFileSync(path.join(root, "CLAUDE.md"), "roadmap item 3\n", "utf8"); // excluded
      fs.writeFileSync(path.join(root, "CHANGELOG.md"), "roadmap item 3\n", "utf8"); // excluded
      fs.writeFileSync(path.join(root, "doc", "guide.md"), "with a citation: see roadmap item 3\n", "utf8");
      fs.writeFileSync(path.join(root, "scripts", "node_modules", "skip.ts"), "roadmap item 3\n", "utf8"); // excluded dir
      const files = readScannedFiles(root);
      expect(files.has("doc/a.md")).toBe(true);
      expect(files.has("doc/guide.md")).toBe(true);
      expect(files.has("src/webview/b.ts")).toBe(true);
      expect(files.has("scripts/c.mjs")).toBe(true);
      expect(files.has("CLAUDE.md")).toBe(false);
      expect(files.has("CHANGELOG.md")).toBe(false);
      expect(files.has("scripts/node_modules/skip.ts")).toBe(false);
      const hits = checkRoadmapCitations(root);
      expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual(["doc/guide.md:1"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The real-tree gate — the codebase must be at ZERO bare-ordinal citations.
 * Written AFTER the cleanup pass, so it pins the state. Its failure message
 * names file+line, mirroring `docOpCoverage.test.ts`'s shape.
 */
describe("checkRoadmapCitations (the real tree)", () => {
  it("finds 0 bare-ordinal roadmap citations across code, docs and scripts", () => {
    const ROOT = path.join(__dirname, "..");
    const hits = checkRoadmapCitations(ROOT);
    expect(hits).toEqual([]);
  });
});
