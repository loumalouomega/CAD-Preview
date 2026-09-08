export interface ClashPanelCallbacks {
  onCheck: (partA: string, partB: string) => void;
  onCheckAll: () => void;
}

/** One pair result with volumes already converted to the display unit (main.ts
 * rescales via `units.ts`, the same split `MassPropertiesPanel` uses — this
 * class never converts, it only labels). */
export interface ClashPairDisplay {
  partA: string;
  partB: string;
  hasOverlap: boolean;
  /** Converted overlap volume; `null` (rendered as "—") when no overlap. */
  overlapVolume: number | null;
  /** True when the AABB pre-filter decided without paying for a boolean. */
  screenedByBbox?: boolean;
  unresolvedA: string[];
  unresolvedB: string[];
}

export type ClashAllDisplay = ClashPairDisplay[];

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) return n.toExponential(3);
  return String(Number(n.toPrecision(6)));
}

/**
 * Clash (interference) sidebar section — the interactive counterpart of the
 * MCP-only `check_interference` / `check_interference_all` tools (roadmap
 * Tier 2 "Clash panel"). Two Part dropdowns for a pairwise check plus a
 * Check-all button over every Part with volumes; results render as text rows
 * (overlap Y/N, volume, AABB-screened badge, unresolved-id notes). B-rep
 * sources only — like `meshHealthPanel`, the section hides itself otherwise.
 * Display-only, session-only: nothing here is persisted, and results clear on
 * every model rebuild (ids may have been renumbered).
 */
export class ClashPanel {
  private readonly panel: HTMLElement;
  private readonly results: HTMLElement;
  private readonly selectA: HTMLSelectElement;
  private readonly selectB: HTMLSelectElement;
  private readonly checkBtn: HTMLButtonElement;
  private readonly checkAllBtn: HTMLButtonElement;

  constructor(panel: HTMLElement, cb: ClashPanelCallbacks) {
    this.panel = panel;
    this.results = panel.querySelector("#clash-results")!;
    this.selectA = panel.querySelector("#clash-a")!;
    this.selectB = panel.querySelector("#clash-b")!;
    this.checkBtn = panel.querySelector("#clash-check")!;
    this.checkAllBtn = panel.querySelector("#clash-check-all")!;
    this.checkBtn.addEventListener("click", () => {
      if (this.selectA.value && this.selectB.value) cb.onCheck(this.selectA.value, this.selectB.value);
    });
    this.checkAllBtn.addEventListener("click", () => cb.onCheckAll());
    for (const sel of [this.selectA, this.selectB]) {
      sel.addEventListener("change", () => this.reflectCheckEnabled());
    }
  }

  /** Shows the section only for B-rep sources (same `hidden`-attribute gate
   * `meshHealthPanel` uses — needs the `#clash-panel[hidden]` CSS override). */
  setEligible(eligible: boolean): void {
    this.panel.hidden = !eligible;
  }

  /** Repopulates both operand dropdowns, preserving each selection while it
   * still names a Part. Mirrors `meshingPanel.renderParts`. */
  renderParts(names: string[]): void {
    for (const [sel, keep] of [
      [this.selectA, this.selectA.value],
      [this.selectB, this.selectB.value],
    ] as const) {
      sel.innerHTML = "";
      for (const name of names) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      }
      if (names.includes(keep)) sel.value = keep;
    }
    // Default to the first two distinct Parts so Check works immediately.
    if (names.length >= 2 && this.selectA.value === this.selectB.value) {
      this.selectB.value = names.find((n) => n !== this.selectA.value) ?? names[1];
    }
    this.reflectCheckEnabled();
  }

  private reflectCheckEnabled(): void {
    const ok = this.selectA.options.length >= 2 && this.selectB.value !== "";
    this.checkBtn.disabled = !ok;
  }

  /** Disables both buttons while a host round trip is in flight. */
  setBusy(busy: boolean): void {
    this.checkBtn.disabled = busy || this.selectA.options.length < 2;
    this.checkAllBtn.disabled = busy;
  }

  /** Shows a plain status line — "Checking…", guidance, or an error. */
  renderMessage(text: string, isError = false): void {
    this.results.innerHTML = "";
    if (text === "") return;
    const p = document.createElement("div");
    p.className = isError ? "mass-message mass-message-error" : "mass-message";
    p.textContent = text;
    this.results.appendChild(p);
  }

  /** Clears results without a message (model rebuild — ids may be stale). */
  clear(): void {
    this.results.innerHTML = "";
  }

  renderPair(pair: ClashPairDisplay, unitLabel?: string): void {
    this.results.innerHTML = "";
    this.results.appendChild(this.pairRow(pair, unitLabel));
  }

  renderAll(pairs: ClashPairDisplay[], unitLabel?: string): void {
    this.results.innerHTML = "";
    if (pairs.length === 0) {
      this.renderMessage("No pairs to show.");
      return;
    }
    for (const pair of pairs) this.results.appendChild(this.pairRow(pair, unitLabel));
  }

  private pairRow(pair: ClashPairDisplay, unitLabel?: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "mass-row";
    const label = document.createElement("span");
    label.className = "mass-label";
    label.textContent = `${pair.partA} × ${pair.partB}`;
    const value = document.createElement("span");
    value.className = "mass-value";
    const volume = pair.overlapVolume;
    const suffix = unitLabel ? ` ${unitLabel}³` : "";
    value.textContent = pair.hasOverlap ? `overlap${volume != null ? ` ${formatNum(volume)}${suffix}` : ""}` : "no overlap";
    row.appendChild(label);
    row.appendChild(value);
    const notes: string[] = [];
    if (pair.screenedByBbox) notes.push("AABB-screened");
    if (pair.unresolvedA.length > 0) notes.push(`A unresolved: ${pair.unresolvedA.join(", ")}`);
    if (pair.unresolvedB.length > 0) notes.push(`B unresolved: ${pair.unresolvedB.join(", ")}`);
    if (notes.length > 0) {
      const note = document.createElement("div");
      note.className = "mass-message";
      note.textContent = notes.join(" · ");
      const wrap = document.createElement("div");
      wrap.appendChild(row);
      wrap.appendChild(note);
      return wrap;
    }
    return row;
  }
}
