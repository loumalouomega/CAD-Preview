import type { Layer } from "../protocol";
import { UI_GLYPHS } from "../uiGlyphs";

export interface LayersPanelCallbacks {
  onCreate: () => void;
  onAssign: (id: string) => void;
  onRemoveLayer: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onRecolor: (id: string, color: string) => void;
  onRemoveEntity: (id: string, entityType: "volume" | "surface" | "line" | "point", entityId: string) => void;
  onSelectLayer: (id: string | null) => void;
  /** Toggles a layer's persisted visibility (unlike Parts' session-only eye). */
  onToggleVisible: (id: string) => void;
  /** Toggles a layer's lock (locked members refuse as edit operands). */
  onToggleLocked: (id: string) => void;
}

/**
 * Renders the Layers list (roadmap "Layers, distinct from Parts"): per-layer
 * colour swatch, inline-editable name, a compact `volumes · surfaces · lines`
 * count, a visibility eye and a lock button; the "assign current selection"
 * and delete actions appear on hover/focus only (they stay in the DOM and
 * keyboard-reachable). Reuses the Parts panel's row CSS classes outright, so
 * no new row styling is needed and the two sections read as siblings.
 * VS Code webviews block `prompt()`, so renaming uses an inline `<input>`,
 * and deleting the default layer is refused by the model (the row's delete
 * button explains rather than silently failing).
 */
export class LayersPanel {
  private readonly body: HTMLElement;
  private readonly newBtn: HTMLElement;
  private selectedId: string | null = null;
  private renderedIds: string[] = [];

  constructor(
    private readonly panel: HTMLElement,
    private readonly cb: LayersPanelCallbacks
  ) {
    this.body = panel.querySelector("#layers-body")!;
    this.newBtn = panel.querySelector("#layers-new")!;
    this.newBtn.addEventListener("click", () => this.cb.onCreate());
  }

  render(layers: Layer[]): void {
    this.body.innerHTML = "";
    if (this.selectedId !== null && !layers.some((l) => l.id === this.selectedId)) {
      this.selectedId = null;
    }
    this.renderedIds = layers.map((l) => l.id);
    layers.forEach((layer) => this.body.appendChild(this.buildLayer(layer)));
    this.markSelection();
  }

  private buildLayer(layer: Layer): HTMLElement {
    const item = document.createElement("div");
    item.className = "part-item";
    if (layer.id === this.selectedId) item.classList.add("selected");

    const row = document.createElement("div");
    row.className = "part-row";

    const chevron = document.createElement("span");
    chevron.className = "part-chevron";
    const total = layer.volumes.length + layer.surfaces.length + layer.lines.length + layer.points.length;
    chevron.innerHTML = total > 0 ? UI_GLYPHS.chevronDown : "";
    chevron.classList.add("collapsed");
    row.appendChild(chevron);

    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.className = "part-swatch";
    swatch.value = layer.color;
    swatch.title = "Layer colour (panel swatch + drawing-export colour)";
    swatch.addEventListener("input", () => this.cb.onRecolor(layer.id, swatch.value));
    swatch.addEventListener("click", (e) => e.stopPropagation());
    row.appendChild(swatch);

    const name = document.createElement("input");
    name.type = "text";
    name.className = "part-name";
    name.value = layer.name;
    name.addEventListener("change", () => this.cb.onRename(layer.id, name.value));
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.stopPropagation();
        name.blur();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        name.value = layer.name;
        name.blur();
      }
    });
    name.addEventListener("click", (e) => e.stopPropagation());
    row.appendChild(name);

    const badge = document.createElement("span");
    badge.className = "part-badge";
    const counts = [layer.volumes.length, layer.surfaces.length, layer.lines.length];
    if (layer.points.length > 0) counts.push(layer.points.length);
    badge.textContent = counts.join(" · ");
    badge.title = layer.points.length > 0 ? "volumes · surfaces · lines · points" : "volumes · surfaces · lines";
    row.appendChild(badge);

    const eye = document.createElement("button");
    eye.className = "part-btn part-eye";
    eye.classList.toggle("hidden-off", !layer.visible);
    eye.innerHTML = layer.visible ? UI_GLYPHS.eye : UI_GLYPHS.eyeOff;
    eye.title = layer.visible ? "Hide this layer (persisted — hidden layers stay hidden for drawings and agents)" : "Show this layer";
    eye.addEventListener("click", (e) => { e.stopPropagation(); this.cb.onToggleVisible(layer.id); });
    row.appendChild(eye);

    const lock = document.createElement("button");
    lock.className = "part-btn";
    lock.classList.toggle("active", layer.locked);
    lock.innerHTML = UI_GLYPHS.lock;
    lock.title = layer.locked
      ? "Unlock this layer (members refuse as edit operands while locked)"
      : "Lock this layer (members stay selectable, but refuse as edit operands)";
    lock.addEventListener("click", (e) => { e.stopPropagation(); this.cb.onToggleLocked(layer.id); });
    row.appendChild(lock);

    const assign = document.createElement("button");
    assign.className = "part-btn";
    assign.innerHTML = UI_GLYPHS.plus;
    assign.title = "Assign current selection to this layer (each entity sits on exactly one layer)";
    assign.addEventListener("click", (e) => { e.stopPropagation(); this.cb.onAssign(layer.id); });
    row.appendChild(assign);

    const del = document.createElement("button");
    del.className = "part-btn";
    del.innerHTML = UI_GLYPHS.trash;
    del.title = layer.id === "layer-0" ? "The default layer cannot be deleted" : "Delete layer (members return to Default)";
    del.addEventListener("click", (e) => { e.stopPropagation(); this.cb.onRemoveLayer(layer.id); });
    row.appendChild(del);

    item.appendChild(row);

    const sub = this.buildEntities(layer);
    if (sub) {
      sub.classList.add("collapsed");
      item.appendChild(sub);
      chevron.addEventListener("click", (e) => {
        e.stopPropagation();
        const collapsed = sub.classList.toggle("collapsed");
        chevron.classList.toggle("collapsed", collapsed);
      });
    }

    row.addEventListener("click", () => {
      this.selectedId = this.selectedId === layer.id ? null : layer.id;
      this.cb.onSelectLayer(this.selectedId);
      this.markSelection();
    });

    return item;
  }

  private buildEntities(layer: Layer): HTMLElement | null {
    const rows: Array<["volume" | "surface" | "line" | "point", string]> = [
      ...layer.volumes.map((id) => ["volume", id] as ["volume", string]),
      ...layer.surfaces.map((id) => ["surface", id] as ["surface", string]),
      ...layer.lines.map((id) => ["line", id] as ["line", string]),
      ...layer.points.map((id) => ["point", id] as ["point", string]),
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
      rm.innerHTML = UI_GLYPHS.trash;
      rm.title = "Remove from layer";
      rm.addEventListener("click", (e) => { e.stopPropagation(); this.cb.onRemoveEntity(layer.id, type, id); });
      li.appendChild(rm);

      ul.appendChild(li);
    }
    return ul;
  }

  private markSelection(): void {
    this.body.querySelectorAll<HTMLElement>(".part-item").forEach((el, i) => {
      el.classList.toggle("selected", this.renderedIds[i] === this.selectedId);
    });
  }
}
