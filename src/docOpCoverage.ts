/**
 * Coverage gate for agent-facing docs — roadmap Tier 3 item 4, Phase 2.
 *
 * Phase 1 (`docExamples.ts`) executes every ```parametric block; what it
 * cannot see is *coverage* — an op kind documented nowhere fails nothing.
 * This module checks the live op catalog (whatever `allOpKinds()` returns,
 * i.e. `describeCapabilities()`'s own symbol list — no second registry)
 * against every mention in `doc/**`, with three failure modes, not one:
 *
 * - **missing**: a live kind named nowhere in the docs.
 * - **stale**: a doc snippet asserting an op kind that no longer exists —
 *   the half that catches renames, and the half most such gates omit.
 * - **unused-allowlist**: an opt-out entry that is now documented or no
 *   longer exported, so the escape hatch garbage-collects itself.
 *
 * A "mention" is deliberately narrow: an exact kind token inside a backtick
 * span or a single/double-quoted string (line-bounded, so a prose apostrophe
 * can never open a span that swallows the rest of the paragraph), or the
 * value of an `"op"` / `{ op:` JSON field. Bare prose never counts —
 * common words like `section`, `scale`, or `mirror` would otherwise match
 * everywhere and the gate would prove nothing. A trailing `()` is stripped,
 * so `` `rib()` `` counts for `rib`.
 *
 * Stale comes ONLY from op-position channels (`"op": "X"`, `{ op: 'X'`),
 * never from prose backticks: `` `wrap()` ``, `.guides()`, and `.drill()`
 * are legitimate discussions of unshipped concepts, not claims about the
 * op model, and flagging them would be a false positive. A rename that
 * only survives in prose is still caught — via `missing`, since the new
 * name appears nowhere.
 *
 * Pure: no vscode, no WASM, no DOM. The tree walk is shared with
 * `docExamples.ts` (`walkMarkdownFiles`); nothing in `src/`'s bundle entry
 * points imports this module, so esbuild never sees it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { walkMarkdownFiles } from "./docExamples";

/** One sighting of a live op kind in the docs. */
export interface DocOpMention {
  /** Path as given to the walker, relative and POSIX-separated. */
  file: string;
  /** 1-based line number — so a failure reads `getting-started.md:418`. */
  line: number;
  /** The live kind named. */
  kind: string;
}

/** An `"op"`-position claim about a kind that is not live. */
export interface StaleOpClaim {
  file: string;
  line: number;
  claimed: string;
}

const BACKTICK_SPAN = /`([^`\n]+)`/g;
const QUOTED_SPAN = /"([^"\n]*)"|'([^'\n]*)'/g;
// `"op": "addBox"` in any JSON snippet (parametric blocks included) and the
// `{ op: 'addBox'; ... }` protocol-table shape — both assert a kind.
const OP_VALUE_DOUBLE = /"op"\s*:\s*"([A-Za-z][A-Za-z0-9]*)"/g;
const OP_VALUE_SINGLE = /\{\s*op:\s*'([A-Za-z][A-Za-z0-9]*)'/g;
const TOKEN_SPLIT = /[\s/|,;+]+/;
const TOKEN_STRIP = /[()\[\].:?!*…]+$/;

/** Split a span's content into candidate tokens (`extrude/revolve` → two). */
function tokensOf(content: string): string[] {
  return content
    .split(TOKEN_SPLIT)
    .map((t) => t.replace(TOKEN_STRIP, ""))
    .filter((t) => t.length > 0);
}

/**
 * Every live-kind mention plus every op-position claim in one document.
 * `kinds` is the live catalog; anything else in an op position is stale.
 */
export function extractOpMentions(
  file: string,
  text: string,
  kinds: readonly string[]
): { mentions: DocOpMention[]; stale: StaleOpClaim[] } {
  const live = new Set(kinds);
  const mentions: DocOpMention[] = [];
  const stale: StaleOpClaim[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = i + 1;
    // Op-position channels first: a live value is a mention, anything else
    // shaped like an identifier is a stale claim about a removed kind.
    for (const re of [OP_VALUE_DOUBLE, OP_VALUE_SINGLE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) {
        if (live.has(m[1])) mentions.push({ file, line, kind: m[1] });
        else stale.push({ file, line, claimed: m[1] });
      }
    }
    // Prose channels: backtick spans and quoted strings, tokenized. These
    // can only ever document — never go stale (see the module comment).
    for (const re of [BACKTICK_SPAN, QUOTED_SPAN]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) {
        const content = m[1] ?? m[2] ?? "";
        for (const token of tokensOf(content)) {
          if (live.has(token)) mentions.push({ file, line, kind: token });
        }
      }
    }
  }
  return { mentions, stale };
}

/** Every mention and stale claim under `root`, ordered by file then line. */
export function readDocOpMentions(
  root: string,
  kinds: readonly string[]
): { mentions: DocOpMention[]; stale: StaleOpClaim[] } {
  const mentions: DocOpMention[] = [];
  const stale: StaleOpClaim[] = [];
  for (const rel of walkMarkdownFiles(root)) {
    const found = extractOpMentions(rel, fs.readFileSync(path.join(root, rel), "utf8"), kinds);
    mentions.push(...found.mentions);
    stale.push(...found.stale);
  }
  return { mentions, stale };
}

/**
 * The allowlist file: one op kind per line, `#` comments and blanks ignored.
 * Each entry excuses a live kind from the missing check — and MUST carry its
 * reason as a `#` comment, so every opt-out shows up in review.
 */
export function parseOpCoverageAllowlist(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    out.push(line);
  }
  return out;
}

export interface OpCoverageResult {
  /** Live kinds named nowhere, minus the allowlist. */
  missing: string[];
  /** Op-position claims about kinds that do not exist. */
  stale: string[];
  /** Allowlist entries for a removed kind, or one now documented. */
  unusedAllowlist: string[];
}

/**
 * The gate itself, pure over already-gathered inputs so it unit-tests
 * against fixture trees without touching the filesystem.
 */
export function checkDocOpCoverage(
  kinds: readonly string[],
  mentions: readonly DocOpMention[],
  stale: readonly StaleOpClaim[],
  allowlist: readonly string[]
): OpCoverageResult {
  const mentioned = new Set(mentions.map((m) => m.kind));
  const allowed = new Set(allowlist);
  const missing = kinds.filter((k) => !mentioned.has(k) && !allowed.has(k));
  const unusedAllowlist = [...allowed].filter((entry) => {
    const live = (kinds as readonly string[]).includes(entry);
    // Excuses a live, unmentioned kind — otherwise it is unused: either the
    // kind is gone, or it is now documented and the opt-out should go.
    return !live || mentioned.has(entry);
  });
  return { missing, stale: stale.map((s) => s.claimed), unusedAllowlist };
}
