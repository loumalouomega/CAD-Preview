/**
 * B-rep Health panel (roadmap "B-rep validity report", closed) — the
 * interactive half of `check_brep_health`. Plain DOM, unit-test-free like
 * every other sidebar panel here (covered by `test:webview`). Read-only: it
 * shows OCCT's own verdict and named statuses, never a repair. Hovering an
 * issue row highlights that face/edge (the Passages panel precedent) without
 * touching the working selection.
 */
import type { BrepHealthReport } from "../brepHealthReport";
import { summarizeBrepHealth } from "../brepHealthReport";

export interface BrepHealthPanelCallbacks {
  onCheck: () => void;
  onHighlight: (entity: { entityType: "surface" | "line" | "volume"; entityId: string } | null) => void;
}

function entityFor(id: string): { entityType: "surface" | "line" | "volume"; entityId: string } | null {
  if (id.startsWith("face-")) return { entityType: "surface", entityId: id };
  if (id.startsWith("edge-")) return { entityType: "line", entityId: id };
  if (id.startsWith("solid-")) return { entityType: "volume", entityId: id };
  return null; // shell-N is report-local — nothing in the scene carries it
}

export class BrepHealthPanel {
  private readonly body: HTMLElement;
  private readonly checkButton: HTMLButtonElement | null;

  constructor(private readonly panel: HTMLElement, private readonly cb: BrepHealthPanelCallbacks) {
    this.body = panel.querySelector("#brep-health-body")!;
    this.checkButton = panel.querySelector("#brep-health-check");
    this.checkButton?.addEventListener("click", () => cb.onCheck());
  }

  /** Only a B-rep source has a B-rep to check. */
  setEligible(eligible: boolean): void {
    this.panel.hidden = !eligible;
    this.setBusy(false);
    if (eligible) this.renderMessage("Click Check to run OCCT's validity checker on the edited model.");
  }

  setBusy(busy: boolean): void {
    if (this.checkButton) this.checkButton.disabled = busy;
  }

  renderMessage(text: string, isError = false): void {
    this.body.innerHTML = "";
    const p = document.createElement("div");
    p.className = isError ? "mesh-health-message mesh-health-message-error" : "mesh-health-message";
    p.textContent = text;
    this.body.appendChild(p);
  }

  private row(parent: HTMLElement, label: string, value: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "mesh-health-row";
    const l = document.createElement("span");
    l.className = "mesh-health-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "mesh-health-value";
    v.textContent = value;
    row.append(l, v);
    parent.appendChild(row);
    return row;
  }

  render(report: BrepHealthReport): void {
    this.body.innerHTML = "";
    const summary = document.createElement("div");
    summary.className = report.valid ? "mesh-health-message brep-health-summary" : "mesh-health-message mesh-health-message-error brep-health-summary";
    summary.textContent = summarizeBrepHealth(report);
    this.body.appendChild(summary);

    const overview = document.createElement("div");
    overview.className = "mesh-health-component";
    if (report.counters) {
      const c = report.counters;
      this.row(overview, "Solids / shells", `${c.solids} / ${c.shells}`);
      this.row(overview, "Faces / edges", `${c.faces} / ${c.edges}`);
      if (c.looseEdges || c.looseFaces || c.looseWires) {
        this.row(overview, "Loose edges / faces / wires", `${c.looseEdges} / ${c.looseFaces} / ${c.looseWires}`);
      }
    }
    this.row(overview, "Open-boundary edges", report.openBoundaryEdgeCount == null ? "—" : String(report.openBoundaryEdgeCount));
    this.row(overview, "Subshapes checked", `${report.analyzedSubshapes} in ${(report.elapsedMs / 1000).toFixed(1)} s`);
    this.body.appendChild(overview);

    for (const s of report.solids) {
      const group = document.createElement("div");
      group.className = "mesh-health-component";
      const title = document.createElement("div");
      title.className = "mesh-health-component-title";
      title.textContent = `${s.solidId} — ${s.valid ? "valid" : "invalid"}`;
      group.appendChild(title);
      this.row(group, "Shells (open)", `${s.shellCount} (${s.openShellCount})`);
      this.row(group, "Open-boundary edges", s.openBoundaryEdgeCount == null ? "—" : String(s.openBoundaryEdgeCount));
      this.body.appendChild(group);
    }

    if (report.issues.length === 0) return;
    const list = document.createElement("div");
    list.className = "mesh-health-component brep-health-issues";
    const title = document.createElement("div");
    title.className = "mesh-health-component-title";
    title.textContent =
      report.issueCount > report.issues.length
        ? `Issues (first ${report.issues.length} of ${report.issueCount})`
        : `Issues (${report.issueCount})`;
    list.appendChild(title);
    for (const issue of report.issues) {
      const row = this.row(list, issue.id, issue.statuses.length ? issue.statuses.join(", ") : issue.valid ? "—" : "invalid");
      row.classList.add("brep-health-issue");
      row.dataset.entityId = issue.id;
      const entity = entityFor(issue.id);
      if (entity) {
        row.addEventListener("pointerenter", () => this.cb.onHighlight(entity));
        row.addEventListener("pointerleave", () => this.cb.onHighlight(null));
      }
    }
    this.body.appendChild(list);
  }
}
