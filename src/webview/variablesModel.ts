import { canMoveVariable, importVariableRows, type ParamVariable, type VariableImportResult } from "../editVariables";
import { isValidVariableName } from "../paramExpr";

/**
 * In-webview store of the document's named parametric variables. Pure data +
 * operations (no DOM), mirroring `PartsModel`/`EditsModel`. Every mutation
 * fires `onChange`, which the wiring uses to re-resolve the op list, re-render
 * the panels, and persist the sidecar. {@link load} replaces the data WITHOUT
 * firing — it is the initial load from disk and must not echo back as a write.
 *
 * Variable mutations are deliberately NOT undoable ops: they live outside the
 * `EditsModel` stack, and undone/redone ops re-resolve against the current
 * values (resolve-on-read).
 */
export class VariablesModel {
  private vars: ParamVariable[] = [];

  /** "Apply each change as you leave its field" off: mutations accumulate and one {@link commit} fires onChange. */
  private deferred = false;
  private pending = false;
  private committed: ParamVariable[] = [];

  constructor(private readonly onChangeFn: () => void) {}

  private onChange(): void {
    if (this.deferred) this.pending = true;
    else this.onChangeFn();
  }

  get isDeferred(): boolean {
    return this.deferred;
  }

  get hasPendingChanges(): boolean {
    return this.pending;
  }

  /** Switch the apply mode. Turning deferral off commits anything pending. */
  setDeferred(on: boolean): void {
    if (on === this.deferred) return;
    this.deferred = on;
    if (on) {
      this.committed = this.vars.map(clone);
      this.pending = false;
    } else if (this.pending) {
      this.pending = false;
      this.onChangeFn();
    }
  }

  /** Apply every deferred change as ONE change event (one sidecar write). */
  commit(): void {
    if (!this.pending) return;
    this.pending = false;
    this.committed = this.vars.map(clone);
    this.onChangeFn();
  }

  /** Drop deferred changes, returning to the last committed list (no event: nothing was applied). */
  revert(): void {
    this.vars = this.committed.map(clone);
    this.pending = false;
  }

  /** Replaces all variables from a freshly-loaded sidecar (does not fire onChange). */
  load(vars: ParamVariable[]): void {
    this.vars = vars.map(clone);
    this.committed = this.vars.map(clone);
    this.pending = false;
  }

  list(): ParamVariable[] {
    return this.vars.map(clone);
  }

  get size(): number {
    return this.vars.length;
  }

  /** Adds a new variable with a fresh auto-name (`L1`, `L2`, …) and expr "0". */
  add(): void {
    let n = this.vars.length + 1;
    while (this.vars.some((v) => v.name === `L${n}`)) n++;
    this.vars.push({ name: `L${n}`, expr: "0", value: 0 });
    this.onChange();
  }

  /** Renames a variable; returns false (no change) for an invalid or duplicate name. */
  rename(index: number, name: string): boolean {
    const v = this.vars[index];
    const trimmed = name.trim();
    if (!v || !isValidVariableName(trimmed)) return false;
    if (this.vars.some((other, i) => i !== index && other.name === trimmed)) return false;
    if (v.name === trimmed) return true;
    v.name = trimmed;
    this.onChange();
    return true;
  }

  setExpr(index: number, expr: string): void {
    const v = this.vars[index];
    const trimmed = expr.trim();
    if (!v || !trimmed || v.expr === trimmed) return;
    v.expr = trimmed;
    this.onChange();
  }

  setComment(index: number, comment: string): void {
    const v = this.vars[index];
    const next = comment.trim().slice(0, 256);
    if (!v || (v.comment ?? "") === next) return;
    if (next) v.comment = next;
    else delete v.comment;
    this.onChange();
  }

  toggleFavourite(index: number): void {
    const v = this.vars[index];
    if (!v) return;
    if (v.favourite) delete v.favourite;
    else v.favourite = true;
    this.onChange();
  }

  /** Moves a variable by `delta` places. Returns `null` on success or the refusal message (define-above rule). */
  move(index: number, delta: number): string | null {
    const to = index + delta;
    const check = canMoveVariable(this.vars, index, to);
    if (!check.ok) return check.reason;
    if (index === to) return null;
    const [v] = this.vars.splice(index, 1);
    this.vars.splice(to, 0, v);
    this.onChange();
    return null;
  }

  /** Appends validated rows; rejected rows are reported, never half-imported. */
  importRows(rows: Array<{ name: string; expr: string; comment?: string }>): VariableImportResult {
    const res = importVariableRows(this.vars, rows);
    if (res.accepted.length) {
      this.vars.push(...res.accepted);
      this.onChange();
    }
    return res;
  }

  remove(index: number): void {
    if (index < 0 || index >= this.vars.length) return;
    this.vars.splice(index, 1);
    this.onChange();
  }
}

function clone(v: ParamVariable): ParamVariable {
  const out: ParamVariable = { name: v.name, expr: v.expr, value: v.value };
  if (v.comment) out.comment = v.comment;
  if (v.favourite) out.favourite = true;
  return out;
}
