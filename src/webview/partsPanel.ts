import type { Part } from "../protocol";

export interface PartsPanelCallbacks {
  onCreate: () => void;
  onAssign: (index: number) => void;
  onRemovePart: (index: number) => void;
  onRename: (index: number, name: string) => void;
  onRecolor: (index: number, color: string) => void;
  onMeshSize: (index: number, size: number | undefined) => void;
  onRemoveEntity: (index: number, entityType: "volume" | "surface" | "line" | "point", entityId: string) => void;
  onSelectPart: (index: number | null) => void;
}

/**
 * Renders the editable Parts list: per-part colour swatch, inline-editable name,
 * entity counts, an "assign current selection" action, delete, and an expandable
 * list of assigned entities. VS Code webviews block `prompt()`, so renaming uses
 * an inline `<input>` rather than a dialog. Selecting a part row highlights its
 * entities via {@link PartsPanelCallbacks.onSelectPart}.
 */
export class PartsPanel {
  private readonly body: HTMLElement;
  private readonly newBtn: HTMLElement;
  private selectedIndex: number | null = null;

  constructor(
    private readonly panel: HTMLElement,
    private readonly cb: PartsPanelCallbacks
  ) {
    this.body = panel.querySelector("#parts-body")!;
    this.newBtn = panel.querySelector("#parts-new")!;
    this.newBtn.addEventListener("click", () => this.cb.onCreate());
  }

  render(parts: Part[]): void {
    this.body.innerHTML = "";
    if (this.selectedIndex !== null && this.selectedIndex >= parts.length) {
      this.selectedIndex = null;
    }
    parts.forEach((part, index) => this.body.appendChild(this.buildPart(part, index)));
  }

  private buildPart(part: Part, index: number): HTMLElement {
    const item = document.createElement("div");
    item.className = "part-item";
    if (index === this.selectedIndex) item.classList.add("selected");

    const row = document.createElement("div");
    row.className = "part-row";

    const chevron = document.createElement("span");
    chevron.className = "part-chevron";
    const total = part.volumes.length + part.surfaces.length + part.lines.length + part.points.length;
    chevron.textContent = total > 0 ? "▾" : " ";
    row.appendChild(chevron);

    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.className = "part-swatch";
    swatch.value = part.color;
    swatch.title = "Part colour";
    swatch.addEventListener("input", () => this.cb.onRecolor(index, swatch.value));
    swatch.addEventListener("click", (e) => e.stopPropagation());
    row.appendChild(swatch);

    const name = document.createElement("input");
    name.type = "text";
    name.className = "part-name";
    name.value = part.name;
    name.addEventListener("change", () => this.cb.onRename(index, name.value));
    name.addEventListener("click", (e) => e.stopPropagation());
    row.appendChild(name);

    const meshSize = document.createElement("input");
    meshSize.type = "number";
    meshSize.className = "part-meshsize";
    meshSize.title = "Target mesh size for local refinement (optional)";
    meshSize.placeholder = "size";
    meshSize.min = "0";
    meshSize.step = "any";
    meshSize.value = part.meshSize != null ? String(part.meshSize) : "";
    meshSize.addEventListener("change", () => {
      const raw = meshSize.value.trim();
      const n = raw === "" ? undefined : Number(raw);
      this.cb.onMeshSize(index, n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined);
    });
    meshSize.addEventListener("click", (e) => e.stopPropagation());
    row.appendChild(meshSize);

    const badge = document.createElement("span");
    badge.className = "part-badge";
    badge.textContent = `${part.volumes.length}/${part.surfaces.length}/${part.lines.length}/${part.points.length}`;
    badge.title = "volumes / surfaces / lines / points";
    row.appendChild(badge);

    const assign = document.createElement("button");
    assign.className = "part-btn";
    assign.textContent = "＋";
    assign.title = "Assign current selection to this part";
    assign.addEventListener("click", (e) => { e.stopPropagation(); this.cb.onAssign(index); });
    row.appendChild(assign);

    const del = document.createElement("button");
    del.className = "part-btn";
    del.textContent = "✕";
    del.title = "Delete part";
    del.addEventListener("click", (e) => { e.stopPropagation(); this.cb.onRemovePart(index); });
    row.appendChild(del);

    item.appendChild(row);

    const sub = this.buildEntities(part, index);
    if (sub) {
      item.appendChild(sub);
      chevron.addEventListener("click", (e) => {
        e.stopPropagation();
        const collapsed = sub.classList.toggle("collapsed");
        chevron.textContent = collapsed ? "▸" : "▾";
      });
    }

    row.addEventListener("click", () => {
      this.selectedIndex = this.selectedIndex === index ? null : index;
      this.cb.onSelectPart(this.selectedIndex);
      this.markSelection();
    });

    return item;
  }

  private buildEntities(part: Part, index: number): HTMLElement | null {
    const rows: Array<["volume" | "surface" | "line" | "point", string]> = [
      ...part.volumes.map((id) => ["volume", id] as ["volume", string]),
      ...part.surfaces.map((id) => ["surface", id] as ["surface", string]),
      ...part.lines.map((id) => ["line", id] as ["line", string]),
      ...part.points.map((id) => ["point", id] as ["point", string]),
    ];
    if (rows.length === 0) return null;

    const ul = document.createElement("ul");
    ul.className = "part-entities";
    for (const [type, id] of rows) {
      const li = document.createElement("li");
      li.className = "entity-row";

      const label = document.createElement("span");
      label.className = "entity-label";
      label.textContent = `${type} · ${id}`;
      li.appendChild(label);

      const rm = document.createElement("button");
      rm.className = "entity-remove";
      rm.textContent = "✕";
      rm.title = "Remove from part";
      rm.addEventListener("click", (e) => { e.stopPropagation(); this.cb.onRemoveEntity(index, type, id); });
      li.appendChild(rm);

      ul.appendChild(li);
    }
    return ul;
  }

  private markSelection(): void {
    this.body.querySelectorAll<HTMLElement>(".part-item").forEach((el, i) => {
      el.classList.toggle("selected", i === this.selectedIndex);
    });
  }
}
