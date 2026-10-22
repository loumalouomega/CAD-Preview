/**
 * Draft panel (roadmap "Draft and undercut analysis") — the interactive half
 * of `check_draft`. Plain DOM, unit-test-free like every other sidebar panel
 * (covered by `test:webview`). Everything shown is a FACT from the host
 * report: the undercut figure is labelled as sampled and no row is a verdict.
 * Rows reuse the printability panel's row/message classes.
 */
import type { DraftFace, DraftReport } from "../draftAnalysis";

export interface DraftRequestParams {
  pull: string;
  minDraftDeg: number | undefined;
  twoSided: boolean;
}

export interface DraftPanelCallbacks {
  onCheck: (params: DraftRequestParams) => void;
  onClear: () => void;
  /** Hover a listed face to highlight it (null = restore). */
  onHighlight: (faceId: string | null) => void;
}

const fmt = (n: number) => String(Number(n.toPrecision(3)));

export class DraftPanel {
  private readonly body: HTMLElement;
  private readonly checkButton: HTMLButtonElement | null;
  private readonly pullSelect: HTMLSelectElement | null;
  private readonly minInput: HTMLInputElement | null;
  private readonly twoSidedBox: HTMLInputElement | null;

  constructor(private readonly panel: HTMLElement, private readonly cb: DraftPanelCallbacks) {
    this.body = panel.querySelector("#draft-body")!;
    this.checkButton = panel.querySelector("#draft-check");
    this.pullSelect = panel.querySelector("#draft-pull");
    this.minInput = panel.querySelector("#draft-min");
    this.twoSidedBox = panel.querySelector("#draft-two-sided");
    this.checkButton?.addEventListener("click", () => {
      const raw = (this.minInput?.value ?? "").trim();
      let min: number | undefined;
      if (raw !== "") {
        min = Number(raw);
        if (!(Number.isFinite(min) && min >= 0 && min < 90)) {
          this.renderMessage("The minimum draft must be a number from 0 up to (not including) 90 degrees.", true);
          return;
        }
      }
      cb.onCheck({ pull: this.pullSelect?.value || "+Z", minDraftDeg: min, twoSided: this.twoSidedBox?.checked === true });
    });
    panel.querySelector("#draft-clear")?.addEventListener("click", () => cb.onClear());
  }

  /** Any source with host-measurable triangles can be measured. */
  setEligible(eligible: boolean): void {
    this.panel.hidden = !eligible;
    this.setBusy(false);
    if (eligible) this.renderMessage("Click Check for draft and undercut facts along the pull direction. Nothing here is a pass/fail verdict.");
  }

  setBusy(busy: boolean): void {
    if (this.checkButton) this.checkButton.disabled = busy;
  }

  renderMessage(text: string, isError = false): void {
    this.body.innerHTML = "";
    const p = document.createElement("div");
    p.className = isError ? "printability-message printability-message-error" : "printability-message";
    p.textContent = text;
    this.body.appendChild(p);
  }

  private row(title: string, facts: string, warn = false, faceId?: string): void {
    const row = document.createElement("div");
    row.className = "printability-row" + (warn ? " warn" : "");
    const t = document.createElement("div");
    t.className = "printability-title";
    t.textContent = title;
    const f = document.createElement("div");
    f.className = "printability-facts";
    f.textContent = facts;
    row.append(t, f);
    if (faceId && /^face-\d+$/.test(faceId)) {
      row.addEventListener("mouseenter", () => this.cb.onHighlight(faceId));
      row.addEventListener("mouseleave", () => this.cb.onHighlight(null));
    }
    this.body.appendChild(row);
  }

  private faceRows(label: string, faces: DraftFace[], total: number, warn: boolean): void {
    if (total === 0) return;
    this.row(`${label} (${total}${faces.length < total ? `, worst ${faces.length} shown` : ""})`, "");
    for (const f of faces) {
      const draft = f.minDraftDeg === f.maxDraftDeg ? `${fmt(f.minDraftDeg)}°` : `${fmt(f.minDraftDeg)}° … ${fmt(f.maxDraftDeg)}°`;
      const shadow = f.shadowedFraction !== undefined && f.shadowedFraction > 0 ? ` · ${Math.round(f.shadowedFraction * 100)}% of samples shadowed` : "";
      this.row(f.id, `${draft} · ${fmt(f.area)} mm²${shadow}`, warn, f.id);
    }
  }

  render(report: DraftReport): void {
    this.body.innerHTML = "";
    if (report.faceCount === 0) {
      this.renderMessage("No triangles to measure.");
      return;
    }
    const head = document.createElement("div");
    head.className = "printability-message";
    head.textContent =
      `pull ${report.pull.map((v) => fmt(v)).join(", ")} · ${report.twoSided ? "two-sided" : "one-sided"} · minimum draft ${fmt(report.minDraftDeg)}° · ` +
      `${report.faceCount} faces (${report.capFaceCount} cap/parting) — facts; undercuts are sampled (${report.sampling.used} rays).`;
    this.body.appendChild(head);
    this.row(
      "Wall draft",
      report.minWallDraftDeg === null ? "no wall faces" : `${fmt(report.minWallDraftDeg)}° … ${fmt(report.maxWallDraftDeg!)}° · projected area ${fmt(report.projectedArea)} mm²`
    );
    this.faceRows("Walls lacking draft", report.zeroDraft, report.counts.zeroDraft, true);
    this.faceRows("Walls tilted away from the pull", report.negativeDraft, report.counts.negativeDraft, true);
    this.faceRows("Undercut (shadowed along the pull)", report.undercut, report.counts.undercut, true);
    if (report.counts.zeroDraft + report.counts.negativeDraft + report.counts.undercut === 0) this.row("Findings", "none at these thresholds");
    for (const w of report.warnings) this.row("Warning", w, true);
  }
}
