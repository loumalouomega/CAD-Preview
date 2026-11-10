/**
 * The Keyboard shortcuts sheet (roadmap "Keyboard shortcut map and cheat
 * sheet"): a modal listing every bound key, opened by `?` or from the command
 * search. The rows come from `shortcutSections()` (the tables the key handler
 * itself reads), so the sheet cannot drift from what fires. DOM-only; the
 * logic lives in `commandSearch.ts`.
 */
import { shortcutSections } from "./commandSearch";

export interface ShortcutSheetHost {
  /** Names an action's element id for its row (the DOM supplies the button's title). */
  actionLabel(elementId: string): string | undefined;
  /** Whether `cadPreview.singleKeyCommands` is on, so bare-letter rows can say they are inactive. */
  singleKeysOn(): boolean;
}

export class ShortcutSheet {
  private overlay: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private returnFocus: HTMLElement | null = null;

  constructor(private readonly host: ShortcutSheetHost) {}

  isOpen(): boolean {
    return !!this.overlay && !this.overlay.hidden;
  }

  open(): void {
    if (!this.overlay) this.build();
    const active = document.activeElement;
    this.returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    this.render();
    this.overlay!.hidden = false;
    this.overlay!.querySelector<HTMLElement>(".shortcut-box")!.focus();
  }

  close(): void {
    if (!this.overlay || this.overlay.hidden) return;
    this.overlay.hidden = true;
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back && back.isConnected) back.focus();
  }

  private build(): void {
    const overlay = document.createElement("div");
    overlay.id = "shortcut-sheet";
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Keyboard shortcuts");

    const box = document.createElement("div");
    box.className = "shortcut-box";
    box.tabIndex = -1;

    const title = document.createElement("div");
    title.className = "shortcut-title";
    title.textContent = "Keyboard shortcuts";

    const body = document.createElement("div");
    body.id = "shortcut-body";

    const foot = document.createElement("div");
    foot.className = "shortcut-foot";
    foot.textContent = "Esc close";

    box.append(title, body, foot);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // The sheet owns every key while open.
    overlay.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        this.close();
      }
    });
    overlay.addEventListener("pointerdown", (e) => {
      if (box.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });
    this.overlay = overlay;
    this.body = body;
  }

  private render(): void {
    const body = this.body!;
    body.textContent = "";
    const on = this.host.singleKeysOn();
    for (const section of shortcutSections(undefined, (id) => this.host.actionLabel(id))) {
      const h = document.createElement("div");
      h.className = "shortcut-section";
      h.textContent = section.title;
      body.appendChild(h);
      for (const row of section.rows) {
        const line = document.createElement("div");
        line.className = "shortcut-row";
        const label = document.createElement("span");
        label.className = "shortcut-label";
        label.textContent = row.label;
        const key = document.createElement("kbd");
        key.className = "shortcut-key";
        key.textContent = row.keys;
        if (row.needsSetting && !on) {
          key.classList.add("off");
          key.title = "Single-key commands are off — enable cadPreview.singleKeyCommands";
        }
        line.append(label, key);
        body.appendChild(line);
      }
    }
  }
}
