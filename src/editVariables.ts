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
import { compileParametricCurve } from "./parametricCurve";
import {
  evalExpr,
  exprDimension,
  extractIdentifiers,
  getNumericField,
  isValidVariableName,
  parseExprSyntax,
  parseFieldPath,
  setNumericField,
  type ExprDim,
  type FieldPath,
} from "./paramExpr";

export interface ParamVariable {
  name: string;
  /** The defining expression (may reference earlier-defined variables). */
  expr: string;
  /** Cached last-good evaluation of `expr`; kept when re-evaluation fails. */
  value: number;
  /** Free-text note shown in the Parameters table. Additive/optional: absent when empty. */
  comment?: string;
  /** Pinned to the top of the table VIEW; the array order (= evaluation order) is unaffected. Absent when false. */
  favourite?: true;
}

const MAX_VARIABLES = 256;
const MAX_EXPR_LENGTH = 256;
const MAX_COMMENT_LENGTH = 256;

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
    const entry: ParamVariable = { name: v.name, expr: v.expr, value };
    if (typeof v.comment === "string" && v.comment.trim() !== "") entry.comment = v.comment.slice(0, MAX_COMMENT_LENGTH);
    if (v.favourite === true) entry.favourite = true;
    out.push(entry);
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
  /** `addParametricCurve`: refresh the cached `points` against the variables (after its own `exprs`, e.g. `sMax`, resolve). A failing curve keeps its previous cache. */
  const refreshCurve = (op: EditOp, index: number): EditOp => {
    if (op.op !== "addParametricCurve") return op;
    let source: EditOp = op;
    if (op.exprs) {
      const clone = JSON.parse(JSON.stringify(op)) as EditOp;
      for (const [key, expr] of Object.entries(op.exprs)) {
        const path = parseFieldPath(key);
        const r = path ? evalExpr(expr, values) : null;
        if (path && r?.ok) setNumericField(clone, path, r.value);
      }
      source = validateEditOp(clone) ?? op;
    }
    const r = compileParametricCurve(source as Extract<EditOp, { op: "addParametricCurve" }>, values);
    if (r.ok && (r.op.op === "addSpline" || r.op.op === "addPolyline")) return { ...source, points: r.op.points } as EditOp;
    if (!r.ok) issues.push(`edit ${index + 1} (addParametricCurve): ${r.error}; keeping the previous curve`);
    return source;
  };
  const resolved = ops.map((original, index) => {
    const op = refreshCurve(original, index);
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

/** Each variable's deduced dimension (variables only see the ones above them). */
export function variableDimensions(vars: ParamVariable[]): Record<string, ExprDim> {
  const dims: Record<string, ExprDim> = Object.create(null);
  for (const v of vars) dims[v.name] = exprDimension(v.expr, dims) ?? "none";
  return dims;
}

/** What an op field holds, from its name: angles end in `Deg`, directions/factors/counts are plain numbers. */
export function expectedFieldDimension(fieldPath: string): ExprDim {
  const root = /^[A-Za-z][A-Za-z0-9]*/.exec(fieldPath)?.[0] ?? "";
  if (/Deg$|^angle/i.test(root)) return "angle";
  if (/^(axis|axisDir|dir|normal|planeNormal|up|factors|count|times|sides|samples|segments|n|copies|turns|scale|ratio)$/i.test(root)) return "none";
  return "length";
}

/**
 * Dimension mismatches between an op field's expression and what the field
 * holds (`W = 5[deg]` driving a length). Advisory only: the value is applied
 * as written, so a mismatch can never stop a document loading.
 */
export function dimensionIssues(ops: EditOp[], vars: ParamVariable[]): string[] {
  const dims = variableDimensions(vars);
  const issues: string[] = [];
  ops.forEach((op, index) => {
    for (const [key, expr] of Object.entries(op.exprs ?? {})) {
      const got = exprDimension(expr, dims);
      if (got === null || got === "none") continue;
      const want = expectedFieldDimension(key);
      if (got === "mixed") {
        issues.push(`edit ${index + 1} (${op.op}): ${key} = "${expr}" mixes length and angle units; the value is used as written`);
      } else if (got !== want) {
        const wanted = want === "none" ? "a plain number" : `a ${want}`;
        issues.push(`edit ${index + 1} (${op.op}): ${key} = "${expr}" is a ${got} but the field is ${wanted}; the value is used as written`);
      }
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Parameters table helpers (pure): reorder guard, CSV/JSON interchange, unit
// suffix, and the numeric fields an op holds (for "Promote to variable").
// ---------------------------------------------------------------------------

/**
 * Whether the variable at `from` may move to index `to` without breaking the
 * define-above rule. Only the moved variable's own dependencies and the
 * variables that reference it are checked, so a pre-existing bad reference
 * elsewhere never blocks an unrelated move. `reason` names the variable.
 */
export function canMoveVariable(vars: ParamVariable[], from: number, to: number): { ok: true } | { ok: false; reason: string } {
  if (from < 0 || from >= vars.length || to < 0 || to >= vars.length) return { ok: false, reason: "move is out of range" };
  if (from === to) return { ok: true };
  const moved = vars[from];
  const order = vars.slice();
  order.splice(from, 1);
  order.splice(to, 0, moved);
  const pos = new Map(order.map((v, i) => [v.name, i] as const));
  const newPos = pos.get(moved.name) as number;
  for (const dep of extractIdentifiers(moved.expr)) {
    const p = pos.get(dep);
    if (p !== undefined && p > newPos) return { ok: false, reason: `"${moved.name}" references "${dep}", so it cannot move above it` };
  }
  for (const other of vars) {
    if (other.name === moved.name) continue;
    if (extractIdentifiers(other.expr).includes(moved.name) && (pos.get(other.name) as number) < newPos) {
      return { ok: false, reason: `"${other.name}" references "${moved.name}", so "${moved.name}" cannot move below it` };
    }
  }
  return { ok: true };
}

export interface VariableImportResult {
  accepted: ParamVariable[];
  rejected: Array<{ row: number; reason: string }>;
}

/** Split one CSV record honouring quotes (`""` escapes). Rows may not span lines except inside quotes. */
function parseCsvRecords(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const flush = () => {
    row.push(cell);
    cell = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") flush();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      flush();
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  flush();
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

/**
 * Validate imported rows against `existing` (appended after it). Each row is
 * accepted whole or rejected whole with a reason: bad name, duplicate, too long,
 * unparsable, or a reference to a name not defined above it.
 */
export function importVariableRows(
  existing: ParamVariable[],
  rows: Array<{ name: string; expr: string; comment?: string }>,
  firstRowNumber = 1
): VariableImportResult {
  const accepted: ParamVariable[] = [];
  const rejected: VariableImportResult["rejected"] = [];
  const known = new Set(existing.map((v) => v.name));
  const defined = new Set(known);
  const total = () => existing.length + accepted.length;
  rows.forEach((r, i) => {
    const row = firstRowNumber + i;
    const name = r.name.trim();
    const expr = r.expr.trim();
    const reject = (reason: string) => rejected.push({ row, reason });
    if (total() >= MAX_VARIABLES) return reject(`more than ${MAX_VARIABLES} variables`);
    if (!isValidVariableName(name)) return reject(`"${name}" is not a valid variable name`);
    if (known.has(name)) return reject(`duplicate variable "${name}"`);
    if (expr === "" || expr.length > MAX_EXPR_LENGTH) return reject(`expression for "${name}" is empty or longer than ${MAX_EXPR_LENGTH} characters`);
    if (!parseExprSyntax(expr)) return reject(`expression "${expr}" cannot be parsed`);
    const ahead = extractIdentifiers(expr).filter((id) => !defined.has(id));
    // A bare identifier that is a unit/constant/function is not reported by extractIdentifiers, so what remains is a real forward/unknown reference.
    if (ahead.length) return reject(`"${name}" references "${ahead[0]}", which is not defined above it`);
    const entry: ParamVariable = { name, expr, value: 0 };
    if (r.comment && r.comment.trim() !== "") entry.comment = r.comment.trim().slice(0, MAX_COMMENT_LENGTH);
    known.add(name);
    defined.add(name);
    accepted.push(entry);
  });
  return { accepted, rejected };
}

/** Parse a Name,Expression,Comment CSV (header row optional). Row numbers count data rows from 1. */
export function parseVariablesCsv(text: string, existing: ParamVariable[] = []): VariableImportResult {
  const records = parseCsvRecords(text.replace(/^\uFEFF/, ""));
  const body = records.length && /^\s*name\s*$/i.test(records[0][0] ?? "") ? records.slice(1) : records;
  return importVariableRows(
    existing,
    body.map((c) => ({ name: c[0] ?? "", expr: c[1] ?? "", comment: c[2] })),
    1
  );
}

/** Parse a JSON array of `{name, expr, comment?}`; anything else is one rejected row. */
export function parseVariablesJson(text: string, existing: ParamVariable[] = []): VariableImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { accepted: [], rejected: [{ row: 0, reason: "not valid JSON" }] };
  }
  if (!Array.isArray(raw)) return { accepted: [], rejected: [{ row: 0, reason: "expected a JSON array of variables" }] };
  const rows: Array<{ name: string; expr: string; comment?: string }> = [];
  const pre: VariableImportResult["rejected"] = [];
  raw.forEach((item, i) => {
    const o = item as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || typeof o.name !== "string" || typeof o.expr !== "string") {
      pre.push({ row: i + 1, reason: "row needs string name and expr" });
      rows.push({ name: "", expr: "" });
    } else rows.push({ name: o.name, expr: o.expr, comment: typeof o.comment === "string" ? o.comment : undefined });
  });
  const res = importVariableRows(existing, rows, 1);
  // Rows already rejected for shape reasons keep their clearer message.
  const shapeRows = new Set(pre.map((p) => p.row));
  return { accepted: res.accepted, rejected: [...pre, ...res.rejected.filter((r) => !shapeRows.has(r.row))].sort((a, b) => a.row - b.row) };
}

function csvCell(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function serializeVariablesCsv(vars: ParamVariable[]): string {
  return ["Name,Expression,Comment", ...vars.map((v) => [v.name, v.expr, v.comment ?? ""].map(csvCell).join(","))].join("\n") + "\n";
}

export function serializeVariablesJson(vars: ParamVariable[]): string {
  return JSON.stringify(vars.map((v) => ({ name: v.name, expr: v.expr, ...(v.comment ? { comment: v.comment } : {}) })), null, 2) + "\n";
}

const UNIT_SUFFIX = /\[(mm|cm|m|in|ft|deg|rad)\]\s*$/;

/** The bracket unit at the end of `expr` (`"2[in]"` → `"in"`), or null. */
export function exprUnit(expr: string): string | null {
  return UNIT_SUFFIX.exec(expr)?.[1] ?? null;
}

/**
 * Return `expr` with its trailing bracket unit replaced by `unit` (null removes
 * it). Only a plain number or an expression that already ends in a bracket unit
 * is rewritten; anything else returns null so the caller can say why.
 */
export function withExprUnit(expr: string, unit: string | null): string | null {
  const t = expr.trim();
  const base = t.replace(UNIT_SUFFIX, "").trim();
  if (!UNIT_SUFFIX.test(t) && !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(base)) return null;
  return unit ? `${base}[${unit}]` : base;
}

/** Keys that never hold a user-tunable number. */
const NON_PARAMETER_KEYS = new Set(["op", "exprs", "pointRefs", "planeRefs", "planeId", "points"]);

export interface NumericFieldRef {
  /** Field path in `exprs` syntax (`length`, `size[1]`). */
  path: string;
  value: number;
  /** The expression currently driving the field, if any. */
  expr?: string;
  dimension: ExprDim;
}

/** Every numeric slot of `op` that an `exprs` entry could drive (depth ≤ 2, `parseFieldPath` shapes). */
export function enumerateNumericFields(op: EditOp): NumericFieldRef[] {
  const out: NumericFieldRef[] = [];
  const exprs = (op as { exprs?: Record<string, string> }).exprs ?? {};
  const add = (segs: FieldPath) => {
    const value = getNumericField(op, segs);
    if (value === null) return;
    const path = String(segs[0]) + segs.slice(1).map((n) => `[${n}]`).join("");
    out.push({ path, value, expr: exprs[path], dimension: expectedFieldDimension(path) });
  };
  for (const key of Object.keys(op)) {
    if (NON_PARAMETER_KEYS.has(key) || !parseFieldPath(key)) continue;
    const v = (op as unknown as Record<string, unknown>)[key];
    if (typeof v === "number") add([key]);
    else if (Array.isArray(v)) {
      v.forEach((a, i) => {
        if (typeof a === "number") add([key, i]);
        else if (Array.isArray(a)) a.forEach((b, j) => typeof b === "number" && add([key, i, j]));
      });
    }
  }
  return out;
}

/**
 * Make `path` of the STORED `op` follow variable `varName` (annotation only —
 * the numeric field stays as the last-good cache). Returns a new op, or null
 * if the path is not a numeric slot of the op.
 */
export function promoteField(op: EditOp, path: string, varName: string): EditOp | null {
  const segs = parseFieldPath(path);
  if (!segs || getNumericField(op, segs) === null) return null;
  const next = JSON.parse(JSON.stringify(op)) as EditOp;
  next.exprs = { ...(next.exprs ?? {}), [path]: varName };
  return validateEditOp(next);
}
