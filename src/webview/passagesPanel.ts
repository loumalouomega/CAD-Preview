/**
 * Passages panel (roadmap "Narrow-gap and passage resolution preflight") —
 * the interactive half of `analyze_passages`. Plain DOM, unit-test-free like
 * every other sidebar panel here (no jsdom in the vitest config — covered by
 * `test:webview`). Findings are advisory estimates; "Apply local size" is an
 * explicit per-row action that goes through the ordinary Parts path (so it
 * persists and rebinds like any Part).
 */
import type { PassageFinding, PassageReport } from "../passageAnalysis";

export interface PassagesPanelCallbacks {
  onAnalyze: (targetCells: number) => void;
  onApply: (finding: PassageFinding) => void;
  onHighlight: (faceIds: string[] | null) => void;
}

const fmt = (n: number) => String(Number(n.toPrecision(3)));

export class PassagesPanel {
  private readonly body: HTMLElement;
  private readonly analyzeButton: HTMLButtonElement | null;
  private readonly cellsInput: HTMLInputElement | null;

  constructor(private readonly panel: HTMLElement, private readonly cb: PassagesPanelCallbacks) {
    this.body = panel.querySelector("#passages-body")!;
    this.analyzeButton = panel.querySelector("#passages-analyze");
    this.cellsInput = panel.querySelector("#passages-cells");
    this.analyzeButton?.addEventListener("click", () => {
      const cells = Number(this.cellsInput?.value ?? 3);
      if (!(Number.isFinite(cells) && cells >= 1)) {
        this.renderMessage("Cells across must be a number ≥ 1.", true);
        return;
      }
      cb.onAnalyze(cells);
    });
  }

  /** Only a B-rep source has analytic cylinders/planes to measure. */
  setEligible(eligible: boolean): void {
    this.panel.hidden = !eligible;
    this.setBusy(false);
    if (eligible) this.renderMessage("Click Analyze to find narrow gaps and compare them with the mesh size.");
  }

  setBusy(busy: boolean): void {
    if (this.analyzeButton) this.analyzeButton.disabled = busy;
  }

  renderMessage(text: string, isError = false): void {
    this.body.innerHTML = "";
    const p = document.createElement("div");
    p.className = isError ? "passages-message passages-message-error" : "passages-message";
    p.textContent = text;
    this.body.appendChild(p);
  }

  render(report: PassageReport, sizeMax: number | null): void {
    this.body.innerHTML = "";
    if (report.findings.length === 0) {
      this.renderMessage(
        `No annular gaps or facing-plane slots found (${report.facesAnalyzed} faces analyzed)` +
          (report.rejected.length ? ` · ${report.rejected.length} coaxial pair(s) rejected: no axial overlap.` : ".")
      );
      return;
    }
    const head = document.createElement("div");
    head.className = "passages-message";
    const under = report.findings.filter((f) => f.underResolved).length;
    head.textContent =
      `${report.findings.length} passage(s) · ${under} under ${report.targetCells} cells across` +
      (sizeMax === null ? " · no global size set" : ` · global size ${fmt(sizeMax)} mm`) +
      " — estimates; a real mesh confirms them.";
    this.body.appendChild(head);
    for (const f of report.findings) {
      const row = document.createElement("div");
      row.className = "passage-row" + (f.underResolved ? " under" : "");
      row.dataset.faces = `${f.faceA},${f.faceB}`;
      const title = document.createElement("div");
      title.className = "passage-title";
      title.textContent = `${f.kind === "annular" ? "Annular gap" : "Slot"} ${fmt(f.width)} mm · ${f.faceA} / ${f.faceB}`;
      row.appendChild(title);
      const facts = document.createElement("div");
      facts.className = "passage-facts";
      facts.textContent =
        f.cellsAcross === null
          ? `no size set — suggested ${fmt(f.suggestedSize)} mm`
          : `≈${fmt(f.cellsAcross)} cells across at ${fmt(f.requestedSize!)} mm (${f.sizeSource}) · suggested ${fmt(f.suggestedSize)} mm`;
      row.appendChild(facts);
      row.addEventListener("pointerenter", () => this.cb.onHighlight([f.faceA, f.faceB]));
      row.addEventListener("pointerleave", () => this.cb.onHighlight(null));
      if (f.underResolved || f.cellsAcross === null) {
        const apply = document.createElement("button");
        apply.className = "passage-apply";
        apply.textContent = "Apply local size";
        apply.title = `Create/update a Part on ${f.faceA} and ${f.faceB} with meshSize ${fmt(f.suggestedSize)} mm`;
        apply.addEventListener("click", () => this.cb.onApply(f));
        row.appendChild(apply);
      }
      this.body.appendChild(row);
    }
  }
}
