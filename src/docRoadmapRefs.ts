/**
 * Keeps positional roadmap-item citations out of the tree, per
 * `doc/roadmap.md`'s own "How this file works" rule: task IDs (`1.1`, `4.10`)
 * are renumbered at each planning review, so code and other documents cite an
 * item by name, never by number.
 *
 * Pure (vscode/DOM/WASM-free), unit-tested. Scans the REAL source/doc tree
 * for **bare-ordinal** citations where the number is the only referent.
 * Exempt: mentions that carry the feature NAME in quotes on the same or
 * following line — the codebase's established announcement style — and a
 * citation sitting inside a quoted historical example (a fixture in the
 * test file covers both directions), so historical prose is never rejected.
 */

import * as fs from "fs";
import * as path from "path";
import { walkMarkdownFiles } from "./docExamples";

/** Any `roadmap item N` or `roadmap Tier N (item N …)` shaped citation. */
const ANY_ORDINAL_RE = /roadmap (?:item|tier) ?\d+(?: ?item ?\d+)*/gi;

/** One bare-ordinal sighting. */
export interface BareOrdinalCitation {
  file: string;
  /** 1-based line, so failures read `getting-started.md:418`. */
  line: number;
  token: string;
  /** The whole (trimmed) owning line, for an actionable failure message. */
  text: string;
}

/**
 * `"` after the number on the same line (`roadmap Tier 1 "Zoom to selection"`)
 * means the feature NAME is present — fine. The name also often wraps onto the
 * immediately-following line, which is treated the same way. An odd quote
 * count BEFORE the match means the citation sits inside a quoted historical
 * string — exempt too.
 */
function isBare(lines: string[], index: number, matchStart: number, tokenEnd: number): boolean {
  if (lines[index].slice(tokenEnd).includes('"')) return false;
  if (lines[index].slice(tokenEnd) === "" && (lines[index + 1] ?? "").includes('"')) return false;
  const head = lines[index].slice(0, matchStart);
  if ((head.match(/"/g) ?? []).length % 2 === 1) return false; // inside quotes
  return true;
}

/**
 * Finds every bare-ordinal citation in the given texts. `files` maps paths to
 * whole texts; iteration order is the report order. Pure — the caller (test
 * or the real-tree gate) decides WHICH files to feed it, keeping the scan
 * fixture-testable.
 */
export function findBareOrdinalCitations(
  files: ReadonlyMap<string, string>
): BareOrdinalCitation[] {
  const out: BareOrdinalCitation[] = [];
  for (const [file, text] of files) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const re = new RegExp(ANY_ORDINAL_RE.source, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(lines[i])) !== null) {
        if (isBare(lines, i, m.index, m.index + m[0].length)) {
          out.push({ file, line: i + 1, token: m[0], text: lines[i].trim() });
        }
      }
    }
  }
  return out;
}

const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".vscode-test"]);

/** Extensions admitted to the scan: CSS comments and YAML template text are
 * scanned too — a citation in prose is exactly the drift this check exists for. */
const SCANNED_EXTENSIONS = new Set([".md", ".ts", ".mjs", ".css", ".yml"]);

/**
 * The scan surface: `doc/` markdown + `src/` TypeScript/CSS + `scripts/` mjs
 * + `.github/` + the root-level files (README, esbuild, vscodeignore) and
 * `media/viewer.css` — explicitly NOT `CLAUDE.md`/`CHANGELOG.md` (both are
 * historical records where quoted historical examples legitimately live, and
 * the cleanup's stated scope is "code, docs and scripts"), and NOT
 * `*.test.ts` (a test fixture string is definitionally a quoted example).
 */
export function readScannedFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const add = (abs: string, rel: string): void => {
    if (rel.endsWith(".test.ts") || rel.endsWith(".test.mjs")) return;
    // `.vscodeignore` is extensionless, so the extension set below would skip
    // it despite the explicit root-file list naming it — include it by name.
    if (rel === ".vscodeignore" || SCANNED_EXTENSIONS.has(path.extname(rel))) {
      files.set(rel, fs.readFileSync(abs, "utf8"));
    }
  };
  const walk = (dir: string, rel: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDED_DIRS.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".github")) continue;
      const full = path.join(dir, entry.name);
      const relName = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relName);
      else if (entry.isFile()) add(full, relName);
    }
  };
  for (const dir of ["doc", "src", "scripts", ".github"]) {
    walk(path.join(root, dir), dir);
  }
  for (const rel of ["README.md", "esbuild.mjs", ".vscodeignore", "media/viewer.css"]) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) add(abs, rel);
  }
  return files;
}

/** The one real-tree entry point: scan, then report. */
export function checkRoadmapCitations(root: string): BareOrdinalCitation[] {
  return findBareOrdinalCitations(readScannedFiles(root));
}
