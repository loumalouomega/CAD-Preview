/**
 * The Macros sidebar section — the interactive half of the saved-script library.
 *
 * Plain DOM manipulation with no dependency on the pure `scriptLibrary.ts`
 * module, matching every other sidebar panel class in this codebase
 * (`partsPanel.ts`/`meshingPanel.ts`/`meshHealthPanel.ts`), which are similarly
 * DOM-only and unit-test-free — there is no jsdom in this project's vitest
 * config, so these are verified via manual F5 only.
 *
 * Reads and writes the **same library JSON the MCP tools use**, so a macro
 * recorded by a human is directly runnable by an agent and vice versa — the
 * same interoperability the parts/edits/mesh sidecars already give the two
 * surfaces.
 */

/** A saved macro, as the host reports it. */
export interface MacroDisplay {
  name: string;
  description: string | null;
  parameters: { name: string; expr: string }[];
}

export interface MacrosPanelCallbacks {
  /** Run `name` with the parameter values currently typed into its row. */
  onRun: (name: string, parameters: Record<string, string>) => void;
  /** Save the current op stack as a new macro. */
  onSaveCurrent: () => void;
  onDelete: (name: string) => void;
}

export class MacrosPanel {
  private readonly bodyEl: HTMLElement;
  private macros: MacroDisplay[] = [];
  private statusText = "";
  /** Per-macro parameter values, kept across re-renders so a typed value
   * survives a refresh of the list. */
  private readonly values = new Map<string, Record<string, string>>();

  constructor(private readonly root: HTMLElement, private readonly cb: MacrosPanelCallbacks) {
    this.bodyEl = root.querySelector("#macros-body") as HTMLElement;
    root.querySelector("#macros-save")?.addEventListener("click", () => this.cb.onSaveCurrent());
  }

  setStatus(text: string): void {
    this.statusText = text;
    this.render();
  }

  render(macros: MacroDisplay[] = this.macros): void {
    this.macros = macros;
    this.bodyEl.textContent = "";

    if (this.statusText) {
      const status = document.createElement("div");
      status.className = "macros-status";
      status.textContent = this.statusText;
      this.bodyEl.appendChild(status);
    }

    if (macros.length === 0) {
      const empty = document.createElement("div");
      empty.className = "macros-empty";
      empty.textContent = "No saved macros. Apply some edits, then Save current.";
      this.bodyEl.appendChild(empty);
      return;
    }

    for (const macro of macros) {
      this.bodyEl.appendChild(this.macroRow(macro));
    }
  }

  private macroRow(macro: MacroDisplay): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "macro-item";

    const head = document.createElement("div");
    head.className = "macro-head";
    const name = document.createElement("span");
    name.className = "macro-name";
    name.textContent = macro.name;
    if (macro.description) name.title = macro.description;
    head.appendChild(name);

    const run = document.createElement("button");
    run.className = "macro-btn";
    run.textContent = "Run";
    run.title = macro.description ?? `Run ${macro.name}`;
    run.addEventListener("click", () => this.cb.onRun(macro.name, this.valuesFor(macro)));
    head.appendChild(run);

    const del = document.createElement("button");
    del.className = "macro-btn";
    del.textContent = "✕";
    del.title = `Delete ${macro.name}`;
    del.addEventListener("click", () => this.cb.onDelete(macro.name));
    head.appendChild(del);

    wrap.appendChild(head);

    // A macro's own variables ARE its parameters — one field each, seeded with
    // the saved default so running without editing reproduces the saved macro.
    for (const p of macro.parameters) {
      const row = document.createElement("label");
      row.className = "macro-param";
      const label = document.createElement("span");
      label.className = "macro-param-name";
      label.textContent = p.name;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "macro-param-input";
      input.value = this.valuesFor(macro)[p.name] ?? p.expr;
      input.title = `Default: ${p.expr}`;
      input.addEventListener("input", () => {
        const current = this.values.get(macro.name) ?? {};
        current[p.name] = input.value;
        this.values.set(macro.name, current);
      });
      row.append(label, input);
      wrap.appendChild(row);
    }

    return wrap;
  }

  private valuesFor(macro: MacroDisplay): Record<string, string> {
    const stored = this.values.get(macro.name);
    if (stored) return stored;
    const seeded: Record<string, string> = {};
    for (const p of macro.parameters) seeded[p.name] = p.expr;
    this.values.set(macro.name, seeded);
    return seeded;
  }
}
