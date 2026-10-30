/** Surface Tools panel (meshio++ 17.23): `project_to_cad` and `grow_prism_layers`
 * over the open STEP/IGES document. DOM-only, like every sidebar panel — the
 * request/result round trip and the file dialogs live in `main.ts` and the host
 * (`provider.ts` `handleSurfaceTool`). Facts only: the result rows are
 * label/value pairs the host already formatted. */
export interface SurfaceToolsParams {
  maxDistance: number;
  targetSize: number;
  firstHeight: number;
  numLayers: number;
  growth: number;
  reverse: boolean;
}

export interface SurfaceToolsCallbacks {
  onProject: (p: Pick<SurfaceToolsParams, "maxDistance">) => void;
  onPrism: (p: Omit<SurfaceToolsParams, "maxDistance">) => void;
}

export class SurfaceToolsPanel {
  private readonly panel: HTMLElement;
  private readonly result: HTMLElement;
  private readonly projectButton: HTMLButtonElement;
  private readonly prismButton: HTMLButtonElement;
  private readonly maxDistance: HTMLInputElement;
  private readonly size: HTMLInputElement;
  private readonly height: HTMLInputElement;
  private readonly layers: HTMLInputElement;
  private readonly growth: HTMLInputElement;
  private readonly reverse: HTMLInputElement;

  constructor(panel: HTMLElement, cb: SurfaceToolsCallbacks) {
    this.panel = panel;
    this.result = panel.querySelector("#surface-tools-result")!;
    this.projectButton = panel.querySelector("#surface-project")!;
    this.prismButton = panel.querySelector("#surface-prism")!;
    this.maxDistance = panel.querySelector("#surface-project-maxdist")!;
    this.size = panel.querySelector("#surface-prism-size")!;
    this.height = panel.querySelector("#surface-prism-height")!;
    this.layers = panel.querySelector("#surface-prism-layers")!;
    this.growth = panel.querySelector("#surface-prism-growth")!;
    this.reverse = panel.querySelector("#surface-prism-reverse")!;
    this.projectButton.addEventListener("click", () => {
      const v = Number(this.maxDistance.value);
      cb.onProject({ maxDistance: this.maxDistance.value.trim() !== "" && Number.isFinite(v) && v > 0 ? v : 0 });
    });
    this.prismButton.addEventListener("click", () => {
      const p = this.readPrism();
      if (typeof p === "string") {
        this.renderMessage(p, true);
        return;
      }
      cb.onPrism(p);
    });
  }

  /** Only a STEP/IGES source has exact NURBS faces to project onto or layer over. */
  setEligible(eligible: boolean): void {
    this.panel.hidden = !eligible;
    this.setBusy(false);
    this.result.textContent = "";
  }

  setBusy(busy: boolean): void {
    this.projectButton.disabled = busy;
    this.prismButton.disabled = busy;
  }

  private readPrism(): Omit<SurfaceToolsParams, "maxDistance"> | string {
    const targetSize = Number(this.size.value);
    const firstHeight = Number(this.height.value);
    const numLayers = Number(this.layers.value);
    const growth = Number(this.growth.value);
    if (!(targetSize > 0)) return "Surface size must be a positive length.";
    if (!(firstHeight > 0)) return "First height must be a positive length.";
    if (!(Number.isInteger(numLayers) && numLayers >= 1 && numLayers <= 1000)) return "Layers must be an integer from 1 to 1000.";
    if (!(growth >= 1 && growth <= 10)) return "Growth ratio must be between 1 and 10.";
    return { targetSize, firstHeight, numLayers, growth, reverse: this.reverse.checked };
  }

  renderMessage(text: string, isError = false): void {
    this.result.textContent = "";
    const p = document.createElement("div");
    p.className = isError ? "mesh-health-message mesh-health-message-error" : "mesh-health-message";
    p.textContent = text;
    this.result.appendChild(p);
  }

  renderResult(rows: ReadonlyArray<readonly [string, string]>, written: string, warnings: readonly string[]): void {
    this.result.textContent = "";
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "surface-result-row";
      const l = document.createElement("span");
      l.textContent = label;
      const v = document.createElement("span");
      v.textContent = value;
      row.append(l, v);
      this.result.appendChild(row);
    }
    const w = document.createElement("div");
    w.className = "surface-result-written";
    w.textContent = `Wrote ${written}`;
    this.result.appendChild(w);
    for (const text of warnings) {
      const e = document.createElement("div");
      e.className = "surface-result-warning";
      e.textContent = `⚠ ${text}`;
      this.result.appendChild(e);
    }
  }
}
