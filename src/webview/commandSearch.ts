/**
 * Command search and keyboard-first commands — the pure half (roadmap
 * "Command search and keyboard-first commands"). DOM-free and `three`-free so
 * it unit-tests headless; `commandPalette.ts` owns the overlay and the key
 * wiring and only calls into this module.
 *
 * Three jobs:
 *  - {@link fuzzyScore} / {@link rankItems}: the matcher and ordering behind
 *    the Ctrl+K list.
 *  - {@link opSearchItems}: the op-command source, built from the catalog and
 *    `COMMAND_TABLE` so a new op button is searchable without a second list.
 *  - {@link resolveKey}: which command (if any) a key press means, honouring
 *    the opt-in setting, modifiers and "never while typing".
 */
import type { EditOp } from "../editOps";
import { COMMAND_TABLE } from "../opCommands";
import { isTextEntryTarget, viewForKey } from "../viewShortcuts";
import { ACTION_KEYS, OP_CATALOG, REPEAT_LAST_KEY, allCatalogEntries, type PanelOpId } from "./opCatalog";

// ── Search items ────────────────────────────────────────────────────────────

export type SearchItemKind = "op" | "action" | "panel";

export interface SearchItem {
  /** Stable id: a `PanelOpId` for ops, an element id for actions and panels. */
  id: string;
  kind: SearchItemKind;
  label: string;
  /** The catalog category, dropdown name or panel group shown beside the label. */
  group: string;
  /** Extra words that should find this item (typed command names, aliases, titles). */
  keywords: string[];
  /** Display text of the shortcut, e.g. "E" or "Shift+R"; absent when none. */
  shortcut?: string;
  /** True when the item cannot run right now (a B-rep-only op on a mesh source). */
  disabled?: boolean;
}

/** One search item per op button, with `COMMAND_TABLE` names and aliases as keywords. */
export function opSearchItems(): SearchItem[] {
  const rows = new Map(COMMAND_TABLE.map((r) => [r.panelId, r]));
  const groupOf = new Map<PanelOpId, string>();
  for (const cat of [...OP_CATALOG.geometry2d, ...OP_CATALOG.geometry3d, ...OP_CATALOG.edit]) {
    for (const o of cat.ops) groupOf.set(o.id, cat.title);
  }
  return allCatalogEntries().map((e) => {
    const row = rows.get(e.id);
    const keywords = [e.id, ...(row ? [row.command, ...row.aliases] : []), ...e.kinds];
    return {
      id: e.id,
      kind: "op" as const,
      label: e.label,
      group: groupOf.get(e.id) ?? "",
      keywords: [...new Set(keywords)],
      ...(e.key ? { shortcut: e.key } : {}),
    };
  });
}

// ── Fuzzy matching ──────────────────────────────────────────────────────────

const isWordStart = (text: string, i: number): boolean => {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  if (!/[a-z0-9]/i.test(prev)) return true;
  // camelCase boundary: "addBox" -> "Box"
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase();
};

/** Scores one whitespace-free query token against `text`; `null` when it does not match. */
function tokenScore(token: string, text: string): number | null {
  const q = token.toLowerCase();
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) {
    // A contiguous hit: prefix beats word start beats mid-word.
    return 100 + (at === 0 ? 50 : isWordStart(text, at) ? 25 : 0) - at;
  }
  // Subsequence hit: reward word starts and runs, penalise gaps.
  let score = 0;
  let ti = 0;
  let run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    let found = -1;
    for (let j = ti; j < t.length; j++) {
      if (t[j] === q[qi]) { found = j; break; }
    }
    if (found < 0) return null;
    run = found === ti && qi > 0 ? run + 1 : 0;
    score += 10 + run * 5 + (isWordStart(text, found) ? 8 : 0) - Math.min(found - ti, 6);
    ti = found + 1;
  }
  return score;
}

/**
 * Scores `query` against `text`. Every whitespace-separated query token must
 * match (contiguous substring, else in-order subsequence); `null` when any
 * does not. A longer text scores slightly lower, so `Fillet` beats
 * `Fill Surface` for `fil`. An empty query matches everything with score 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const tok of tokens) {
    const s = tokenScore(tok, text);
    if (s === null) return null;
    total += s;
  }
  return total - text.length * 0.1;
}

export interface RankOptions {
  limit?: number;
  /** Ids to float to the top of an EMPTY query, in order (most recent first). */
  recent?: readonly string[];
}

