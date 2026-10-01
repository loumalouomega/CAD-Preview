/**
 * The structural gate behind roadmap 1.1 "Verification-debt burn-down".
 *
 * `CLAUDE.md` is a chronological session log, so its "Verification gap, stated
 * plainly" notes outlive the gaps they describe. A raw `grep -c` over it would
 * be trivially gameable by rewording and would ratchet upward on every honest
 * retrospective, so this counts something STRUCTURAL instead:
 *
 * - A **registry** (`scripts/verification-gaps/registry.json`) holds one entry
 *   per unverified claim, with a status.
 * - Every gap note in `CLAUDE.md` must carry a `[vg:<id>[,<id>…]]` marker that
 *   resolves to registry entries — so a NEW unverified feature cannot land
 *   silently: its note fails the gate until it is registered.
 * - An entry can only be `closed` by naming harness test titles that literally
 *   exist in `scripts/webview-test/run.mjs` or `test/integration/suite/index.ts`.
 *   Renaming or deleting the covering test re-opens the debt; rewording prose
 *   cannot close it.
 * - A checked-in baseline caps the number of unresolved entries. It can only go
 *   down by closing entries, and a state the harness has not yet proven
 *   (`test-written`) still counts as open.
 *
 * Pure: no filesystem, no vscode — the caller reads the files. See
 * `verificationGaps.test.ts` for the three-layer test shape (fixtures, then the
 * real tree).
 */

export type GapStatus = "open" | "test-written" | "closed" | "none";

export interface GapEntry {
  id: string;
  /** The `CLAUDE.md` section the claim came from. Display only. */
  section: string;
  /** What is unverified, in one line. Display only. */
  gap: string;
  status: GapStatus;
  /** Exact harness test titles. Required for `closed` and `test-written`. */
  closedBy?: string[];
  /** Why — required for `none` (nothing to verify / retracted) and encouraged elsewhere. */
  note?: string;
}

export interface GapRegistry {
  version: 1;
  entries: GapEntry[];
}

export interface GapBaseline {
  /** Maximum number of unresolved (`open` + `test-written`) entries. */
  open: number;
}

export interface GapNote {
  line: number;
  text: string;
  ids: string[];
}

/**
 * A gap note is a bullet or paragraph whose bold label announces an unverified
 * claim. "Verification gap: none" and "No verification gap" are statements that
 * there is nothing to verify; they still match the first form on purpose, so
 * that even a "none" is registered (status `none`, with its reason).
 */
const GAP_NOTE_PATTERN = /^\s*(?:-\s+)?\*\*(?:Verification gap|Still F5-only|F5-only|Remaining F5 gap)/;
const MARKER_PATTERN = /\[vg:([a-z0-9][a-z0-9,-]*)\]/g;

/** Finds every gap note in `CLAUDE.md` with its markers (possibly none). */
export function findGapNotes(text: string): GapNote[] {
  const notes: GapNote[] = [];
  text.split("\n").forEach((line, i) => {
    if (!GAP_NOTE_PATTERN.test(line)) return;
    const ids: string[] = [];
    for (const m of line.matchAll(MARKER_PATTERN)) ids.push(...m[1].split(",").filter(Boolean));
    notes.push({ line: i + 1, text: line.trim(), ids });
  });
  return notes;
}

/** Every `[vg:…]` id mentioned ANYWHERE in the text (notes and the closure table alike). */
export function allMarkerIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(MARKER_PATTERN)) for (const id of m[1].split(",")) if (id) ids.add(id);
  return ids;
}

/**
 * Test titles declared in a harness source: `test("title", …)` and
 * `test('title', …)`. Deliberately a title scan, not an import — the harnesses
 * are scripts that run a browser at import time.
 */
