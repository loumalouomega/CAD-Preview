/**
 * Compiles a "parametric script" — a small, declarative, agent-authorable
 * document (`doc/roadmap.md`'s "Parametric script-as-source MCP tool") —
 * into a flat, already-validated `EditOp[]` ready to append to a document's
 * op stack. Pure and vscode-free (mirrors `editVariables.ts`/`editOps.ts`'s
 * convention) so it unit-tests headless.
 *
 * **Deliberately NOT a general-purpose scripting language.** The roadmap's
 * own open questions were which language/engine to embed, how to sandbox
 * agent-authored code, and how a script composes with interactive edit-ops
 * without breaking the sidecar replay model. This design answers all three
 * by NOT embedding an interpreter at all: a script is `{variables?, steps}`
 * where each step is either a single `EditOp` (identical to what
 * `apply_edit_ops` already accepts) or one `repeat` block (a single flat
 * loop, no nesting, no other control flow) whose body ops may reference the
 * loop index — and every other variable in scope — through the SAME
 * `exprs`/`paramExpr.ts` expression evaluator op fields already use. There
 * is no arbitrary code execution, no I/O, nothing to sandbox — the
 * "sandboxing" question is moot by construction. And because compilation's
 * *output* is exactly the `EditOp[]` shape the existing op stack already
 * stores and replays, a compiled script composes with interactive edits
 * with zero special-casing: the two are literally the same representation
 * once compiled.
 *
 * **Repeat-generated ops are fully baked, not left "live".** A repeat
 * body op's `exprs` are resolved against that iteration's values (document
 * variables + script variables + the loop index) into concrete numbers, and
 * the `exprs` annotation is then DROPPED from the compiled op — keeping a
 * loop-index-dependent expression around would be actively wrong on a
 * future replay (no document variable named e.g. "i" exists to resolve it
 * against, unlike a real persisted variable). A plain (non-repeated) `op`
 * step is untouched by this: it passes straight through `validateEditOp`
 * with `exprs` intact, identical to `apply_edit_ops`'s own behavior — so a
 * script step that should stay live against a real document variable (set
 * separately via `set_variables`) still can; only the repeat construct's
 * output is baked. This is a stated v1 scope choice, not an oversight.
 */

import { type EditOp, validateEditOp } from "./editOps";
import { type ParamVariable, evaluateVariables, validateVariables } from "./editVariables";
import { evalExpr, isValidVariableName, parseFieldPath, setNumericField } from "./paramExpr";

export interface ParametricRepeatStep {
  /** A concrete count, or an expression (evaluated once, against
   * document + script variables — NOT the loop index, which isn't defined
   * yet) — e.g. `"N"` or `"N*2"`. Clamped to `[0, 1000]`. */
  times: number | string;
  /** The variable name the loop index (0-based) is bound to for the
   * duration of this block — must not collide with a reserved name. */
  indexVar: string;
  /** Raw `EditOp` objects, validated fresh on every iteration (the same
   * body is reused; each iteration produces its own baked copy). */
  body: unknown[];
}

export interface ParametricStep {
  /** A single op, validated exactly like one `apply_edit_ops` entry. */
  op?: unknown;
  /** Mutually exclusive with `op` — exactly one of the two must be set. */
  repeat?: ParametricRepeatStep;
}

export interface ParametricScriptInput {
  /** Script-local variables, evaluated once before any step runs — same
   * shape as the document's own `ParamVariable[]`, but NEVER persisted;
   * they shadow a document variable of the same name for this compile only. */
  variables?: ParamVariable[];
  steps: ParametricStep[];
}

export interface StepReport {
  index: number;
  kind: "op" | "repeat" | "invalid";
  applied: number;
  rejected: number;
  reasons: string[];
}

export interface CompiledScript {
  ops: EditOp[];
  report: StepReport[];
  issues: string[];
  /** True if the step list or a repeat's total op count hit a safety cap
   * (`MAX_STEPS`/`MAX_TOTAL_OPS`) and further steps/iterations were dropped. */
  truncated: boolean;
}

const MAX_STEPS = 200;
const MAX_REPEAT_TIMES = 1000;
const MAX_TOTAL_OPS = 5000;

/**
 * Compiles `raw` (untrusted JSON) against `documentValues` (the calling
 * document's already-evaluated persisted variables — pass `{}` for none).
 * Never throws — every malformed step/op/expression is dropped with a
 * recorded reason in `report`/`issues`, same graceful-degradation rule as
 * `validateEditOp`/`resolveEditOps`.
 */