/**
 * Orders `items` for `query`: the best of label (full weight), keywords (0.7)
 * and group (0.4); ties keep source order. Non-matching items are dropped.
 * An empty query returns recent items first, then source order.
 */
export function rankItems(items: readonly SearchItem[], query: string, opts: RankOptions = {}): SearchItem[] {
  const limit = opts.limit ?? 50;
  if (query.trim() === "") {
    const recent = opts.recent ?? [];
    const rank = (id: string): number => { const i = recent.indexOf(id); return i < 0 ? Infinity : i; };
    return items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => rank(a.item.id) - rank(b.item.id) || a.index - b.index)
      .slice(0, limit)
      .map((x) => x.item);
  }
  const scored: { item: SearchItem; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    let best: number | null = null;
    const consider = (s: number | null, weight: number): void => {
      if (s !== null && (best === null || s * weight > best)) best = s * weight;
    };
    consider(fuzzyScore(query, item.label), 1);
    for (const k of item.keywords) consider(fuzzyScore(query, k), 0.7);
    consider(fuzzyScore(query, item.group), 0.4);
    if (best !== null) scored.push({ item, score: best, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((x) => x.item);
}

// ── Keys ────────────────────────────────────────────────────────────────────

export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}

export type KeyCommand =
  | { type: "search" }
  | { type: "op"; id: PanelOpId }
  | { type: "action"; elementId: string }
  | { type: "repeat" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "help" };

/** lower-case key -> command, built once from the catalog and {@link ACTION_KEYS}. */
export function singleKeyTable(): Map<string, KeyCommand> {
  const table = new Map<string, KeyCommand>();
  for (const e of allCatalogEntries()) {
    if (e.key) table.set(e.key.toLowerCase(), { type: "op", id: e.id });
  }
  for (const [elementId, key] of Object.entries(ACTION_KEYS)) {
    table.set(key.toLowerCase(), { type: "action", elementId });
  }
  return table;
}

/** Display text of the shortcut declared for an action element id, if any. */
export function actionShortcut(elementId: string): string | undefined {
  return ACTION_KEYS[elementId];
}

/** The Shift+R chord (`REPEAT_LAST_KEY` in the catalog is its display text). */
const isRepeatChord = (e: KeyEventLike): boolean => e.shiftKey === true && e.key.toLowerCase() === "r";

/**
 * What a key press means.
 *
 *  - Ctrl/Cmd+K opens the search from anywhere, including a field.
 *  - `/` opens it only when focus is not in a field.
 *  - `?` opens the keyboard-shortcuts sheet (same rule as `/`).
 *  - Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo (never in a field).
 *  - With `singleKeys` on, an unmodified catalog letter runs its command and
 *    Shift+R repeats the last one — never while typing, never with
 *    Ctrl/Cmd/Alt, never on auto-repeat, and never for the view snaps
 *    (`1`–`6`, `i`), which `viewShortcuts.ts` keeps.
 */
export function resolveKey(e: KeyEventLike, singleKeys: boolean, table: ReadonlyMap<string, KeyCommand> = singleKeyTable()): KeyCommand | null {
  if (e.defaultPrevented) return null;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && k.toLowerCase() === "k") return { type: "search" };
  // Undo / redo (roadmap "Undo and redo from the keyboard"). Never inside a
  // text field, which keeps its own undo; not gated on the single-key setting
  // because they are chords, not bare letters.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !isTextEntryTarget(e.target ?? null)) {
    const lk = k.toLowerCase();
    if (lk === "z") return e.shiftKey ? { type: "redo" } : { type: "undo" };
    if (lk === "y" && !e.shiftKey) return { type: "redo" };
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isTextEntryTarget(e.target ?? null)) return null;
  if (k === "/" && !e.shiftKey) return { type: "search" };
  if (k === "?") return { type: "help" };
  if (!singleKeys || e.repeat) return null;
  if (isRepeatChord(e)) return { type: "repeat" };
  if (e.shiftKey) return null;
  // The view snaps own 1-6 and i.
  if (viewForKey({ key: k })) return null;
  return table.get(k.toLowerCase()) ?? null;
}

// ── Last command ────────────────────────────────────────────────────────────

