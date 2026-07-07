import type { ParamVariable } from "../editVariables";
import { TOOLBAR_ICONS } from "../toolbarIcons";

export interface VariablesPanelCallbacks {
  onAdd: () => void;
  onRename: (index: number, name: string) => boolean;
  onSetExpr: (index: number, expr: string) => void;
  onRemove: (index: number) => void;
}

/**
 * Renders the editable parametric-variables table inside the Edits panel: one
 * row per variable with an inline name `<input>`, an expression `<input>`, the
 * computed value (or its evaluation error), and a delete button that warns via
 * `title` when the variable is referenced by any op. VS Code webviews block
 * `prompt()`, so all editing is inline — same pattern as the Parts panel. The
 * panel holds no state: the wiring re-calls {@link render} after every change.
 */
export class VariablesPanel {
  private readonly body: HTMLElement;

  constructor(section: HTMLElement, private readonly cb: VariablesPanelCallbacks) {
    this.body = section.querySelector("#variables-body")!;
    section.querySelector("#variables-add")!.addEventListener("click", () => this.cb.onAdd());
  }

  /**
   * @param values evaluated name → value map (from `evaluateVariables`)
   * @param errors per-variable evaluation errors (failed vars show these instead of a value)
   * @param usage per-variable count of op-expression references (drives the delete warning)
   */
  render(
    vars: ParamVariable[],
    values: Record<string, number>,
    errors: Map<string, string>,
    usage: Map<string, number>
  ): void {
    this.body.innerHTML = "";
    vars.forEach((v, index) => this.body.appendChild(this.buildRow(v, index, values, errors, usage)));
  }

  private buildRow(
    v: ParamVariable,
    index: number,
    values: Record<string, number>,
    errors: Map<string, string>,
    usage: Map<string, number>
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "variable-row";

    const name = document.createElement("input");
    name.type = "text";
    name.className = "variable-name";
    name.value = v.name;
    name.title = "Variable name (letters, digits, _; must be unique)";
    name.spellcheck = false;
    name.addEventListener("change", () => {
      if (!this.cb.onRename(index, name.value)) name.value = v.name; // rejected: restore
    });
    row.appendChild(name);

    const eq = document.createElement("span");
    eq.className = "variable-eq";
    eq.textContent = "=";
    row.appendChild(eq);

    const expr = document.createElement("input");
    expr.type = "text";
    expr.className = "variable-expr";
    expr.value = v.expr;
    expr.title = "Expression: numbers, other variables defined above, + - * / ^ ( ), sqrt/abs/min/max/floor/ceil/round/sin/cos/tan (degrees), pi";
    expr.spellcheck = false;
    expr.addEventListener("change", () => this.cb.onSetExpr(index, expr.value));
    row.appendChild(expr);

    const value = document.createElement("span");
    value.className = "variable-value";
    const error = errors.get(v.name);
    if (error) {
      value.classList.add("variable-error");
      value.textContent = "⚠";
      value.title = `${error} — using last value ${formatValue(values[v.name])}`;
    } else {
      value.textContent = `= ${formatValue(values[v.name])}`;
    }
    row.appendChild(value);

    const del = document.createElement("button");
    del.className = "part-btn";
    del.innerHTML = TOOLBAR_ICONS.close;
    const uses = usage.get(v.name) ?? 0;
    del.title = uses > 0
      ? `Delete variable (referenced by ${uses} edit field${uses === 1 ? "" : "s"} — they will freeze at their current values)`
      : "Delete variable";
    del.addEventListener("click", () => this.cb.onRemove(index));
    row.appendChild(del);

    return row;
  }
}

function formatValue(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "?";
  // Round tiny float noise for display only (the model keeps full precision).
  return String(Math.round(n * 1e6) / 1e6);
}