export function harnessTestTitles(source: string): Set<string> {
  const titles = new Set<string>();
  for (const m of source.matchAll(/(?:^|[^\w.])test\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')/gm)) {
    titles.add((m[1] ?? m[2]).replace(/\\(["'\\])/g, "$1"));
  }
  return titles;
}

export const isUnresolved = (e: GapEntry): boolean => e.status === "open" || e.status === "test-written";

export const unresolvedCount = (r: GapRegistry): number => r.entries.filter(isUnresolved).length;

/** Tolerant parse: a malformed registry is reported by the gate, never silently accepted. */
export function parseRegistry(json: string): GapRegistry {
  const raw = JSON.parse(json) as { version?: unknown; entries?: unknown };
  if (raw.version !== 1 || !Array.isArray(raw.entries)) throw new Error("registry must be {version: 1, entries: []}");
  const entries: GapEntry[] = raw.entries.map((e, i) => {
    const o = e as Partial<GapEntry>;
    if (typeof o.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(o.id)) throw new Error(`entry ${i}: bad id ${JSON.stringify(o.id)}`);
    if (!["open", "test-written", "closed", "none"].includes(o.status as string)) throw new Error(`entry ${o.id}: bad status ${JSON.stringify(o.status)}`);
    return {
      id: o.id,
      section: String(o.section ?? ""),
      gap: String(o.gap ?? ""),
      status: o.status as GapStatus,
      closedBy: Array.isArray(o.closedBy) ? o.closedBy.map(String) : undefined,
      note: typeof o.note === "string" ? o.note : undefined,
    };
  });
  return { version: 1, entries };
}

export interface GateInput {
  claudeMd: string;
  registry: GapRegistry;
  baseline: GapBaseline;
  /** Concatenated or per-file harness sources — only their `test("…")` titles are read. */
  harnessSources: string[];
}

/** Runs every rule; returns human-readable problems (empty means the gate passes). */
export function checkGaps(input: GateInput): string[] {
  const problems: string[] = [];
  const { registry, baseline } = input;

  const seen = new Set<string>();
  for (const e of registry.entries) {
    if (seen.has(e.id)) problems.push(`duplicate registry id "${e.id}"`);
    seen.add(e.id);
  }

  const titles = new Set<string>();
  for (const src of input.harnessSources) for (const t of harnessTestTitles(src)) titles.add(t);

  for (const e of registry.entries) {
    if (e.status === "closed" || e.status === "test-written") {
      if (!e.closedBy || e.closedBy.length === 0) {
        problems.push(`"${e.id}" is ${e.status} but names no covering test (closedBy)`);
        continue;
      }
      for (const t of e.closedBy) {
        if (!titles.has(t)) {
          problems.push(`"${e.id}" is ${e.status} by a test that does not exist: ${JSON.stringify(t)} — renaming or deleting the covering test re-opens the debt`);
        }
      }
    }
    if (e.status === "none" && !e.note) problems.push(`"${e.id}" has status none but gives no reason (note)`);
  }

  const notes = findGapNotes(input.claudeMd);
  for (const n of notes) {
    if (n.ids.length === 0) {
      problems.push(`CLAUDE.md:${n.line} is a verification-gap note with no [vg:<id>] marker — register it in scripts/verification-gaps/registry.json and add the marker`);
      continue;
    }
    for (const id of n.ids) {
      if (!seen.has(id)) problems.push(`CLAUDE.md:${n.line} cites [vg:${id}], which is not in the registry`);
    }
  }

  const mentioned = allMarkerIds(input.claudeMd);
  for (const e of registry.entries) {
    if (!mentioned.has(e.id)) problems.push(`registry entry "${e.id}" is not referenced by any [vg:${e.id}] marker in CLAUDE.md (an orphaned entry cannot be audited)`);
  }

  const open = unresolvedCount(registry);
  if (open > baseline.open) {
    problems.push(`unresolved verification gaps rose to ${open} (baseline ${baseline.open}) — close one with a harness test, or register why it cannot be and raise the baseline deliberately in the same change`);
  }
  if (open < baseline.open) {
    problems.push(`unresolved verification gaps fell to ${open} (baseline ${baseline.open}) — lower the baseline in scripts/verification-gaps/baseline.json so the debt stays ratcheted`);
  }
  return problems;
}
