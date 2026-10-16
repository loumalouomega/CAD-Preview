/**
 * Printability panel (roadmap "Printability facts report") — the interactive
 * half of `check_printability`. Plain DOM, unit-test-free like every other
 * sidebar panel here (covered by `test:webview`). Everything shown is a FACT
 * from the host report; the wall figures are labelled as sampled estimates
 * and the rules the analysis cannot measure are listed as not checked.
 */
import type { Axis, PrintabilityReport } from "../printability";

export interface PrintabilityRequestParams {
  process: string | undefined;
  plate: string | undefined;
  up: Axis;
  overhangLimitDeg: number | undefined;
}

export interface PrintabilityPanelCallbacks {
  onCheck: (params: PrintabilityRequestParams) => void;
  onClear: () => void;
}

const fmt = (n: number) => String(Number(n.toPrecision(3)));

export class PrintabilityPanel {
  private readonly body: HTMLElement;
  private readonly checkButton: HTMLButtonElement | null;
  private readonly clearButton: HTMLButtonElement | null;
  private readonly processSelect: HTMLSelectElement | null;
  private readonly plateSelect: HTMLSelectElement | null;
  private readonly upSelect: HTMLSelectElement | null;
  private readonly limitInput: HTMLInputElement | null;

  constructor(private readonly panel: HTMLElement, private readonly cb: PrintabilityPanelCallbacks) {
    this.body = panel.querySelector("#printability-body")!;
    this.checkButton = panel.querySelector("#printability-check");
    this.clearButton = panel.querySelector("#printability-clear");
    this.processSelect = panel.querySelector("#printability-process");
    this.plateSelect = panel.querySelector("#printability-plate");
    this.upSelect = panel.querySelector("#printability-up");
    this.limitInput = panel.querySelector("#printability-limit");
    this.checkButton?.addEventListener("click", () => {
      const raw = (this.limitInput?.value ?? "").trim();
      let limit: number | undefined;
      if (raw !== "") {
        limit = Number(raw);
        if (!(Number.isFinite(limit) && limit > 0 && limit < 90)) {
          this.renderMessage("The overhang limit must be a number between 0 and 90 degrees.", true);
          return;
        }
      }
      cb.onCheck({
        process: this.processSelect?.value || undefined,
        plate: this.plateSelect?.value || undefined,
        up: (this.upSelect?.value || "+Z") as Axis,
        overhangLimitDeg: limit,
      });
    });
    this.clearButton?.addEventListener("click", () => cb.onClear());
  }

  /** Any source with triangles can be measured (a B-rep through its fine tessellation). */
  setEligible(eligible: boolean): void {
    this.panel.hidden = !eligible;
    this.setBusy(false);
    if (eligible) this.renderMessage("Click Check for overhang, wall-thickness and build-plate facts. Nothing here is a pass/fail verdict.");
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

  private row(title: string, facts: string, warn = false): void {
    const row = document.createElement("div");
    row.className = "printability-row" + (warn ? " warn" : "");
    const t = document.createElement("div");
    t.className = "printability-title";
    t.textContent = title;
    const f = document.createElement("div");
    f.className = "printability-facts";
    f.textContent = facts;
    row.append(t, f);
    this.body.appendChild(row);
  }

  render(report: PrintabilityReport, up: Axis): void {
    this.body.innerHTML = "";
    if (report.bodyCount === 0) {
      this.renderMessage("No triangles to measure.");
      return;
    }
    const head = document.createElement("div");
    head.className = "printability-message";
    head.textContent =
      `${report.bodyCount} body(ies) · ${report.triangles} triangles · overhang limit ${fmt(report.overhangLimitDeg)}° from vertical` +
      (report.process ? ` · ${report.process.name} (${report.process.source})` : "") +
      " — facts; wall thickness is sampled.";
    this.body.appendChild(head);
    if (report.unitsSuspect.suspect) this.row("Units", report.unitsSuspect.reason ?? "bounding box looks unusual", true);
    for (const b of report.bodies) {
      const w = b.wall;
      const wall =
        w.samples === 0
          ? "wall not sampled"
          : `wall min ${w.min === null ? "—" : fmt(w.min)} · p5 ${w.p5 === null ? "—" : fmt(w.p5)} · median ${w.median === null ? "—" : fmt(w.median)} mm (${w.samples} samples${w.noHit ? `, ${w.noHit} found no far wall` : ""})` +
            (w.belowMinWall !== undefined ? ` · ${w.belowMinWall} under the process minimum` : "");
      this.row(
        `Body ${b.index} · ${b.closed ? "closed" : `open (${b.freeEdges} free, ${b.nonManifoldEdges} non-manifold edges)`} · ${fmt(b.volume)} mm³`,
        wall,
        !b.closed || (w.belowMinWall ?? 0) > 0
      );
    }
    const o = report.orientations.find((x) => x.up === up) ?? report.orientations[0];
    if (o) {
      this.row(
        `Build ${o.up} (shown in the view)`,
        `overhang ${fmt(o.overhangArea)} mm² · plate contact ${fmt(o.plateContactArea)} mm² · support ≤ ${fmt(o.supportVolumeUpperBound)} mm³ · height ${fmt(o.buildHeight)} mm · footprint ${fmt(o.footprint[0])} × ${fmt(o.footprint[1])} mm` +
          (o.fitsPlate === undefined ? "" : o.fitsPlate ? " · fits the plate" : " · does NOT fit the plate"),
        o.fitsPlate === false
      );
    }
    const others = report.orientations
      .filter((x) => x !== o)
      .map((x) => `${x.up} ${fmt(x.overhangArea)}${x.fitsPlate === undefined ? "" : x.fitsPlate ? "" : " ✗"}`)
      .join(" · ");
    this.row("Overhang area (mm²) in the other directions", others);
    for (const n of report.notChecked) this.row(`Not checked: ${n.rule}`, n.reason);
    for (const w of report.warnings) this.row("Warning", w, true);
  }
}
