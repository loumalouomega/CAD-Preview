/** Locally-typed mirror of `MeshHealthReport`/`ComponentHealthReport`
 * (`src/meshHeal.ts`) — this file is plain DOM manipulation with no
 * dependency of its own on the OCCT-touching module, matching every other
 * sidebar panel class in this codebase (`partsPanel.ts`/`meshingPanel.ts`/
 * `standardPartsPanel.ts`) which are similarly DOM-only and unit-test-free
 * (no jsdom in this project's vitest config — verified via manual F5 only). */
export interface ComponentHealthDisplay {
  index: number;
  triangleCount: number;
  freeEdgeCount: number;
  nonManifoldEdgeCount: number;
  degenerateFaceCount: number;
  requiredTolerance: number | null;
  areaDeltaPct: number | null;
  volumeDeltaPct: number | null;
}

export interface MeshHealthDisplay {
  componentCount: number;
  components: ComponentHealthDisplay[];
}

export interface MeshHealthPanelCallbacks {
  onCheck: () => void;
}

function formatPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(3)}%`;
}

function formatTolerance(t: number): string {
  return t.toExponential(0);
}

/**
 * "Mesh → B-rep promotion, diagnostic-first" — Phase 1 read-only heal-
 * quality report panel. Deliberately has NO promote/apply action — there is
 * nothing to apply yet (Phase 2, an actual promotion `EditOpKind`, is not
 * built). Mirrors `MassPropertiesPanel`'s "compute button + label/value
 * readout" shape, one row-group per connected component.
 */
export class MeshHealthPanel {
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;

  constructor(panel: HTMLElement, cb: MeshHealthPanelCallbacks) {
    this.panel = panel;
    this.body = panel.querySelector("#mesh-health-body")!;
    panel.querySelector("#mesh-health-check")?.addEventListener("click", () => cb.onCheck());
  }

  /** Shows or hides the whole panel — only a native STL/OBJ/PLY source has a
   * host-side triangle-soup parser to run this check against (same gate
   * `check_mesh_health`'s MCP tool applies); a B-rep source has nothing to
   * heal, and a meshio-converted or glTF source has no matching parser. */
  setEligible(eligible: boolean): void {
    this.panel.hidden = !eligible;
    if (eligible) this.renderMessage("Click Check Healability to run the diagnostic.");
  }

  renderMessage(text: string, isError = false): void {
    this.body.innerHTML = "";
    const p = document.createElement("div");
    p.className = isError ? "mesh-health-message mesh-health-message-error" : "mesh-health-message";
    p.textContent = text;
    this.body.appendChild(p);
  }

  render(report: MeshHealthDisplay): void {
    this.body.innerHTML = "";
    if (report.components.length === 0) {
      this.renderMessage("No triangles found.");
      return;
    }
    for (const c of report.components) {
      const group = document.createElement("div");
      group.className = "mesh-health-component";

      const title = document.createElement("div");
      title.className = "mesh-health-component-title";
      title.textContent = report.componentCount > 1 ? `Component ${c.index} (${c.triangleCount} triangles)` : `${c.triangleCount} triangles`;
      group.appendChild(title);

      const rows: Array<[string, string]> = [
        ["Free edges", String(c.freeEdgeCount)],
        ["Non-manifold edges", String(c.nonManifoldEdgeCount)],
        ["Degenerate faces", String(c.degenerateFaceCount)],
        ["Required sewing tolerance", c.requiredTolerance != null ? formatTolerance(c.requiredTolerance) : "did not close"],
      ];
      if (c.requiredTolerance != null) {
        rows.push(["Area delta", c.areaDeltaPct != null ? formatPct(c.areaDeltaPct) : "—"]);
        rows.push(["Volume delta", c.volumeDeltaPct != null ? formatPct(c.volumeDeltaPct) : "—"]);
      }
      for (const [label, value] of rows) {
        const row = document.createElement("div");
        row.className = "mesh-health-row";
        const l = document.createElement("span");
        l.className = "mesh-health-label";
        l.textContent = label;
        const v = document.createElement("span");
        v.className = "mesh-health-value";
        v.textContent = value;
        row.appendChild(l);
        row.appendChild(v);
        group.appendChild(row);
      }
      this.body.appendChild(group);
    }
  }
}
