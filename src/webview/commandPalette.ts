/**
 * The command search overlay (Ctrl+K, or `/` outside a field) and the opt-in
 * single-key commands — the DOM half of `commandSearch.ts`.
 *
 * Three sources feed one list: every op button (catalog + `COMMAND_TABLE`
 * names), every toolbar/dropdown action, and every sidebar panel. The toolbar
 * and panel sources are READ FROM THE LIVE DOM when the search opens, so a new
 * menu item or panel is searchable with no second list to keep in step; they
 * are "run" by clicking the same element the user would.
 *
 * No DOM access at module scope (vitest has no jsdom): the overlay is built
 * lazily on first open. It draws no canvas, so the single WebGL context is
 * untouched. Conventions kept from `dropdownMenu.ts`: Escape closes and
 * returns focus to where it was, a pointerdown outside closes without
 * reaching the canvas, and opening closes any open dropdown.
 */
import type { EditOp } from "../editOps";
import { closeAllDropdowns } from "./dropdownMenu";
import { revealPanel } from "./panelReveal";
import {
  LastCommandTracker,
  actionShortcut,
  opSearchItems,
  rankItems,
  resolveKey,
  singleKeyTable,
  type KeyCommand,
  type SearchItem,
} from "./commandSearch";
import { REPEAT_LAST_KEY, allCatalogEntries, type PanelOpId } from "./opCatalog";
import { OP_ICONS } from "./opIcons";
import { ShortcutSheet } from "./shortcutSheet";

export interface PaletteHost {
  /** Opens the op's form (prefilled from `body` when given) without applying; false when it cannot open now. */
  openOp(id: PanelOpId, body?: Record<string, unknown>): boolean;
  /** False for a B-rep-only op on a mesh source. */
  isOpAvailable(id: PanelOpId): boolean;
  setStatus(text: string, isError?: boolean): void;
  /** Ctrl+Z / Ctrl+Y — the Edits panel's own undo and redo (the save-point refusal included). */
  undo(): void;
  redo(): void;
}

interface Entry {
  item: SearchItem;
  run(): void;
  /** Icon markup (trusted, generated) or an element whose icon child is cloned. */
  iconHtml?: string;
  iconFrom?: Element | null;
}

const MAX_ROWS = 50;

/** Elements inside dropdowns that are not commands (dynamic lists, inline forms). */
const NOT_COMMANDS = "#context-menu, #bookmark-list, #bookmark-name-row, #annotations-list, #filter-group, #markup-color";

const isHiddenEl = (el: HTMLElement): boolean => {
  if (el.hidden || el.style.display === "none") return true;
  // Closed dropdowns are `.hidden` by design; only a hidden ancestor that is NOT a dropdown counts.
  for (let p: HTMLElement | null = el.parentElement; p; p = p.parentElement) {
    if (p.hidden) return true;
  }
  return false;
};

export class CommandPalette {
  private readonly tracker = new LastCommandTracker();
  private readonly table = singleKeyTable();
  private singleKeys = false;
  private overlay: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private list: HTMLElement | null = null;
  private entries: Entry[] = [];
  private shown: Entry[] = [];
  private selected = 0;
  private returnFocus: HTMLElement | null = null;

  private readonly sheet: ShortcutSheet;

  constructor(private readonly host: PaletteHost) {
    this.sheet = new ShortcutSheet({
      actionLabel: (id) => {
        const el = document.getElementById(id);
        const text = (el?.getAttribute("title") ?? el?.textContent ?? "").replace(/\s+/g, " ").trim();
        return text || undefined;
      },
      singleKeysOn: () => this.singleKeys,
    });
  }

  /** Opens the Keyboard shortcuts sheet (`?`, or the search entry). */
  openShortcuts(): void {
    this.close();
    closeAllDropdowns();
    this.sheet.open();
  }

  /** `cadPreview.singleKeyCommands`, delivered with the viewer defaults. */
  setSingleKeys(on: boolean): void {
    this.singleKeys = on;
  }

  singleKeysEnabled(): boolean {
    return this.singleKeys;
  }

  /** Called for every op that lands on the op stack (panel Apply, command bar, macros). */
  noteApplied(op: EditOp): void {
    this.tracker.applied(op);
  }

