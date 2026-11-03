import { enumerateNumericFields, exprUnit, withExprUnit, type ParamVariable } from "../editVariables";
import type { EditOp } from "../editOps";
import { TOOLBAR_ICONS } from "../toolbarIcons";

export interface VariablesPanelCallbacks {
  onAdd: () => void;
  onRename: (index: number, name: string) => boolean;
  onSetExpr: (index: number, expr: string) => void;
  onRemove: (index: number) => void;
  onSetComment: (index: number, comment: string) => void;
  onToggleFavourite: (index: number) => void;
  /** Returns null on success, or the refusal message. */
  onMove: (index: number, delta: number) => string | null;
  /** Import file text; the wiring parses and reports. */
  onImport: (fileName: string, text: string) => void;
  onExport: (format: "csv" | "json") => void;
  onLiveChange: (live: boolean) => void;
  onApply: () => void;
  onRevert: () => void;
  /** Edit a stored op's numeric field (op index, field path, value). */
  onEditField: (opIndex: number, path: string, value: number) => void;
  onPromote: (opIndex: number, path: string) => void;
  report: (text: string, isError: boolean) => void;
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
  private readonly modelBody: HTMLElement;
  private readonly filter: HTMLInputElement;
  private readonly deferActions: HTMLElement;

  constructor(section: HTMLElement, private readonly cb: VariablesPanelCallbacks) {
    this.body = section.querySelector("#variables-body")!;
    this.modelBody = section.querySelector("#model-params-body")!;
    this.filter = section.querySelector("#variables-filter")!;
    this.deferActions = section.querySelector("#variables-defer-actions")!;
    section.querySelector("#variables-add")!.addEventListener("click", () => this.cb.onAdd());
    this.filter.addEventListener("input", () => this.applyFilter());
    const file = section.querySelector<HTMLInputElement>("#variables-import-file")!;
    section.querySelector("#variables-import")!.addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      file.value = "";
      if (!f) return;
      void f.text().then((t) => this.cb.onImport(f.name, t));
    });
    section.querySelector("#variables-export-csv")!.addEventListener("click", () => this.cb.onExport("csv"));
    section.querySelector("#variables-export-json")!.addEventListener("click", () => this.cb.onExport("json"));
    section.querySelector<HTMLInputElement>("#variables-live")!.addEventListener("change", (e) => this.cb.onLiveChange((e.target as HTMLInputElement).checked));
    section.querySelector("#variables-apply")!.addEventListener("click", () => this.cb.onApply());
    section.querySelector("#variables-revert")!.addEventListener("click", () => this.cb.onRevert());
  }

  /** Show the Apply/Revert pair only while changes are deferred. */
  setDeferState(deferred: boolean, pending: boolean): void {
    this.deferActions.hidden = !deferred;
    for (const b of this.deferActions.querySelectorAll("button")) (b as HTMLButtonElement).disabled = !pending;
  }

  private applyFilter(): void {
    const q = this.filter.value.trim().toLowerCase();
    for (const row of this.body.querySelectorAll<HTMLElement>(".variable-row")) {
      row.hidden = q !== "" && !(row.dataset.search ?? "").includes(q);
    }
  }

  /** Model parameters: every numeric field of every op, editable in place, with Promote to variable. */
  renderModelParams(ops: EditOp[], savePoint: number): void {
    this.modelBody.innerHTML = "";
    ops.forEach((op, opIndex) => {
      const fields = enumerateNumericFields(op);
      if (!fields.length) return;
      const locked = opIndex < savePoint;
      const group = document.createElement("div");
      group.className = "mp-group";
      group.textContent = `#${opIndex + 1} ${op.op}${locked ? " 🔒" : ""}`;
      this.modelBody.appendChild(group);
      for (const f of fields) {
        const row = document.createElement("div");
        row.className = "mp-row";
        const label = document.createElement("span");
        label.className = "mp-name";
        label.textContent = f.path;
        row.appendChild(label);
        if (f.expr !== undefined) {
          const e = document.createElement("span");
          e.className = "mp-expr";
          e.textContent = `= ${f.expr}`;
          e.title = "Driven by an expression; edit it in the op's form";
          row.appendChild(e);
        }
        const input = document.createElement("input");
        input.type = "text";
        input.className = "mp-value";
        input.value = String(Math.round(f.value * 1e6) / 1e6);
        input.disabled = locked || f.expr !== undefined;
        input.spellcheck = false;
        input.addEventListener("change", () => {
          const n = Number(input.value.trim());
          if (!Number.isFinite(n)) {
            this.cb.report(`"${input.value}" is not a number`, true);
            input.value = String(f.value);
            return;
          }
          this.cb.onEditField(opIndex, f.path, n);
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") input.blur();
          else if (e.key === "Escape") {
            input.value = String(f.value);
            input.blur();
          }
          e.stopPropagation();
        });
        row.appendChild(input);
        const promote = document.createElement("button");
        promote.className = "mp-promote";
        promote.textContent = "→ var";
        promote.title = locked ? "Saved into the file; cannot be changed" : "Promote to variable: create a variable and make this field follow it";
        promote.disabled = locked || f.expr !== undefined;
        promote.addEventListener("click", () => this.cb.onPromote(opIndex, f.path));
        row.appendChild(promote);
        this.modelBody.appendChild(row);
      }
    });
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
    // Favourites are pinned in the VIEW only; `index` stays the evaluation-order index.
    const order = vars.map((v, index) => ({ v, index }));
    order.sort((a, b) => Number(!!b.v.favourite) - Number(!!a.v.favourite) || a.index - b.index);
    for (const { v, index } of order) this.body.appendChild(this.buildRow(v, index, values, errors, usage, vars.length));
    this.applyFilter();
  }

  private buildRow(
    v: ParamVariable,
    index: number,
    values: Record<string, number>,
    errors: Map<string, string>,
    usage: Map<string, number>,
    count: number
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "variable-row";
    row.dataset.search = `${v.name} ${v.expr} ${v.comment ?? ""}`.toLowerCase();

    const star = document.createElement("button");
    star.className = "variable-star" + (v.favourite ? " on" : "");
    star.textContent = v.favourite ? "★" : "☆";
    star.title = v.favourite ? "Unpin from the top" : "Pin to the top of this table";
    star.addEventListener("click", () => this.cb.onToggleFavourite(index));
    row.appendChild(star);

    const name = document.createElement("input");
    name.type = "text";
    name.className = "variable-name";
    name.value = v.name;
    name.title = "Variable name (letters, digits, _; must be unique)";
    name.spellcheck = false;
    name.addEventListener("change", () => {
      if (!this.cb.onRename(index, name.value)) name.value = v.name; // rejected: restore
    });
    // Keyboard audit (roadmap "Sidebar layout and keyboard usability"): Escape
    // cancels — restoring the value BEFORE blur means `change` never fires, so
    // no half-typed name reaches `onRename`.
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        name.blur();
        e.stopPropagation();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        name.value = v.name;
        name.blur();
      }
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

    const unit = document.createElement("select");
    unit.className = "variable-unit";
    unit.title = "Unit written into the expression as [unit] (plain numbers only)";
    const current = exprUnit(v.expr);
    for (const u of ["", "mm", "cm", "m", "in", "ft", "deg", "rad"]) {
      const o = document.createElement("option");
      o.value = u;
      o.textContent = u || "—";
      unit.appendChild(o);
    }
    unit.value = current ?? "";
    unit.addEventListener("change", () => {
      const next = withExprUnit(v.expr, unit.value || null);
      if (next === null) {
        this.cb.report(`"${v.name}" is not a plain number; write the unit in the expression, e.g. (L*2)[in]`, true);
        unit.value = current ?? "";
        return;
      }
      this.cb.onSetExpr(index, next);
    });
    row.appendChild(unit);

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

    const comment = document.createElement("input");
    comment.type = "text";
    comment.className = "variable-comment";
    comment.value = v.comment ?? "";
    comment.placeholder = "comment";
    comment.spellcheck = false;
    comment.addEventListener("change", () => this.cb.onSetComment(index, comment.value));
    comment.addEventListener("keydown", (e) => {
      if (e.key === "Enter") comment.blur();
      else if (e.key === "Escape") {
        e.stopPropagation();
        comment.value = v.comment ?? "";
        comment.blur();
      }
    });
    row.appendChild(comment);

    for (const [delta, glyph] of [[-1, "▲"], [1, "▼"]] as const) {
      const mv = document.createElement("button");
      mv.className = "variable-move";
      mv.textContent = glyph;
      mv.title = delta < 0 ? "Move up (evaluation order)" : "Move down (evaluation order)";
      mv.disabled = (delta < 0 && index === 0) || (delta > 0 && index === count - 1);
      mv.addEventListener("click", () => {
        const refusal = this.cb.onMove(index, delta);
        if (refusal) this.cb.report(refusal, true);
      });
      row.appendChild(mv);
    }

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
