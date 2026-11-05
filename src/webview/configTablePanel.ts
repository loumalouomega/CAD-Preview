import { configurationTable, type ConfigurationState } from "../configurations";
import type { ParamVariable } from "../editVariables";

export interface ConfigTablePanelCallbacks {
  /** Each returns null on success or the refusal message. */
  onAdd: (name: string, copyFrom?: string) => string | null;
  onRemove: (name: string) => string | null;
  onRename: (from: string, to: string) => string | null;
  /** null = the plain variables ("Base"). */
  onActivate: (name: string | null) => string | null;
  onSetCell: (name: string, variable: string, expr: string, baseExpr: string) => string | null;
  /** 0-based op indices the configuration suppresses (the field shows 1-based, like the History rows). */
  onSetSuppressed: (name: string, indices: number[]) => string | null;
  report: (text: string, isError: boolean) => void;
}

function fmt(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

/**
 * Config Table (design table): configurations as rows, variables as columns.
 * Picking a row's radio makes it the active configuration; a cell edits that
 * configuration's override (empty = inherit the variable's own expression). A
 * cell that fails to evaluate is flagged and freezes at the variable's cached
 * value — never a crash. The section is built here (not in the static viewer
 * markup) and inserted into the Variables section, so the shipped DOM stays
 * untouched. Holds no state: the wiring re-calls {@link render}.
 */
export class ConfigTablePanel {
  readonly element: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly count: HTMLElement;
  private readonly body: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly status: HTMLElement;
  private readonly newName: HTMLInputElement;
  private open = false;

  constructor(host: HTMLElement, before: Element | null, private readonly cb: ConfigTablePanelCallbacks) {
    const el = document.createElement("div");
    el.id = "config-section";
    el.innerHTML = `
      <button id="config-toggle" type="button" aria-expanded="false" title="Named sets of variable values (a design table)">
        <span class="config-chevron" aria-hidden="true">▸</span> Configurations <span id="config-count"></span>
      </button>
      <div id="config-body" hidden>
        <div id="config-tools">
          <input id="config-new-name" type="text" placeholder="New configuration" spellcheck="false" maxlength="64" title="Name for a new configuration (a copy of the active one)">
          <button id="config-add" type="button" title="Add a configuration">Add</button>
        </div>
        <div id="config-grid" role="table" aria-label="Configurations by variable"></div>
        <div id="config-status"></div>
      </div>`;
    host.insertBefore(el, before);
    this.element = el;
    this.toggle = el.querySelector("#config-toggle")!;
    this.count = el.querySelector("#config-count")!;
    this.body = el.querySelector("#config-body")!;
    this.grid = el.querySelector("#config-grid")!;
    this.status = el.querySelector("#config-status")!;
    this.newName = el.querySelector("#config-new-name")!;
    this.toggle.addEventListener("click", () => this.setOpen(!this.open));
    const add = (): void => {
      const name = this.newName.value;
      if (name.trim() === "") return;
      const active = this.activeName;
      const err = this.cb.onAdd(name, active ?? undefined);
      if (err) this.cb.report(err, true);
      else this.newName.value = "";
    };
    el.querySelector("#config-add")!.addEventListener("click", add);
    this.newName.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") add();
    });
  }

  private activeName: string | null = null;

  setOpen(open: boolean): void {
    this.open = open;
    this.body.hidden = !open;
    this.toggle.setAttribute("aria-expanded", String(open));
    const chevron = this.toggle.querySelector(".config-chevron");
    if (chevron) chevron.textContent = open ? "▾" : "▸";
  }

  render(variables: ParamVariable[], state: ConfigurationState): void {
    this.activeName = state.activeConfiguration;
    this.count.textContent = state.configurations.length > 0 ? String(state.configurations.length) : "";
    this.status.textContent = state.activeConfiguration ? `Active: ${state.activeConfiguration}` : state.configurations.length > 0 ? "Active: Base (variables as written)" : "";
    this.grid.innerHTML = "";
    if (variables.length === 0) {
      const empty = document.createElement("div");
      empty.className = "config-empty";
      empty.textContent = "Add variables first; a configuration overrides their values.";
      this.grid.appendChild(empty);
      return;
    }
    const table = document.createElement("table");
    table.className = "config-table";
    const head = document.createElement("tr");
    const corner = document.createElement("th");
    corner.textContent = "Configuration";
    head.appendChild(corner);
    for (const v of variables) {
      const th = document.createElement("th");
      th.textContent = v.name;
      th.title = `${v.name} = ${v.expr}`;
      head.appendChild(th);
    }
    const suppressHead = document.createElement("th");
    suppressHead.textContent = "Suppress ops";
    suppressHead.title = "History row numbers this configuration skips on replay, e.g. 3, 5 (the stored ops never change)";
    head.appendChild(suppressHead);
    table.appendChild(head);

    for (const row of configurationTable(variables, state)) {
      const tr = document.createElement("tr");
      tr.className = "config-row" + (row.active ? " active" : "");
      tr.dataset.config = row.name ?? "";
      tr.dataset.base = row.name === null ? "1" : "0";

      const nameCell = document.createElement("td");
      nameCell.className = "config-name-cell";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "config-active";
      radio.className = "config-radio";
      radio.checked = row.active;
      radio.title = row.name === null ? "Use the variables as written" : `Apply "${row.name}"`;
      radio.setAttribute("aria-label", radio.title);
      radio.addEventListener("click", () => {
        const err = this.cb.onActivate(row.name);
        if (err) this.cb.report(err, true);
      });
      nameCell.appendChild(radio);
      if (row.name === null) {
        const label = document.createElement("span");
        label.className = "config-base-label";
        label.textContent = "Base";
        nameCell.appendChild(label);
      } else {
        const name = row.name;
        const input = document.createElement("input");
        input.type = "text";
        input.className = "config-name";
        input.value = name;
        input.spellcheck = false;
        input.title = "Configuration name";
        input.addEventListener("change", () => {
          const err = this.cb.onRename(name, input.value);
          if (err) {
            this.cb.report(err, true);
            input.value = name;
          }
        });
        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") input.blur();
          else if (e.key === "Escape") {
            input.value = name;
            input.blur();
          }
        });
        nameCell.appendChild(input);
        const del = document.createElement("button");
        del.type = "button";
        del.className = "config-delete";
        del.textContent = "×";
        del.title = `Delete configuration "${name}"`;
        del.setAttribute("aria-label", del.title);
        del.addEventListener("click", () => {
          const err = this.cb.onRemove(name);
          if (err) this.cb.report(err, true);
        });
        nameCell.appendChild(del);
      }
      tr.appendChild(nameCell);

      for (const cell of row.cells) {
        const td = document.createElement("td");
        td.className = "config-cell" + (cell.override !== null ? " overridden" : "") + (cell.error ? " error" : "");
        td.dataset.variable = cell.variable;
        const baseExpr = variables.find((v) => v.name === cell.variable)?.expr ?? "";
        if (row.name === null) {
          td.textContent = cell.error ? "⚠" : fmt(cell.value);
          td.title = cell.error ? `${cell.variable} = ${cell.expr}: ${cell.error}` : `${cell.variable} = ${cell.expr}`;
        } else {
          const name = row.name;
          const input = document.createElement("input");
          input.type = "text";
          input.className = "config-input";
          input.value = cell.override ?? "";
          input.placeholder = baseExpr;
          input.spellcheck = false;
          input.title = cell.error
            ? `${cell.variable} = ${cell.expr}: ${cell.error} (frozen at ${fmt(cell.value)})`
            : `${cell.variable} = ${cell.expr} → ${fmt(cell.value)}${cell.override === null ? " (inherited)" : ""}`;
          input.addEventListener("change", () => {
            const err = this.cb.onSetCell(name, cell.variable, input.value, baseExpr);
            if (err) {
              this.cb.report(err, true);
              input.value = cell.override ?? "";
            }
          });
          input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") input.blur();
            else if (e.key === "Escape") {
              input.value = cell.override ?? "";
              input.blur();
            }
          });
          td.appendChild(input);
          const val = document.createElement("span");
          val.className = "config-value";
          val.textContent = cell.error ? "⚠" : fmt(cell.value);
          td.appendChild(val);
        }
        tr.appendChild(td);
      }
      const sup = document.createElement("td");
      sup.className = "config-suppress-cell";
      if (row.name === null) sup.textContent = "—";
      else {
        const name = row.name;
        const shown = row.suppressed.map((i) => i + 1).join(", ");
        const input = document.createElement("input");
        input.type = "text";
        input.className = "config-suppress";
        input.value = shown;
        input.placeholder = "e.g. 3, 5";
        input.spellcheck = false;
        input.title = "History row numbers this configuration skips (1-based, comma separated)";
        input.addEventListener("change", () => {
          const parts = input.value.split(/[\s,]+/).filter((p) => p !== "");
          const nums = parts.map((p) => Number(p));
          if (nums.some((n) => !Number.isInteger(n) || n < 1)) {
            this.cb.report("Suppress ops takes history row numbers (1, 2, 3 …).", true);
            input.value = shown;
            return;
          }
          const err = this.cb.onSetSuppressed(name, nums.map((n) => n - 1));
          if (err) {
            this.cb.report(err, true);
            input.value = shown;
          }
        });
        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") input.blur();
          else if (e.key === "Escape") {
            input.value = shown;
            input.blur();
          }
        });
        sup.appendChild(input);
      }
      tr.appendChild(sup);
      table.appendChild(tr);
    }
    this.grid.appendChild(table);
  }
}
