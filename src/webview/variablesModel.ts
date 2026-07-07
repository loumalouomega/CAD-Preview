import type { ParamVariable } from "../editVariables";
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

  constructor(private readonly onChange: () => void) {}

  /** Replaces all variables from a freshly-loaded sidecar (does not fire onChange). */
  load(vars: ParamVariable[]): void {
    this.vars = vars.map(clone);
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

  remove(index: number): void {
    if (index < 0 || index >= this.vars.length) return;
    this.vars.splice(index, 1);
    this.onChange();
  }
}

function clone(v: ParamVariable): ParamVariable {
  return { name: v.name, expr: v.expr, value: v.value };
}