  /** Wires the global keys. Capture phase, so it sees the key before any field handler stops it. */
  install(): void {
    window.addEventListener("keydown", (e) => {
      if (this.isOpen() || this.sheet.isOpen()) return;
      const cmd = resolveKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat, defaultPrevented: e.defaultPrevented, target: e.target as HTMLElement | null }, this.singleKeys, this.table);
      if (cmd && this.runKey(cmd)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  isOpen(): boolean {
    return !!this.overlay && !this.overlay.hidden;
  }

  /** Runs a resolved key command; returns whether the key was consumed. */
  private runKey(cmd: KeyCommand): boolean {
    switch (cmd.type) {
      case "search":
        this.open();
        return true;
      case "op":
        this.runOp(cmd.id, undefined);
        return true;
      case "action": {
        const el = document.getElementById(cmd.elementId);
        if (!el || (el as HTMLButtonElement).disabled || isHiddenEl(el)) return false;
        this.tracker.touch(cmd.elementId);
        el.click();
        return true;
      }
      case "repeat":
        this.repeat();
        return true;
      case "undo":
        this.host.undo();
        return true;
      case "redo":
        this.host.redo();
        return true;
      case "help":
        this.openShortcuts();
        return true;
    }
  }

  /** Reopens the last op's form with its last values; never applies. */
  repeat(): void {
    const last = this.tracker.get();
    if (!last) {
      this.host.setStatus("No previous command to repeat.");
      return;
    }
    this.runOp(last.id, last.body, true);
  }

  private runOp(id: PanelOpId, body: Record<string, unknown> | undefined, repeating = false): void {
    const label = allCatalogEntries().find((e) => e.id === id)?.label ?? id;
    if (!this.host.isOpAvailable(id) || !this.host.openOp(id, body)) {
      this.host.setStatus(`${label} is not available for this document (B-rep only).`, true);
      return;
    }
    this.tracker.opened(id);
    this.host.setStatus(repeating ? `Reopened ${label} with its last values — nothing was applied.` : "");
  }

  // ── Overlay ──────────────────────────────────────────────────────────────

  private build(): void {
    const overlay = document.createElement("div");
    overlay.id = "cmd-palette";
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Search commands");

    const box = document.createElement("div");
    box.className = "cmd-palette-box";

    const input = document.createElement("input");
    input.id = "cmd-palette-input";
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.placeholder = "Search commands, tools and panels…";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-label", "Search commands");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", "cmd-palette-list");

    const list = document.createElement("ul");
    list.id = "cmd-palette-list";
    list.setAttribute("role", "listbox");

    const foot = document.createElement("div");
    foot.className = "cmd-palette-foot";
    foot.textContent = "↑↓ choose · Enter run · Esc close";

    box.append(input, list, foot);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    input.addEventListener("input", () => this.refresh(input.value));
    input.addEventListener("keydown", (e) => {
      // The palette owns every key while open: nothing reaches the viewer's shortcuts.
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); this.close(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); this.move(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); this.move(-1); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        const hit = this.shown[this.selected];
        if (hit) this.choose(hit);
      }
    });
    // A pointerdown on the backdrop (outside the box) dismisses and goes no further.
    overlay.addEventListener("pointerdown", (e) => {
      if (box.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });

    this.overlay = overlay;
    this.input = input;
    this.list = list;
  }

  open(): void {
    if (!this.overlay) this.build();
    closeAllDropdowns();
    const active = document.activeElement;
    this.returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    this.entries = this.collect();
    this.overlay!.hidden = false;
    this.input!.value = "";
    this.refresh("");
    this.input!.focus();
  }

