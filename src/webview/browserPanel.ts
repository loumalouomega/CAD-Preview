import { UI_GLYPHS } from "../uiGlyphs";
import { collapseAll, DEFAULT_COLLAPSED, expandAll, filterBrowser, type BrowserGroup, type BrowserGroupId } from "./browserTree";

/**
 * DOM side of the sidebar Browser. Holds only display state (which groups are
 * collapsed, the filter text, the last groups it was given); every row action
 * is delegated to `onEye` / `onActivate` by typed row id, so the Browser calls
 * the same functions as the panels it mirrors. No unit test by convention — the
 * logic lives in `browserTree.ts`.
 */
export class BrowserPanel {
  private readonly body: HTMLElement;
  private collapsed = new Set<BrowserGroupId>(DEFAULT_COLLAPSED);
  private query = "";
  private groups: BrowserGroup[] = [];

  constructor(
    private readonly panel: HTMLElement,
    private readonly onEye: (rowId: string) => void,
    private readonly onActivate: (rowId: string) => void
  ) {
    this.body = panel.querySelector("#browser-body")!;
    panel.querySelector("#browser-expand-all")?.addEventListener("click", () => {
      this.collapsed = expandAll();
      this.draw();
    });
    panel.querySelector("#browser-collapse-all")?.addEventListener("click", () => {
      this.collapsed = collapseAll(this.groups);
      this.draw();
    });
    const filter = panel.querySelector<HTMLInputElement>("#browser-filter");
    const search = panel.querySelector<HTMLButtonElement>("#browser-search");
    search?.addEventListener("click", () => {
      if (!filter) return;
      const show = filter.hidden;
      filter.hidden = !show;
      search.setAttribute("aria-expanded", String(show));
      if (show) filter.focus();
      else {
        filter.value = "";
        this.setFilter("");
      }
    });
    filter?.addEventListener("input", () => this.setFilter(filter.value));
  }

  /** Re-renders from freshly built groups (call whenever any mirrored model changes). */
  render(groups: BrowserGroup[]): void {
    this.groups = groups;
    this.draw();
  }

  private setFilter(q: string): void {
    this.query = q;
    this.draw();
  }

  private draw(): void {
    const shown = filterBrowser(this.groups, this.query);
    const filtering = this.query.trim() !== "";
    this.body.replaceChildren();
    const ul = document.createElement("ul");
    ul.className = "tree-list browser-list";
    for (const g of shown) {
      const isCollapsed = !filtering && this.collapsed.has(g.id);
      const li = document.createElement("li");
      li.className = "tree-item browser-group";
      li.dataset.group = g.id;

      const head = document.createElement("div");
      head.className = "tree-row browser-group-row";
      const chevron = document.createElement("span");
      chevron.className = "tree-chevron" + (isCollapsed ? " collapsed" : "");
      chevron.innerHTML = UI_GLYPHS.chevronDown;
      head.appendChild(chevron);
      const title = document.createElement("span");
      title.className = "tree-label browser-group-title";
      title.textContent = g.title;
      head.appendChild(title);
      const count = document.createElement("span");
      count.className = "tree-badge ui-num";
      count.textContent = String(g.rows.length);
      head.appendChild(count);
      if (g.eye !== null && g.rows.some((r) => r.eye !== null)) head.appendChild(this.eye(`group:${g.id}`, g.eye));
      head.addEventListener("click", () => {
        if (this.collapsed.has(g.id)) this.collapsed.delete(g.id);
        else this.collapsed.add(g.id);
        this.draw();
      });
      li.appendChild(head);

      if (!isCollapsed) {
        const sub = document.createElement("ul");
        sub.className = "tree-list browser-rows";
        for (const r of g.rows) {
          const item = document.createElement("li");
          item.className = "tree-item browser-row" + (r.muted ? " browser-muted" : "");
          item.dataset.id = r.id;
          const row = document.createElement("div");
          row.className = "tree-row";
          row.style.paddingLeft = "24px";
          if (r.color) {
            const sw = document.createElement("span");
            sw.className = "browser-swatch";
            sw.style.background = r.color;
            row.appendChild(sw);
          }
          const label = document.createElement("span");
          label.className = "tree-label";
          label.textContent = r.label;
          row.appendChild(label);
          if (r.detail) {
            const d = document.createElement("span");
            d.className = "tree-badge ui-num";
            d.textContent = r.detail;
            row.appendChild(d);
          }
          if (r.eye !== null) row.appendChild(this.eye(r.id, r.eye));
          row.addEventListener("click", () => this.onActivate(r.id));
          item.appendChild(row);
          sub.appendChild(item);
        }
        if (g.rows.length === 0) {
          const empty = document.createElement("li");
          empty.className = "browser-empty";
          empty.textContent = "None";
          sub.appendChild(empty);
        }
        li.appendChild(sub);
      }
      ul.appendChild(li);
    }
    this.body.appendChild(ul);
  }

  private eye(rowId: string, state: "on" | "off" | "mixed"): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "tree-eye browser-eye" + (state === "off" ? " hidden-off" : state === "mixed" ? " browser-eye-mixed" : "");
    b.dataset.eye = rowId;
    b.innerHTML = state === "off" ? UI_GLYPHS.eyeOff : UI_GLYPHS.eye;
    b.title = state === "off" ? "Show" : "Hide";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onEye(rowId);
    });
    return b;
  }
}
