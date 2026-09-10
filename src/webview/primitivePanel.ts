/** Locally-typed mirror of `PrimitiveReport`/`SolidRecognition`
 * (`src/primitiveReport.ts`) — this file is plain DOM manipulation with no
 * dependency of its own on the OCCT-touching module, matching every other
 * sidebar panel class in this codebase (`meshHealthPanel.ts`/
 * `regionFitPanel.ts`/`clashPanel.ts`) which are similarly DOM-only and
 * unit-test-free (no jsdom in this project's vitest config — verified via
 * manual F5 + `test:webview` only). */
export interface PrimitiveSolidDisplay {
  solidId: string;
  faceCount: number;
  inventory: Record<string, number>;
  candidateKind: string | null;
  candidateSummary: string | null;
  fitResidual: number | null;
  fitResidualFrac: number | null;
  reason?: string;
}

export interface PrimitiveReportDisplay {
  solidCount: number;
  solids: PrimitiveSolidDisplay[];
}

export interface PrimitivePanelCallbacks {
  onRecognize: () => void;
  onApply: () => void;
  onExport: () => void;
  onSaveMacro: () => void;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Math.abs(n) < 1e-4 || Math.abs(n) >= 1e6 ? n.toExponential(3) : Number(n.toPrecision(6)).toString();
}

/**
 * "Primitive-recognition panel" (Tier 2, closed) — the interactive B-rep half
 * of `recognize_primitives`/`decompose_to_primitives`. `render()` shows the
 * read-only report (face inventory by surface type, candidate + fit residual
 * per solid, honest `candidate: null` + reason for anything that doesn't match
 * a signature exactly — never a guess). The three action buttons are enabled
 * only once a report shows at least one recognized solid — a cheap, UI-only
 * safety net against a doomed click; clicking one does NOT modify the
 * currently-open document in place (Apply pushes onto the webview's own op
 * stack via `EditsModel`, Export/Save-macro are host-owned one-shot flows via
 * parameter-free button messages, same shape as Mesh Health's Promote/Repair).
 */
export class PrimitivePanel {
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly recognizeButton: HTMLButtonElement | null;
  private readonly applyButton: HTMLButtonElement | null;
  private readonly exportButton: HTMLButtonElement | null;
  private readonly saveMacroButton: HTMLButtonElement | null;

  constructor(panel: HTMLElement, cb: PrimitivePanelCallbacks) {
    this.panel = panel;
    this.body = panel.querySelector("#primitives-body")!;
    this.recognizeButton = panel.querySelector("#primitives-recognize");
    this.applyButton = panel.querySelector("#primitives-apply");
    this.exportButton = panel.querySelector("#primitives-export");
    this.saveMacroButton = panel.querySelector("#primitives-save-macro");
    this.recognizeButton?.addEventListener("click", () => cb.onRecognize());
    this.applyButton?.addEventListener("click", () => cb.onApply());
    this.exportButton?.addEventListener("click", () => cb.onExport());
    this.saveMacroButton?.addEventListener("click", () => cb.onSaveMacro());
  }

  /** Shows or hides the whole panel — only a B-rep source has exact analytic
   * surfaces for `recognizePrimitives` to classify (same gate
   * `recognize_primitives`' MCP tool applies, inverted from Mesh Health's). */
  setEligible(eligible: boolean): void {
    this.panel.hidden = !eligible;
    this.setBusy(false); // a new model supersedes any in-flight recognition
    this.setActionsEnabled(false);
    if (eligible) this.renderMessage("Click Recognize to classify each solid.");
  }

  setBusy(busy: boolean): void {
    if (this.recognizeButton) this.recognizeButton.disabled = busy;
  }

  private setActionsEnabled(enabled: boolean): void {
    if (this.applyButton) this.applyButton.disabled = !enabled;
    if (this.exportButton) this.exportButton.disabled = !enabled;
    if (this.saveMacroButton) this.saveMacroButton.disabled = !enabled;
  }

  renderMessage(text: string, isError = false): void {
    this.body.innerHTML = "";
    this.setActionsEnabled(false);
    const p = document.createElement("div");
    p.className = isError ? "primitives-message primitives-message-error" : "primitives-message";
    p.textContent = text;
    this.body.appendChild(p);
  }

  render(report: PrimitiveReportDisplay): void {
    this.body.innerHTML = "";
    const recognized = report.solids.filter((s) => s.candidateKind !== null);
    this.setActionsEnabled(recognized.length > 0);
    if (report.solids.length === 0) {
      this.renderMessage("No solids found.");
      return;
    }
    const header = document.createElement("div");
    header.className = "primitives-message";
    header.textContent =
      recognized.length > 0
        ? `${report.solidCount} solid(s) · ${recognized.length} recognized`
        : `${report.solidCount} solid(s) · none recognized — not a primitive assembly`;
    this.body.appendChild(header);
    for (const s of report.solids) {
      const group = document.createElement("div");
      group.className = "primitives-solid";

      const title = document.createElement("div");
      title.className = "primitives-solid-title";
      title.textContent = `${s.solidId} (${s.faceCount} faces)`;
      group.appendChild(title);

      const rows: Array<[string, string]> = [];
      const inv = Object.entries(s.inventory)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} ×${n}`)
        .join(", ");
      rows.push(["Faces", inv || "—"]);
      if (s.candidateKind !== null) {
        rows.push(["Candidate", s.candidateSummary ?? s.candidateKind]);
        rows.push(["Fit residual", s.fitResidual != null ? fmt(s.fitResidual) : "—"]);
        rows.push([
          "Fit residual (frac)",
          s.fitResidualFrac != null ? s.fitResidualFrac.toExponential(2) : "—",
        ]);
      } else {
        rows.push(["Candidate", "none — not a recognized primitive"]);
      }
      if (s.reason) rows.push(["Note", s.reason]);
      for (const [label, value] of rows) {
        const row = document.createElement("div");
        row.className = "primitives-row";
        const l = document.createElement("span");
        l.className = "primitives-label";
        l.textContent = label;
        const v = document.createElement("span");
        v.className = "primitives-value";
        v.textContent = value;
        row.appendChild(l);
        row.appendChild(v);
        group.appendChild(row);
      }
      this.body.appendChild(group);
    }
  }
}
