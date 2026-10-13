import type { ScadParameter, ScadValue } from "../scadParams";

/**
 * The OpenSCAD Customizer sidebar section — the interactive half of
 * `list_scad_parameters` / `convert_scad` (roadmap "OpenSCAD Customizer panel
 * in the viewer").
 *
 * Plain DOM manipulation with no OCCT/WASM dependency, matching every other
 * sidebar panel class in this codebase (`primitivePanel.ts`/
 * `meshHealthPanel.ts`/…), which are similarly DOM-only and unit-test-free —
 * there is no jsdom in this project's vitest config, so these are verified
 * via `test:webview` only.
 *
 * Reads nothing from disk itself: the host parses the `.scad` source text
 * with the same `parseScadParameters` the MCP tool uses and posts the result
 * (`scadParams`), plus the persisted overrides (`scadOverrides`). Apply posts
 * the form's values back (`scadApplyOverrides`); the host validates them with
 * `validateScadOverrides` (unknown names and wrong types dropped with a
 * warning, out-of-range applied with a note — the `convert_scad` rule),
 * persists the validated set, and reloads the geometry. The source file itself
 * is never written.
 */

export interface ScadCustomizerPanelCallbacks {
  /** Apply the form's current values as overrides. */
  onApply: (overrides: Record<string, unknown>) => void;
  /** Clear all overrides back to the file's authored defaults. */
  onReset: () => void;
}

function fmtDefault(value: ScadValue): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return value;
  return `[${value.map((v) => (typeof v === "number" ? String(v) : JSON.stringify(v))).join(", ")}]`;
}

function parseVectorText(text: string): Array<number | string> | null {
  const t = text.trim();
  if (t === "") return null;
  const inner = t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1) : t;
  const parts = inner.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (parts.length === 0) return null;
  const out: Array<number | string> = [];
  for (const p of parts) {
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(p)) out.push(Number(p));
    else if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
      try {
        out.push(JSON.parse(p) as string);
      } catch {
        out.push(p.slice(1, -1));
      }
    } else out.push(p);
  }
  return out;
}

export class ScadCustomizerPanel {
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly applyButton: HTMLButtonElement | null;
  private readonly resetButton: HTMLButtonElement | null;
  private params: ScadParameter[] = [];
  private overrides: Record<string, ScadValue> = {};

  constructor(panel: HTMLElement, cb: ScadCustomizerPanelCallbacks) {
    this.panel = panel;
    this.body = panel.querySelector("#scad-body") as HTMLElement;
    this.statusEl = panel.querySelector("#scad-status") as HTMLElement;
    this.applyButton = panel.querySelector("#scad-apply");
    this.resetButton = panel.querySelector("#scad-reset");
    this.applyButton?.addEventListener("click", () => cb.onApply(this.readForm()));
    this.resetButton?.addEventListener("click", () => cb.onReset());
  }

  /** Shows or hides the whole panel — only a `.scad` source has Customizer parameters. */
  setEligible(eligible: boolean): void {
    this.panel.hidden = !eligible;
    if (eligible && this.params.length === 0) this.renderMessage("Loading parameters…");
  }

  setBusy(busy: boolean): void {
    if (this.applyButton) this.applyButton.disabled = busy;
    if (this.resetButton) this.resetButton.disabled = busy;
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  renderMessage(text: string): void {
    this.body.innerHTML = "";
    const p = document.createElement("div");
    p.className = "scad-message";
    p.textContent = text;
    this.body.appendChild(p);
  }

  render(params: ScadParameter[], overrides: Record<string, ScadValue>): void {
    this.params = params;
    this.overrides = { ...overrides };
    this.body.innerHTML = "";
    if (params.length === 0) {
      this.renderMessage("No Customizer parameters found — the file can still be converted unchanged.");
      return;
    }
    let lastGroup: string | null = null;
    for (const param of params) {
      if (param.group !== lastGroup) {
        lastGroup = param.group;
        const h = document.createElement("div");
        h.className = "scad-group";
        h.textContent = param.group === "" ? "Parameters" : param.group;
        this.body.appendChild(h);
      }
      this.body.appendChild(this.rowFor(param, overrides[param.name]));
    }
  }

  /** Current form values by parameter name, for the Apply post. */
  readForm(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const param of this.params) {
      const el = this.body.querySelector(`[data-scad-name="${CSS.escape(param.name)}"]`) as
        | HTMLInputElement
        | HTMLSelectElement
        | null;
      if (!el) continue;
      if (param.options && param.options.length > 0) {
        const idx = Number((el as HTMLSelectElement).value);
        const opt = param.options[idx];
        if (opt !== undefined) out[param.name] = opt.value;
        continue;
      }
      if (param.kind === "boolean") {
        out[param.name] = (el as HTMLInputElement).checked;
        continue;
      }
      if (param.kind === "number") {
        const raw = (el as HTMLInputElement).value.trim();
        if (raw === "") continue;
        const n = Number(raw);
        out[param.name] = Number.isFinite(n) ? n : raw;
        continue;
      }
      if (param.kind === "vector") {
        const raw = (el as HTMLInputElement).value.trim();
        if (raw === "") continue;
        out[param.name] = parseVectorText(raw) ?? raw;
        continue;
      }
      out[param.name] = (el as HTMLInputElement).value;
    }
    return out;
  }

  private rowFor(param: ScadParameter, override: ScadValue | undefined): HTMLElement {
    const row = document.createElement("div");
    row.className = "scad-row";
    const label = document.createElement("label");
    label.className = "scad-label";
    label.textContent = param.name;
    const hint: string[] = [];
    if (param.description) hint.push(param.description);
    hint.push(`default ${fmtDefault(param.default)}`);
    if (param.min !== undefined || param.max !== undefined) {
      hint.push(`range ${param.min ?? "−"}…${param.max ?? "−"}`);
    }
    label.title = hint.join(" — ");
    row.appendChild(label);

    const current: ScadValue = override ?? param.default;
    if (param.options && param.options.length > 0) {
      const select = document.createElement("select");
      select.className = "scad-input";
      select.dataset.scadName = param.name;
      select.title = label.title;
      param.options.forEach((opt, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = opt.label ?? String(opt.value);
        if (opt.value === current) o.selected = true;
        select.appendChild(o);
      });
      // An override outside the declared list still applies (OpenSCAD does
      // not clamp); show it as-is rather than silently resetting the field.
      if (!param.options.some((o) => o.value === current)) {
        const o = document.createElement("option");
        o.value = String(param.options.length);
        o.textContent = fmtDefault(current);
        o.selected = true;
        select.appendChild(o);
      }
      row.appendChild(select);
      return row;
    }
    if (param.kind === "boolean") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "scad-input";
      input.dataset.scadName = param.name;
      input.title = label.title;
      input.checked = typeof current === "boolean" ? current : param.default === true;
      row.appendChild(input);
      return row;
    }
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = param.kind === "number" ? "decimal" : "text";
    input.className = "scad-input";
    input.dataset.scadName = param.name;
    input.title = label.title;
    input.placeholder = fmtDefault(param.default);
    input.value = override === undefined ? "" : fmtDefault(override);
    row.appendChild(input);
    return row;
  }
}
