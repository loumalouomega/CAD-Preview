/**
 * Executable doc examples — roadmap item 12 Phase 1.
 *
 * Extracts the ```parametric fenced blocks from a markdown tree so a test can
 * compile each one through the real {@link compileParametricScript}. Without
 * this, every JSON example in `doc/**` is unverified: a renamed op field or a
 * dropped `EditOpKind` leaves a confidently-wrong example in place with the
 * whole suite still green.
 *
 * **The fence language is the opt-in marker**, per block. A ```json block stays
 * illustrative and is never executed — `doc/protocol.md`'s message envelopes
 * and `doc/file-formats.md`'s sidecar-file examples are *not* op payloads and
 * must not be compiled as if they were. An author opts a block in by tagging it
 * `parametric`.
 *
 * Pure: no vscode, no WASM, no DOM. `readDocExamples` is the only function that
 * touches the filesystem, and only to read. Nothing in `src/`'s four bundle
 * entry points imports this module, so esbuild never sees it — it lives here
 * beside every other pure module rather than under `scripts/` so that item 12
 * Phase 2's coverage gate can share the same tree walk.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The fence info-string that opts a block in. */
export const EXAMPLE_FENCE = "parametric";

export interface DocExample {
  /** Path as given to the walker, relative and POSIX-separated (`mcp-server.md`). */
  file: string;
  /** 1-based line of the opening fence — so a failure reads `file.md:210`. */
  line: number;
  /** The block's raw body, fence lines excluded. */
  source: string;
}

/**
 * Every ```parametric block in one markdown document.
 *
 * Deliberately a line scanner rather than a markdown parser: the repo has no
 * markdown AST dependency, and the only thing that needs recognising is a fence
 * whose info-string is exactly {@link EXAMPLE_FENCE}. Indented fences (inside a
 * list item) are supported; an unterminated fence yields no block rather than
 * throwing, since a malformed doc must not crash the walk.
 */
export function extractDocExamples(file: string, text: string): DocExample[] {
  const lines = text.split(/\r?\n/);
  const out: DocExample[] = [];
  // Tracks EVERY fenced block, not just the parametric ones: a page that
  // documents this convention necessarily shows a ```parametric fence nested
  // inside a longer outer fence, and that inner line must not open a block.
  let open: { line: number; indent: number; marker: string; capture: boolean; body: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(raw);

    if (open) {
      // A closing fence uses the same marker character, is at least as long,
      // and carries no info string.
      const closes = fence !== null
        && fence[2][0] === open.marker[0]
        && fence[2].length >= open.marker.length
        && fence[3].trim() === "";
      if (closes) {
        if (open.capture) out.push({ file, line: open.line, source: open.body.join("\n") });
        open = null;
      } else if (open.capture) {
        open.body.push(raw.slice(open.indent));
      }
      continue;
    }

    if (fence) {
      const info = fence[3].trim().toLowerCase();
      open = { line: i + 1, indent: fence[1].length, marker: fence[2], capture: info === EXAMPLE_FENCE, body: [] };
    }
  }
  return out;
}

/**
 * Walks `root` for `*.md` and returns every example, ordered by file then line.
 * Recurses into subdirectories (so `doc/tutorials/` is covered) but skips
 * VitePress's own `.vitepress/` build/config tree and any dotted directory.
 */
export function readDocExamples(root: string): DocExample[] {
  const out: DocExample[] = [];
  const walk = (dir: string, prefix: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(...extractDocExamples(rel, fs.readFileSync(full, "utf8")));
      }
    }
  };
  walk(root, "");
  return out;
}

/**
 * A `parametric` block may be written in either of the two shapes the docs
 * naturally use, and both compile through the one existing compiler:
 *
 * - `{variables?, steps}` — a `run_parametric_script` document, used as-is.
 * - `[{op…}, {op…}]` — a bare op array, which is literally an `apply_edit_ops`
 *   `ops` payload and is what a tutorial's "Full operation list" is. Wrapped
 *   into `{steps: [...]}`.
 *
 * Returns a `problem` string instead of throwing, so the caller reports a
 * useful assertion message rather than a stack trace.
 */
export function parseDocExample(source: string): { script: unknown } | { problem: string } {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (err) {
    return { problem: `not valid JSON — ${err instanceof Error ? err.message : String(err)}` };
  }
  if (Array.isArray(data)) return { script: { steps: data.map((op) => ({ op })) } };
  if (data && typeof data === "object") {
    if (!Array.isArray((data as { steps?: unknown }).steps)) {
      return { problem: "an object example must be a {variables?, steps} script — no `steps` array found" };
    }
    return { script: data };
  }
  return { problem: `expected an op array or a {variables?, steps} object, got ${data === null ? "null" : typeof data}` };
}
