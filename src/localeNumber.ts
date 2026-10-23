/**
 * Decimal-comma admission for plain numeric fields. Pure and DOM-free.
 *
 * The expression grammar (`paramExpr.ts`) reserves `,` as the function-argument
 * separator, so a decimal comma can only be admitted where no expression is
 * possible: a field whose whole text is one number. The rule, in full:
 *
 *   - `1,5` / `-0,25` / `1,5e3` (one comma, digits on both sides, nothing else)
 *     reads as the number with a `.` — a comma is never a thousands separator,
 *     so `1,234` is 1.234.
 *   - Inside an expression (any operator, identifier or parenthesis) the text
 *     is returned unchanged: `max(1,5)` keeps its two arguments.
 *   - A comma outside a call (`1,5+2`) is rejected with a message naming the rule.
 *
 * Output text always uses `.`; nothing locale-dependent is ever persisted.
 */

export type DecimalCommaResult = { ok: true; text: string } | { ok: false; error: string };

const PLAIN_DECIMAL_COMMA = /^\s*([+-]?\d+),(\d+(?:[eE][+-]?\d+)?)\s*$/;

export function normalizeDecimalComma(text: string): DecimalCommaResult {
  if (!text.includes(",")) return { ok: true, text };
  const m = PLAIN_DECIMAL_COMMA.exec(text);
  if (m) return { ok: true, text: `${m[1]}.${m[2]}` };
  // A comma is only legal as an argument separator, i.e. inside parentheses.
  if (/[()]/.test(text)) return { ok: true, text };
  return {
    ok: false,
    error: "a comma is a decimal separator only in a plain number (1,5); in an expression it separates function arguments, e.g. max(1, 5)",
  };
}
