import { EXPR_CONSTANT_NAMES, EXPR_FUNCTION_NAMES } from "./paramExpr";

export type CompletionKind = "variable" | "function" | "constant";

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  /** What accepting inserts (a function gains its opening parenthesis). */
  insert: string;
}

export interface CompletionResult {
  /** Replace `text.slice(from, to)` with the accepted item's `insert`. */
  from: number;
  to: number;
  items: CompletionItem[];
}

const IDENT_CHAR = /[A-Za-z0-9_]/;

/**
 * Suggestions for the identifier being typed at `caret` in an expression.
 * Pure: variables first (caller passes only the names legal in this context —
 * "defined above" for a variable expression, all for an op field), then
 * `paramExpr` functions and constants. Returns null when there is nothing to
 * offer: no identifier prefix, a prefix that starts with a digit (a number or
 * its exponent), a caret inside a `[unit]` suffix, or only the exact word
 * already typed.
 */
export function completeExpression(text: string, caret: number, variableNames: readonly string[]): CompletionResult | null {
  const to = Math.max(0, Math.min(caret, text.length));
  let from = to;
  while (from > 0 && IDENT_CHAR.test(text[from - 1])) from--;
  if (from === to) return null;
  const prefix = text.slice(from, to);
  if (/^[0-9]/.test(prefix)) return null;
  const before = text.slice(0, from);
  if (before.lastIndexOf("[") > before.lastIndexOf("]")) return null;
  const lower = prefix.toLowerCase();
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const add = (label: string, kind: CompletionKind): void => {
    if (seen.has(label) || !label.toLowerCase().startsWith(lower)) return;
    seen.add(label);
    items.push({ label, kind, insert: kind === "function" ? `${label}(` : label });
  };
  for (const n of variableNames) add(n, "variable");
  for (const n of EXPR_FUNCTION_NAMES) add(n, "function");
  for (const n of EXPR_CONSTANT_NAMES) add(n, "constant");
  if (items.length === 0) return null;
  // Nothing left to complete: the word is already whole.
  if (items.length === 1 && items[0].label === prefix && (items[0].kind !== "function" || text[to] === "(")) return null;
  return { from, to, items };
}

/** Apply an accepted item: the new text and caret position. */
export function applyCompletion(text: string, result: CompletionResult, item: CompletionItem): { text: string; caret: number } {
  const next = text.slice(0, result.from) + item.insert + text.slice(result.to);
  return { text: next, caret: result.from + item.insert.length };
}

/** Wrap-around arrow-key movement of the highlighted index. */
export function moveCompletionIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}
