import type { TreeNode } from "../protocol";
import { filterTree } from "./treeFilter";
import type { VisibilityState } from "./visibilityState";

export class TreePanel {
  private readonly body: HTMLElement;
  private readonly titleEl: HTMLElement;
  private selectedId: string | null = null;
  private onSelect: (id: string | null) => void;
  private onToggleVisible: (id: string) => void;
  /** The last-rendered root, cached so `filter()` can re-run `buildList` without a fresh `render()` call. */
  private root: TreeNode | null = null;

  constructor(
    private readonly panel: HTMLElement,
    onSelect: (id: string | null) => void,
    onToggleVisible: (id: string) => void,
    private readonly visibility: VisibilityState
  ) {
    this.body = panel.querySelector("#tree-body")!;
    this.titleEl = panel.querySelector("#tree-title")!;
    this.onSelect = onSelect;
    this.onToggleVisible = onToggleVisible;
  }

  /** Populate the panel with tree data and make it visible. */
  render(root: TreeNode): void {
    this.selectedId = null;
    this.root = root;
    this.titleEl.textContent = root.label;

    const children = root.children ?? [];
    if (children.length === 0) {
      this.body.innerHTML = "";
      return;
    }

    this.rebuild(children, null);
    this.panel.classList.add("visible");
  }

  /** Re-renders the current tree filtered to `query` (empty/blank shows everything). */
  filter(query: string): void {
    const children = this.root?.children ?? [];
    if (children.length === 0) return;
    const keep = filterTree(children, query);
    this.rebuild(children, query.trim() ? keep : null);
  }

  /** Re-renders the eye icons without touching selection/filter state (call after a visibility change). */
  refreshVisibility(): void {
    const children = this.root?.children ?? [];
    if (children.length > 0) this.rebuild(children, null);
  }

  private rebuild(children: TreeNode[], keep: Set<string> | null): void {
    this.body.innerHTML = "";
    this.body.appendChild(this.buildList(children, 0, keep));
  }

  /** Hide panel and clear state. */
  hide(): void {
    this.panel.classList.remove("visible");
    this.selectedId = null;
    this.root = null;
    this.body.innerHTML = "";
  }

  toggle(): void {
    this.panel.classList.toggle("visible");
  }

  private buildList(nodes: TreeNode[], depth: number, keep: Set<string> | null): HTMLUListElement {
    const ul = document.createElement("ul");
    ul.className = "tree-list";

    for (const node of nodes) {
      if (keep && !keep.has(node.id)) continue;
      const li = document.createElement("li");
      li.className = "tree-item";
      li.dataset.id = node.id;

      const row = document.createElement("div");
      row.className = "tree-row";
      row.style.paddingLeft = `${8 + depth * 16}px`;

      const hasChildren = node.children && node.children.length > 0;

      const chevron = document.createElement("span");
      chevron.className = "tree-chevron";
      chevron.textContent = hasChildren ? "▾" : " ";
      row.appendChild(chevron);

      const label = document.createElement("span");
      label.className = "tree-label";
      label.textContent = node.label;
      if (node.faceCount !== undefined) {
        const badge = document.createElement("span");
        badge.className = "tree-badge";
        badge.textContent = String(node.faceCount);
        label.appendChild(badge);
      }
      row.appendChild(label);

      const hidden = this.visibility.isTreeGroupHidden(node.id);
      const eye = document.createElement("button");
      eye.className = "tree-eye";
      eye.classList.toggle("hidden-off", hidden);
      eye.textContent = hidden ? "🙈" : "👁";
      eye.title = hidden ? "Show this component" : "Hide this component";
      eye.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onToggleVisible(node.id);
      });
      row.appendChild(eye);

      li.appendChild(row);

      if (hasChildren) {
        const sub = this.buildList(node.children!, depth + 1, keep);
        li.appendChild(sub);
        chevron.addEventListener("click", (e) => {
          e.stopPropagation();
          const collapsed = sub.classList.toggle("collapsed");
          chevron.textContent = collapsed ? "▸" : "▾";
        });
      }

      row.addEventListener("click", () => {
        if (this.selectedId === node.id) {
          this.selectedId = null;
        } else {
          this.selectedId = node.id;
        }
        this.updateSelection();
        this.onSelect(this.selectedId);
      });

      ul.appendChild(li);
    }

    return ul;
  }

  private updateSelection(): void {
    this.panel.querySelectorAll<HTMLElement>(".tree-row").forEach((row) => {
      const li = row.closest<HTMLElement>(".tree-item");
      row.classList.toggle("selected", li?.dataset.id === this.selectedId);
    });
  }
}
