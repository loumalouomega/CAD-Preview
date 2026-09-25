import type { Part } from "../protocol";
import { UI_GLYPHS } from "../uiGlyphs";
import type { VisibilityState } from "./visibilityState";

export interface PartsPanelCallbacks {
  onCreate: () => void;
  onAssign: (index: number) => void;
  onRemovePart: (index: number) => void;
  onRename: (index: number, name: string) => void;
  onRecolor: (index: number, color: string) => void;
  onRemoveEntity: (index: number, entityType: "volume" | "surface" | "line" | "point", entityId: string) => void;
  onSelectPart: (index: number | null) => void;
  /** Toggles whether this part's entities are hidden (display-only, never persisted). */
  onToggleVisible: (index: number) => void;
  /** Toggles isolating this part (show only it); called with the currently selected part. */
  onToggleIsolate: (index: number) => void;
  /** Copies the bill of materials (one TSV row per part, via a bomRequest host round trip). */
  onCopyBom: () => void;
  /** Copies the hole table (one TSV row per diameter + axis group, via a holeTableRequest host round trip). */
  onCopyHoleTable: () => void;
}

/**
 * Renders the editable Parts list: per-part colour swatch, inline-editable name,
 * a compact `volumes · surfaces · lines` count and a visibility eye; the "assign
 * current selection" and delete actions appear on hover/focus only (they stay in
 * the DOM and keyboard-reachable), and the expandable list of assigned entities
 * starts collapsed. A part's target mesh size is edited in the FE Mesh panel's
 * "Part sizes" section, not here. VS Code webviews block `prompt()`, so renaming uses
 * an inline `<input>` rather than a dialog. Selecting a part row highlights its
 * entities via {@link PartsPanelCallbacks.onSelectPart}. `visibility` is read-only
 * here — it's owned by `main.ts`, this panel only queries it to paint the eye
 * icon / Isolate button state; `render()` must be re-called after any visibility
 * change for the panel to reflect it (visibility mutations don't themselves fire
 * `PartsModel.onChange`, since hide/isolate state isn't part of the persisted `Part`).
 */
export class PartsPanel {
  private readonly body: HTMLElement;
  private readonly newBtn: HTMLElement;
  private readonly isolateBtn: HTMLButtonElement;
  private readonly copyBomBtn: HTMLButtonElement;
  private readonly copyHolesBtn: HTMLButtonElement;
  private selectedIndex: number | null = null;

  constructor(
    private readonly panel: HTMLElement,
    private readonly cb: PartsPanelCallbacks,
    private readonly visibility: VisibilityState
  ) {
    this.body = panel.querySelector("#parts-body")!;
    this.newBtn = panel.querySelector("#parts-new")!;
    this.newBtn.addEventListener("click", () => this.cb.onCreate());
    this.isolateBtn = panel.querySelector("#parts-isolate")!;
    this.isolateBtn.addEventListener("click", () => {
      if (this.selectedIndex !== null) this.cb.onToggleIsolate(this.selectedIndex);
    });
    this.copyBomBtn = panel.querySelector("#parts-copy-bom")!;
    this.copyBomBtn.addEventListener("click", () => {
      if (!this.copyBomBtn.disabled) this.cb.onCopyBom();
    });
    this.copyHolesBtn = panel.querySelector("#parts-copy-holes")!;
    this.copyHolesBtn.addEventListener("click", () => {
      if (!this.copyHolesBtn.disabled) this.cb.onCopyHoleTable();
    });
  }

  /** Enables/disables the Copy hole table button — B-rep sources only (the
   * host reads analytic cylinder faces via OCCT). Needs no Parts. */
  setHoleTableEnabled(enabled: boolean, reason: string): void {
    this.copyHolesBtn.disabled = !enabled;
    this.copyHolesBtn.title = reason;
  }

