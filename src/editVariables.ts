/**
 * Named parametric variables and the resolver that applies them to edit ops.
 * Pure and vscode/DOM-free so it unit-tests headless and is imported by both
 * the host (sidecar parsing) and the webview (resolve-on-read).
 *
 * A variable's `value` is the cached last-good evaluation — same philosophy as
 * an op's numeric fields caching the last-good resolved numbers. Variables are
 * evaluated in list order and may reference only variables defined ABOVE them,
 * which gives derived variables (`W = L/2`) with zero cycle-detection
 * machinery: cycles are simply unrepresentable.
 */

import { EditOp, validateEditOp } from "./editOps";
import { evalExpr, isValidVariableName, parseFieldPath, setNumericField } from "./paramExpr";

export interface ParamVariable {
  name: string;
  /** The defining expression (may reference earlier-defined variables). */
  expr: string;
  /** Cached last-good evaluation of `expr`; kept when re-evaluation fails. */
  value: number;
}

const MAX_VARIABLES = 256;
const MAX_EXPR_LENGTH = 256;

/**
 * Tolerance gate for a raw `variables` array (sidecar or message): drops
 * entries with invalid/duplicate names (first wins) or a non-string/oversized
 * expr; a non-finite cached value falls back to 0. Mirrors `validateEditOp` —
 * a malformed entry is dropped, never crashes the load.
 */
export function validateVariables(raw: unknown): ParamVariable[] {
  if (!Array.isArray(raw)) return [];
  const out: ParamVariable[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_VARIABLES) break;
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    if (typeof v.name !== "string" || !isValidVariableName(v.name) || seen.has(v.name)) continue;
    if (typeof v.expr !== "string" || v.expr.length > MAX_EXPR_LENGTH) continue;
    const value = typeof v.value === "number" && Number.isFinite(v.value) ? v.value : 0;
    seen.add(v.name);
    out.push({ name: v.name, expr: v.expr, value });
  }
  return out;
}

/**
 * Evaluate every variable in list order, each against the names defined above
 * it only (self/forward references are an error for that variable). A failing
 * variable keeps its cached `value` (mutated in place) so dependents and ops
 * degrade gracefully instead of collapsing to 0.
 */
export function evaluateVariables(vars: ParamVariable[]): {
  values: Record<string, number>;
  errors: Map<string, string>;
} {
  const values: Record<string, number> = Object.create(null);
  const errors = new Map<string, string>();
  for (const v of vars) {
    const r = evalExpr(v.expr, values);
    if (r.ok) {
      v.value = r.value;
    } else {
      errors.set(v.name, r.error);
    }
    values[v.name] = v.value;
  }
  return { values, errors };
}

/**
 * Resolve every op's `exprs` against the evaluated variable `values`: clone,
 * evaluate each entry, patch the addressed numeric field, then re-run
 * `validateEditOp` on the patched clone — if a cross-field invariant now fails
 * (e.g. a variable change makes `minorRadius ≥ majorRadius`), the ORIGINAL op
 * is kept untouched (values freeze at the last-good cache) and an issue is
 * recorded. A single field's eval failure keeps that field's cache but still
 * applies the others. Ops without `exprs` pass through by reference. Replay
 * never hard-fails — same graceful-degradation rule as every other op path.
 */
export function resolveEditOps(
  ops: EditOp[],
  values: Record<string, number>
): { ops: EditOp[]; issues: string[] } {
  const issues: string[] = [];
  const resolved = ops.map((op, index) => {
    if (!op.exprs) return op;
    const clone = JSON.parse(JSON.stringify(op)) as EditOp;
    for (const [key, expr] of Object.entries(op.exprs)) {
      const path = parseFieldPath(key);
      if (!path) continue; // can't happen post-validate; belt and braces
      const r = evalExpr(expr, values);
      if (!r.ok) {
        issues.push(`edit ${index + 1} (${op.op}): ${key} = "${expr}" — ${r.error}; keeping previous value`);
        continue;
      }
      setNumericField(clone, path, r.value);
    }
    const revalidated = validateEditOp(clone);
    if (!revalidated) {
      issues.push(`edit ${index + 1} (${op.op}): resolved values are invalid — keeping previous values`);
      return op;
    }
    return revalidated;
  });
  return { ops: resolved, issues };
}