export function compileParametricScript(raw: unknown, documentValues: Record<string, number>): CompiledScript {
  const issues: string[] = [];
  const report: StepReport[] = [];
  const ops: EditOp[] = [];
  let truncated = false;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ops: [], report: [], issues: ["script must be an object with a `steps` array"], truncated: false };
  }
  const obj = raw as Record<string, unknown>;

  const scriptVariables = validateVariables(obj.variables);
  const { values: scriptValues, errors: varErrors } = evaluateVariables(scriptVariables);
  for (const [name, err] of varErrors) issues.push(`script variable "${name}": ${err}`);
  const baseValues: Record<string, number> = { ...documentValues, ...scriptValues };

  const rawStepsFull = Array.isArray(obj.steps) ? obj.steps : [];
  if (rawStepsFull.length > MAX_STEPS) {
    issues.push(`script has ${rawStepsFull.length} steps; only the first ${MAX_STEPS} were compiled`);
    truncated = true;
  }
  const rawSteps = rawStepsFull.slice(0, MAX_STEPS);

  for (let i = 0; i < rawSteps.length; i++) {
    if (ops.length >= MAX_TOTAL_OPS) {
      truncated = true;
      break;
    }
    const step = rawSteps[i];
    if (!step || typeof step !== "object") {
      report.push({ index: i, kind: "invalid", applied: 0, rejected: 1, reasons: ["step is not an object"] });
      continue;
    }
    const s = step as Record<string, unknown>;

    if (s.op !== undefined) {
      const validated = validateEditOp(s.op);
      if (!validated) {
        report.push({ index: i, kind: "op", applied: 0, rejected: 1, reasons: ["invalid op"] });
        continue;
      }
      ops.push(validated);
      report.push({ index: i, kind: "op", applied: 1, rejected: 0, reasons: [] });
      continue;
    }

    if (s.repeat && typeof s.repeat === "object") {
      report.push(compileRepeatStep(i, s.repeat as Record<string, unknown>, baseValues, ops));
      if (ops.length >= MAX_TOTAL_OPS) truncated = true;
      continue;
    }

    report.push({ index: i, kind: "invalid", applied: 0, rejected: 1, reasons: ["step must have exactly one of `op`/`repeat`"] });
  }

  return { ops, report, issues, truncated };
}

function compileRepeatStep(
  index: number,
  r: Record<string, unknown>,
  baseValues: Record<string, number>,
  ops: EditOp[]
): StepReport {
  const indexVar = typeof r.indexVar === "string" ? r.indexVar : "";
  if (!indexVar || !isValidVariableName(indexVar)) {
    return { index, kind: "repeat", applied: 0, rejected: 1, reasons: ["repeat.indexVar must be a valid variable name"] };
  }

  let times: number;
  if (typeof r.times === "number") {
    times = r.times;
  } else if (typeof r.times === "string") {
    const t = evalExpr(r.times, baseValues);
    if (!t.ok) return { index, kind: "repeat", applied: 0, rejected: 1, reasons: [`repeat.times: ${t.error}`] };
    times = t.value;
  } else {
    return { index, kind: "repeat", applied: 0, rejected: 1, reasons: ["repeat.times must be a number or expression string"] };
  }
  times = Math.max(0, Math.min(MAX_REPEAT_TIMES, Math.floor(times)));

  const body = Array.isArray(r.body) ? r.body : [];
  const reasons: string[] = [];
  let applied = 0;
  let rejected = 0;

  for (let n = 0; n < times; n++) {
    if (ops.length >= MAX_TOTAL_OPS) break;
    const iterValues = { ...baseValues, [indexVar]: n };
    for (const rawBodyOp of body) {
      if (ops.length >= MAX_TOTAL_OPS) break;
      const validated = validateEditOp(rawBodyOp);
      if (!validated) {
        rejected++;
        reasons.push(`iteration ${n}: invalid op`);
        continue;
      }
      // Stored operand queries are refused in repeat bodies: a bucket query's
      // producing index addresses the list AS AUTHORED, but every iteration
      // bakes into a DIFFERENT final list position — a query that resolves
      // against the authored list is meaningless (and misleadingly resolvable)
      // against the baked one.
      if (validated.targetQueries !== undefined) {
        rejected++;
        reasons.push(`iteration ${n}: targetQueries cannot be used inside a repeat body (indices are baked, not replayed)`);
        continue;
      }
      const baked = bakeAndStripExprs(validated, iterValues, reasons, n);
      if (!baked) {
        rejected++;
        continue;
      }
      ops.push(baked);
      applied++;
    }
  }
  return { index, kind: "repeat", applied, rejected, reasons };
}

/** Resolves every `exprs`-bound field on `op` against `values`, then DROPS
 * `exprs` entirely — see this file's doc comment for why repeat-generated
 * ops are baked rather than left parametrically live. */
function bakeAndStripExprs(op: EditOp, values: Record<string, number>, reasons: string[], iteration: number): EditOp | null {
  if (!op.exprs) return op;
  const clone = JSON.parse(JSON.stringify(op)) as EditOp & Record<string, unknown>;
  for (const [key, expr] of Object.entries(op.exprs)) {
    const fieldPath = parseFieldPath(key);
    if (!fieldPath) continue; // can't happen post-validate; belt and braces
    const r = evalExpr(expr, values);
    if (!r.ok) {
      reasons.push(`iteration ${iteration}: ${key} = "${expr}" — ${r.error}`);
      return null;
    }
    setNumericField(clone, fieldPath, r.value);
  }
  delete clone.exprs;
  const revalidated = validateEditOp(clone);
  if (!revalidated) {
    reasons.push(`iteration ${iteration}: resolved values are invalid`);
    return null;
  }
  return revalidated;
}