  /**
   * Enables/disables the Copy BOM button — enabled only for a B-rep source
   * with ≥1 part (the host computes rows via OCCT; a mesh source has no
   * per-part rows, and zero parts would copy a header-only TSV). Called by
   * the wiring on every model load and parts change, alongside `render()`.
   */
  setBomEnabled(enabled: boolean, reason: string): void {
    this.copyBomBtn.disabled = !enabled;
    this.copyBomBtn.title = reason;
  }

  render(parts: Part[]): void {
    this.body.innerHTML = "";
    if (this.selectedIndex !== null && this.selectedIndex >= parts.length) {
      this.selectedIndex = null;
    }
    parts.forEach((part, index) => this.body.appendChild(this.buildPart(part, index)));
    this.isolateBtn.disabled = this.selectedIndex === null;
    this.isolateBtn.classList.toggle(
      "active",
      this.selectedIndex !== null && this.visibility.isPartIsolated(this.selectedIndex)
    );
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
    // Entity lists start COLLAPSED — a part with a dozen faces would otherwise
    // push every other part off the screen. The glyph is rotated by CSS from the
    // `collapsed` class, so toggling never rewrites text.
    chevron.innerHTML = total > 0 ? UI_GLYPHS.chevronDown : "";
    chevron.classList.add("collapsed");
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
    // Keyboard audit (roadmap "Sidebar layout and keyboard usability"):
    // Enter commits (blur fires `change`), Escape CANCELS — restoring the value
    // before blur means `change` never fires (it only fires when the value
    // differs from the value at focus), so no half-typed rename can land via
    // blur. The input IS the rename's own trigger, so focus stays on it.
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.stopPropagation();
        name.blur();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        name.value = part.name;
        name.blur();
      }
    });
    name.addEventListener("click", (e) => e.stopPropagation());
    row.appendChild(name);

    const badge = document.createElement("span");
    badge.className = "part-badge";
    // "1 · 0 · 0" — points only when there are any, since almost no part has them.
    const counts = [part.volumes.length, part.surfaces.length, part.lines.length];
    if (part.points.length > 0) counts.push(part.points.length);
    badge.textContent = counts.join(" · ");
    badge.title = part.points.length > 0 ? "volumes · surfaces · lines · points" : "volumes · surfaces · lines";
    row.appendChild(badge);

    const hidden = this.visibility.isPartHidden(index);
    const eye = document.createElement("button");
    eye.className = "part-btn part-eye";
    eye.classList.toggle("hidden-off", hidden);
    eye.innerHTML = hidden ? UI_GLYPHS.eyeOff : UI_GLYPHS.eye;
    eye.title = hidden ? "Show this part" : "Hide this part";
    eye.addEventListener("click", (e) => { e.stopPropagation(); this.cb.onToggleVisible(index); });
    row.appendChild(eye);

    const assign = document.createElement("button");
    assign.className = "part-btn";
    assign.innerHTML = UI_GLYPHS.plus;
    assign.title = "Assign current selection to this part";
    assign.addEventListener("click", (e) => { e.stopPropagation(); this.cb.onAssign(index); });
    row.appendChild(assign);

    const del = document.createElement("button");
    del.className = "part-btn";
    del.innerHTML = UI_GLYPHS.trash;
    del.title = "Delete part";
    del.addEventListener("click", (e) => { e.stopPropagation(); this.cb.onRemovePart(index); });
    row.appendChild(del);

    item.appendChild(row);

    const sub = this.buildEntities(part, index);
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
      this.selectedIndex = this.selectedIndex === index ? null : index;
      this.cb.onSelectPart(this.selectedIndex);
      this.markSelection();
      this.isolateBtn.disabled = this.selectedIndex === null;
      this.isolateBtn.classList.toggle(
        "active",
        this.selectedIndex !== null && this.visibility.isPartIsolated(this.selectedIndex)
      );
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
      rm.innerHTML = UI_GLYPHS.trash;
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