/** The `PanelOpId` whose button emits `op`, or `null` for an op with no button (agent-only kinds). */
export function panelIdForOp(op: EditOp): PanelOpId | null {
  if (op.op === "boolean") {
    return op.kind === "union" ? "booleanUnion" : op.kind === "subtract" ? "booleanSubtract" : "booleanIntersect";
  }
  const hit = allCatalogEntries().find((e) => e.kinds.includes(op.op) && e.kinds.length === 1)
    ?? allCatalogEntries().find((e) => e.kinds.includes(op.op));
  return hit ? hit.id : null;
}

export interface LastCommand {
  id: PanelOpId;
  /** The last applied op's values, to prefill the reopened form; absent when the form was only opened. */
  body?: Record<string, unknown>;
}

/**
 * Remembers the last op command. Opening a form records the id (keeping the
 * values of an applied op of the same kind); applying an op records its
 * values. Pure state, so the repeat rules are unit-testable.
 */
export class LastCommandTracker {
  private last: LastCommand | null = null;
  private recents: string[] = [];

  opened(id: PanelOpId): void {
    this.last = this.last?.id === id ? this.last : { id };
    this.touch(id);
  }

  applied(op: EditOp): void {
    const id = panelIdForOp(op);
    if (!id) return;
    this.last = { id, body: JSON.parse(JSON.stringify(op)) as Record<string, unknown> };
    this.touch(id);
  }

  get(): LastCommand | null {
    return this.last;
  }

  /** Ids to float to the top of an empty search, most recent first. */
  recent(): readonly string[] {
    return this.recents;
  }

  /** Records a non-op search item (action/panel) as recent without disturbing the repeatable op. */
  touch(id: string): void {
    this.recents = [id, ...this.recents.filter((x) => x !== id)].slice(0, 6);
  }
}


// ── Shortcut sheet ──────────────────────────────────────────────────────────

export interface ShortcutRow {
  keys: string;
  label: string;
  /** True for a bare-letter command that only fires with `cadPreview.singleKeyCommands`. */
  needsSetting?: boolean;
}

export interface ShortcutSection {
  title: string;
  rows: ShortcutRow[];
}

/** View-snap key labels, in the order `viewShortcuts.ts` documents them. */
const VIEW_SNAP_ROWS: ShortcutRow[] = [
  { keys: "1 – 6", label: "Snap to front, back, right, left, top, bottom" },
  { keys: "I", label: "Snap to isometric" },
];

/**
 * The keyboard-shortcuts sheet, generated from the same tables the key
 * handler reads ({@link singleKeyTable}, {@link ACTION_KEYS}, the catalog) so
 * it cannot drift from what actually fires. `actionLabel` names an action's
 * element id (the DOM supplies its title); ids it cannot name fall back to the id.
 */
export function shortcutSections(
  table: ReadonlyMap<string, KeyCommand> = singleKeyTable(),
  actionLabel: (elementId: string) => string | undefined = () => undefined,
): ShortcutSection[] {
  const labelOf = new Map(allCatalogEntries().map((e) => [e.id as string, e.label]));
  const ops: ShortcutRow[] = [];
  const actions: ShortcutRow[] = [];
  for (const [key, cmd] of table) {
    if (cmd.type === "op") ops.push({ keys: key.toUpperCase(), label: labelOf.get(cmd.id) ?? cmd.id, needsSetting: true });
    else if (cmd.type === "action") actions.push({ keys: key.toUpperCase(), label: actionLabel(cmd.elementId) ?? cmd.elementId, needsSetting: true });
  }
  const byKeys = (a: ShortcutRow, b: ShortcutRow): number => a.keys.localeCompare(b.keys);
  return [
    {
      title: "Anywhere",
      rows: [
        { keys: "Ctrl+K", label: "Search commands" },
        { keys: "/", label: "Search commands (outside a field)" },
        { keys: "?", label: "Keyboard shortcuts" },
        { keys: "Ctrl+Z", label: "Undo the last edit" },
        { keys: "Ctrl+Shift+Z / Ctrl+Y", label: "Redo" },
        { keys: REPEAT_LAST_KEY, label: "Repeat the last command (reopens its form)", needsSetting: true },
      ],
    },
    { title: "View", rows: VIEW_SNAP_ROWS },
    { title: "Tools", rows: actions.sort(byKeys) },
    { title: "Operations", rows: ops.sort(byKeys) },
  ].filter((sec) => sec.rows.length > 0);
}
