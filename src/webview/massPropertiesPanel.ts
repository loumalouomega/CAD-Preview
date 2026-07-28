/** The subset of `MassProperties`/mesh-computed results the panel can display. */
export interface MassPropertiesDisplay {
  volume: number | null;
  area: number | null;
  length: number | null;
  centerOfMass: [number, number, number] | null;
  /** Only the diagonal terms are shown — the off-diagonal products of
   * inertia are near-zero for most axis-aligned bodies and not worth the
   * panel real estate. `null` for mesh sources (not computed client-side). */
  momentsOfInertia: { ixx: number; iyy: number; izz: number } | null;
}

export interface MassPropertiesPanelCallbacks {
  onRefresh: () => void;
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) return n.toExponential(3);
  return String(Number(n.toPrecision(6)));
}

/**
 * Renders whole-model or single-entity mass properties (volume/area/length,
 * center of mass, moments of inertia) as a small label/value list — the same
 * lightweight status-readout style `MeshingPanel`'s stats line uses, just
 * with more than one line. Display-only: nothing here is persisted.
 */
export class MassPropertiesPanel {
  private readonly body: HTMLElement;

  constructor(panel: HTMLElement, cb: MassPropertiesPanelCallbacks) {
    this.body = panel.querySelector("#mass-body")!;
    panel.querySelector("#mass-refresh")?.addEventListener("click", () => cb.onRefresh());
  }

  /** Shows a plain status line — "Computing…", a guidance message, or an error. */
  renderMessage(text: string, isError = false): void {
    this.body.innerHTML = "";
    const p = document.createElement("div");
    p.className = isError ? "mass-message mass-message-error" : "mass-message";
    p.textContent = text;
    this.body.appendChild(p);
  }

  /** Renders a computed result. Each field is independently optional/null. */
  render(props: MassPropertiesDisplay): void {
    this.body.innerHTML = "";
    const rows: Array<[string, string]> = [];
    if (props.volume != null) rows.push(["Volume", formatNum(props.volume)]);
    if (props.area != null) rows.push(["Area", formatNum(props.area)]);
    if (props.length != null) rows.push(["Length", formatNum(props.length)]);
    if (props.centerOfMass) {
      rows.push(["Center of mass", `(${props.centerOfMass.map(formatNum).join(", ")})`]);
    }
    if (props.momentsOfInertia) {
      const m = props.momentsOfInertia;
      rows.push(["Ixx, Iyy, Izz", `${formatNum(m.ixx)}, ${formatNum(m.iyy)}, ${formatNum(m.izz)}`]);
    }
    if (rows.length === 0) {
      this.renderMessage("Nothing to show.");
      return;
    }
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "mass-row";
      const l = document.createElement("span");
      l.className = "mass-label";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "mass-value";
      v.textContent = value;
      row.appendChild(l);
      row.appendChild(v);
      this.body.appendChild(row);
    }
  }
}
