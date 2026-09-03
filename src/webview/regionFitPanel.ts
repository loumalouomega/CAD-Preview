import type { MeshRegionFit } from "../fitMapping";

export interface RegionFitPanelCallbacks {
  onPickSeed: () => void;
  onSavePlane: () => void;
  onAddCylinder: () => void;
  onAddSphere: () => void;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Math.abs(n) < 1e-4 || Math.abs(n) >= 1e6 ? n.toExponential(3) : n.toFixed(4).replace(/\.?0+$/, "");
}

export class RegionFitPanel {
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly pickButton: HTMLButtonElement | null;
  private readonly savePlaneButton: HTMLButtonElement | null;
  private readonly addCylinderButton: HTMLButtonElement | null;
  private readonly addSphereButton: HTMLButtonElement | null;

  constructor(panel: HTMLElement, cb: RegionFitPanelCallbacks) {
    this.panel = panel;
    this.body = panel.querySelector("#region-fit-body")!;
    this.pickButton = panel.querySelector("#region-fit-pick");
    this.savePlaneButton = panel.querySelector("#region-fit-save-plane");
    this.addCylinderButton = panel.querySelector("#region-fit-add-cylinder");
    this.addSphereButton = panel.querySelector("#region-fit-add-sphere");
    this.pickButton?.addEventListener("click", () => cb.onPickSeed());
    this.savePlaneButton?.addEventListener("click", () => cb.onSavePlane());
    this.addCylinderButton?.addEventListener("click", () => cb.onAddCylinder());
    this.addSphereButton?.addEventListener("click", () => cb.onAddSphere());
  }

  setEligible(eligible: boolean): void {
    this.panel.hidden = !eligible;
    if (!eligible) return;
    if (this.pickButton) this.pickButton.disabled = false;
    this.renderMessage("Click Pick seed, then click a surface to fit a region.");
  }

  setPickArmed(armed: boolean): void {
    if (this.pickButton) this.pickButton.disabled = armed;
    if (armed) this.renderMessage("Click a surface to pick the fit seed…");
  }

  renderMessage(text: string, isError = false): void {
    this.body.innerHTML = "";
    if (this.savePlaneButton) this.savePlaneButton.disabled = true;
    if (this.addCylinderButton) this.addCylinderButton.disabled = true;
    if (this.addSphereButton) this.addSphereButton.disabled = true;
    const p = document.createElement("div");
    p.className = isError ? "region-fit-message region-fit-message-error" : "region-fit-message";
    p.textContent = text;
    this.body.appendChild(p);
  }

  render(fit: MeshRegionFit): void {
    this.body.innerHTML = "";
    const hasPlane = fit.candidates.some((c) => c.kind === "plane");
    const hasCyl = fit.candidates.some((c) => c.kind === "cylinder");
    const hasSph = fit.candidates.some((c) => c.kind === "sphere");
    if (this.savePlaneButton) this.savePlaneButton.disabled = !hasPlane;
    if (this.addCylinderButton) this.addCylinderButton.disabled = !hasCyl;
    if (this.addSphereButton) this.addSphereButton.disabled = !hasSph;

    if (fit.triangleCount === 0) {
      this.renderMessage(fit.warnings[0] ?? "No region.");
      return;
    }

    const header = document.createElement("div");
    header.className = "region-fit-header";
    header.textContent = `${fit.triangleCount} triangles${fit.capped ? " (capped)" : ""} · simplest: ${fit.simplest ?? "none"}`;
    this.body.appendChild(header);

    for (const w of fit.warnings) {
      const p = document.createElement("div");
      p.className = "region-fit-warning";
      p.textContent = w;
      this.body.appendChild(p);
    }

    for (const c of fit.candidates) {
      const row = document.createElement("div");
      row.className = "region-fit-candidate";
      const label = document.createElement("span");
      label.className = "region-fit-label";
      label.textContent = c.kind;
      const vals: string[] = [];
      if (c.primitive.kind === "plane") vals.push(`n=[${c.primitive.normal.map(fmt).join(", ")}]`);
      else if (c.primitive.kind === "cylinder") vals.push(`r=${fmt(c.primitive.radius)} h=${fmt(c.primitive.height)}`);
      else if (c.primitive.kind === "sphere") vals.push(`r=${fmt(c.primitive.radius)}`);
      vals.push(`residual ${c.residual !== null ? fmt(c.residual) : "—"} (${c.residualFrac !== null ? c.residualFrac.toExponential(2) : "—"})`);
      const v = document.createElement("span");
      v.className = "region-fit-value";
      v.textContent = vals.join(" · ");
      row.appendChild(label);
      row.appendChild(v);
      this.body.appendChild(row);
    }
  }
}
