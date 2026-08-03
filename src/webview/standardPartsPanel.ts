import type { StandardPart } from "../stepPartsService";

export interface StandardPartsPanelCallbacks {
  onSearch: (query: string) => void;
  onInsert: (part: StandardPart) => void;
}

/**
 * The sidebar "Standard Parts" panel — a search box over the step.parts
 * catalog (`search_standard_parts`/`download_standard_part`'s interactive
 * counterpart, roadmap "Standard-parts browse and insert panel", closed).
 * Pure DOM rendering; `main.ts` owns the actual `standardPartsSearchRequest`/
 * `standardPartsInsertRequest` round trips and calls {@link renderResults}/
 * {@link renderError}/{@link onInsertSettled} in response.
 *
 * Deliberately no thumbnails in this first pass — `StandardPart.pngUrl` is a
 * remote `https://` image the webview's CSP has no `img-src` allowance for
 * (fetching it host-side and piping base64 over postMessage per result would
 * work but is real added complexity for a result list that's already
 * identifiable by name/category/standard); a text-only row list is the
 * simpler, still-useful v1.
 */
export class StandardPartsPanel {
  private readonly queryInput: HTMLInputElement;
  private readonly searchBtn: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly status: HTMLElement;
  private readonly insertButtons = new Map<string, HTMLButtonElement>();

  constructor(panel: HTMLElement, private readonly cb: StandardPartsPanelCallbacks) {
    this.queryInput = panel.querySelector("#standard-parts-query")!;
    this.searchBtn = panel.querySelector("#standard-parts-search-btn")!;
    this.body = panel.querySelector("#standard-parts-body")!;
    this.status = panel.querySelector("#standard-parts-status")!;
    this.searchBtn.addEventListener("click", () => this.triggerSearch());
    this.queryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.triggerSearch();
    });
  }

  private triggerSearch(): void {
    const q = this.queryInput.value.trim();
    if (!q) return;
    this.setStatus("Searching…");
    this.cb.onSearch(q);
  }

  setStatus(text: string, isError = false): void {
    this.status.textContent = text;
    this.status.classList.toggle("mass-message-error", isError);
  }

  renderError(message: string): void {
    this.body.innerHTML = "";
    this.insertButtons.clear();
    this.setStatus(message, true);
  }

  renderResults(items: StandardPart[], total: number): void {
    this.body.innerHTML = "";
    this.insertButtons.clear();
    this.setStatus(items.length === 0 ? "No results." : `${total} result${total === 1 ? "" : "s"} — showing ${items.length}.`);
    for (const part of items) this.body.appendChild(this.buildRow(part));
  }

  /** Re-enables an Insert button after its request settles (success, error,
   * or a dismissed save dialog) — called with the part id that was inserted. */
  onInsertSettled(id: string): void {
    const btn = this.insertButtons.get(id);
    if (!btn) return; // a fresh search already replaced the results list
    btn.disabled = false;
    btn.textContent = "Insert…";
  }

  private buildRow(part: StandardPart): HTMLElement {
    const row = document.createElement("div");
    row.className = "standard-part-row";

    const name = document.createElement("div");
    name.className = "standard-part-name";
    name.textContent = part.name;
    row.appendChild(name);

    if (part.description) {
      const desc = document.createElement("div");
      desc.className = "standard-part-desc";
      desc.textContent = part.description;
      row.appendChild(desc);
    }

    const metaBits = [part.category, part.standard?.designation].filter((s): s is string => !!s);
    if (metaBits.length > 0) {
      const meta = document.createElement("div");
      meta.className = "standard-part-meta";
      meta.textContent = metaBits.join(" · ");
      row.appendChild(meta);
    }

    const actions = document.createElement("div");
    actions.className = "standard-part-actions";
    const insertBtn = document.createElement("button");
    insertBtn.className = "standard-part-insert";
    insertBtn.textContent = "Insert…";
    insertBtn.addEventListener("click", () => {
      insertBtn.disabled = true;
      insertBtn.textContent = "Inserting…";
      this.cb.onInsert(part);
    });
    this.insertButtons.set(part.id, insertBtn);
    actions.appendChild(insertBtn);
    row.appendChild(actions);

    return row;
  }
}
