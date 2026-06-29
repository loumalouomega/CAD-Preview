import type { TreeNode } from "../protocol";

export class TreePanel {
  private readonly body: HTMLElement;
  private readonly titleEl: HTMLElement;
  private selectedId: string | null = null;
  private onSelect: (id: string | null) => void;

  constructor(
    private readonly panel: HTMLElement,
    onSelect: (id: string | null) => void
  ) {
    this.body = panel.querySelector("#tree-body")!;
    this.titleEl = panel.querySelector("#tree-title")!;
    this.onSelect = onSelect;
  }

  /** Populate the panel with tree data and make it visible. */
  render(root: TreeNode): void {
    this.selectedId = null;
    this.titleEl.textContent = root.label;
    this.body.innerHTML = "";

    const children = root.children ?? [];
    if (children.length === 0) return;

    this.body.appendChild(this.buildList(children, 0));
    this.panel.classList.add("visible");
  }

  /** Hide panel and clear state. */
  hide(): void {
    this.panel.classList.remove("visible");
    this.selectedId = null;
    this.body.innerHTML = "";
  }

  toggle(): void {
    this.panel.classList.toggle("visible");
  }

  private buildList(nodes: TreeNode[], depth: number): HTMLUListElement {
    const ul = document.createElement("ul");
    ul.className = "tree-list";

    for (const node of nodes) {
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

      li.appendChild(row);

      if (hasChildren) {
        const sub = this.buildList(node.children!, depth + 1);
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