  close(): void {
    if (!this.overlay || this.overlay.hidden) return;
    this.overlay.hidden = true;
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back && back.isConnected) back.focus();
  }

  private move(delta: number): void {
    if (this.shown.length === 0) return;
    this.selected = (this.selected + delta + this.shown.length) % this.shown.length;
    this.paintSelection();
  }

  private choose(entry: Entry): void {
    if (entry.item.disabled) {
      this.host.setStatus(`${entry.item.label} is not available for this document (B-rep only).`, true);
      return;
    }
    this.close();
    this.tracker.touch(entry.item.id);
    entry.run();
  }

  private refresh(query: string): void {
    const byId = new Map(this.entries.map((e) => [e.item.id, e]));
    const ranked = rankItems(this.entries.map((e) => e.item), query, { limit: MAX_ROWS, recent: this.tracker.recent() });
    this.shown = ranked.map((i) => byId.get(i.id)!).filter(Boolean);
    this.selected = 0;
    const list = this.list!;
    list.textContent = "";
    if (this.shown.length === 0) {
      const empty = document.createElement("li");
      empty.className = "cmd-empty";
      empty.textContent = "No matching command";
      list.appendChild(empty);
    }
    this.shown.forEach((entry, i) => list.appendChild(this.row(entry, i)));
    this.paintSelection();
  }

  private row(entry: Entry, index: number): HTMLElement {
    const li = document.createElement("li");
    li.className = "cmd-row";
    li.id = `cmd-row-${index}`;
    li.dataset.id = entry.item.id;
    li.dataset.kind = entry.item.kind;
    li.setAttribute("role", "option");
    if (entry.item.disabled) li.classList.add("disabled");

    const icon = document.createElement("span");
    icon.className = "cmd-icon";
    icon.setAttribute("aria-hidden", "true");
    if (entry.iconHtml) icon.innerHTML = entry.iconHtml;
    else {
      const svg = entry.iconFrom?.querySelector("svg");
      if (svg) icon.appendChild(svg.cloneNode(true));
    }

    const label = document.createElement("span");
    label.className = "cmd-label";
    label.textContent = entry.item.label;

    const group = document.createElement("span");
    group.className = "cmd-group";
    group.textContent = entry.item.group;

    li.append(icon, label, group);
    if (entry.item.shortcut) {
      const key = document.createElement("kbd");
      key.className = "cmd-key";
      key.textContent = entry.item.shortcut;
      // Letter keys only fire with the setting on; say so instead of hiding the reference.
      const letter = entry.item.shortcut.length === 1 || entry.item.shortcut === REPEAT_LAST_KEY;
      if (letter && !this.singleKeys) {
        key.classList.add("off");
        key.title = "Single-key commands are off — enable cadPreview.singleKeyCommands";
      }
      li.appendChild(key);
    }
    li.addEventListener("click", () => this.choose(entry));
    return li;
  }

  private paintSelection(): void {
    const rows = Array.from(this.list!.querySelectorAll<HTMLElement>(".cmd-row"));
    rows.forEach((r, i) => {
      const on = i === this.selected;
      r.classList.toggle("selected", on);
      r.setAttribute("aria-selected", on ? "true" : "false");
      if (on) {
        r.scrollIntoView({ block: "nearest" });
        this.input!.setAttribute("aria-activedescendant", r.id);
      }
    });
  }

  // ── Sources ──────────────────────────────────────────────────────────────

  private collect(): Entry[] {
    return [...this.opEntries(), ...this.actionEntries(), ...this.panelEntries()];
  }

  private opEntries(): Entry[] {
    return opSearchItems().map((item) => {
      const id = item.id as PanelOpId;
      const available = this.host.isOpAvailable(id);
      return {
        item: { ...item, ...(available ? {} : { disabled: true }) },
        iconHtml: OP_ICONS[id],
        run: () => this.runOp(id, undefined),
      };
    });
  }

  private actionEntries(): Entry[] {
    const out: Entry[] = [{
      item: {
        id: "repeat-last",
        kind: "action",
        label: "Repeat last command",
        group: "Edit",
        keywords: ["again", "redo form", "reopen"],
        shortcut: REPEAT_LAST_KEY,
      },
      run: () => this.repeat(),
    }, {
      item: { id: "undo", kind: "action", label: "Undo", group: "Edit", keywords: ["revert", "back"], shortcut: "Ctrl+Z" },
      run: () => this.host.undo(),
    }, {
      item: { id: "redo", kind: "action", label: "Redo", group: "Edit", keywords: ["forward"], shortcut: "Ctrl+Y" },
      run: () => this.host.redo(),
    }, {
      item: { id: "keyboard-shortcuts", kind: "action", label: "Keyboard shortcuts", group: "Help", keywords: ["keys", "cheat sheet", "hotkeys", "help"], shortcut: "?" },
      run: () => this.openShortcuts(),
    }];
    const seen = new Set<string>();
    const buttons = document.querySelectorAll<HTMLButtonElement>("#toolbar > button, #toolbar .tb-dropdown button, #file-dropdown button, #vc-more-dropdown button");
    for (const btn of buttons) {
      if (btn.matches(NOT_COMMANDS) || btn.closest(NOT_COMMANDS) || btn.classList.contains("tb-menu")) continue;
      if (btn.disabled || isHiddenEl(btn)) continue;
      const key = btn.id || this.rowKey(btn);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const text = (btn.textContent ?? "").replace(/\s+/g, " ").trim();
      const title = btn.getAttribute("title") ?? "";
      const label = text || title;
      if (!label) continue;
      const shortcut = actionShortcut(btn.id);
      out.push({
        item: {
          id: key,
          kind: "action",
          label,
          group: this.groupOf(btn),
          keywords: title && title !== label ? [title] : [],
          ...(shortcut ? { shortcut } : {}),
        },
        iconFrom: btn,
        run: () => btn.click(),
      });
    }
    return out;
  }

  /** A stable key for an id-less segment button (`.sel-mode`, `.layout-btn`, …). */
  private rowKey(btn: HTMLElement): string {
    const row = btn.closest<HTMLElement>("[id]");
    const tag = btn.dataset.mode ?? btn.dataset.tool ?? btn.dataset.layout;
    return row && tag ? `${row.id}:${tag}` : "";
  }

  private groupOf(btn: HTMLElement): string {
    const panel = btn.closest<HTMLElement>(".tb-dropdown");
    if (!panel) return "Toolbar";
    const trigger = panel.parentElement?.querySelector<HTMLElement>(":scope > .tb-menu");
    const name = (trigger?.textContent ?? "").replace(/\s+/g, " ").trim();
    return name || "View controls";
  }

  private panelEntries(): Entry[] {
    const out: Entry[] = [];
    for (const section of document.querySelectorAll<HTMLElement>("#side .side-section")) {
      const title = section.querySelector<HTMLElement>(".panel-title");
      const name = (title?.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!name || !section.id || isHiddenEl(section)) continue;
      const inAdvanced = !!section.closest("#advanced-body");
      out.push({
        item: {
          id: section.id,
          kind: "panel",
          label: name,
          group: inAdvanced || section.id === "advanced-group" ? "Advanced" : "Panels",
          keywords: [],
        },
        iconFrom: section.querySelector(".panel-icon"),
        run: () => this.revealPanel(section),
      });
    }
    return out;
  }

  /** Expands the panel (and the Advanced group above it), then scrolls it into view. */
  private revealPanel(section: HTMLElement): void {
    revealPanel(section);
  }
}
