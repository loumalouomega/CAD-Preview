/**
 * The ribbon command strip — the DOM half of `ribbon.ts` (roadmap "Ribbon
 * command strip").
 *
 * The markup skeleton (`#ribbon`) is static in `viewerDom.ts`; everything inside
 * it is built here from `ribbon.ts`'s tables, so the strip is generated from the
 * op catalog plus the small non-op table and cannot list a button that has no
 * form. Buttons never carry their own behaviour: an op button opens the form the
 * Edits panel's button opens, a click button clicks the toolbar/menu element a
 * user would, a panel button expands the sidebar section. State (pressed,
 * disabled) is MIRRORED from those targets, never stored here.
 *
 * Conventions kept: no DOM access at module scope (vitest has no jsdom);
 * Escape/outside-click on the ▸ menu come from `dropdownMenu.ts`; every element
 * toggled with `hidden` has an explicit `#id[hidden]{display:none}` in
 * `viewer.css`; nothing here draws to the canvas or requests a render.
 */
import { TOOLBAR_ICONS } from "../toolbarIcons";
import { UI_GLYPHS } from "../uiGlyphs";
import { setupDropdown, type DropdownHandle } from "./dropdownMenu";
import { OP_ICONS } from "./opIcons";
import { revealPanel } from "./panelReveal";
import type { PanelOpId } from "./opCatalog";
import {
  DEFAULT_RIBBON_STATE,
  planOverflow,
  ribbonGroups,
  type RibbonGroup,
  type RibbonItem,
  type RibbonState,
} from "./ribbon";
import { RIBBON_TABS, RIBBON_TAB_LABELS, sanitizeRibbonTab, type RibbonTabId } from "./ribbonTabs";

export interface RibbonHost {
  /** Opens the op's form without applying; false when it cannot open now. */
  openOp(id: PanelOpId): boolean;
  /** False for a B-rep-only op on a mesh source. */
  isOpAvailable(id: PanelOpId): boolean;
  /** The op whose form is open, if any (drives the pressed state). */
  activeOp(): PanelOpId | null;
  setStatus(text: string, isError?: boolean): void;
  /** A USER-driven state change (never fired by `setState`). */
  onChange(state: RibbonState): void;
}

export interface RibbonHandle {
  getState(): RibbonState;
  /** Applies persisted state silently — restore, not echo. Unknown values fall back to defaults. */
  setState(state: Partial<RibbonState> | null | undefined): void;
  /** Re-reads every button's pressed/disabled state from its target. */
  refresh(): void;
  /** Re-plans the overflow split for the current width. */
  fit(): void;
}

/** True when the element, or an ancestor other than a closed dropdown, is hidden. */
function isUnavailable(el: HTMLElement): boolean {
  if (el.hidden || el.style.display === "none") return true;
  for (let p = el.parentElement; p; p = p.parentElement) if (p.hidden || p.style.display === "none") return true;
  return false;
}

function iconHtml(item: RibbonItem): string {
  const icon = item.icon;
  switch (icon.kind) {
    case "op": return OP_ICONS[icon.id];
    case "toolbar": return TOOLBAR_ICONS[icon.id];
    case "glyph": return UI_GLYPHS[icon.id];
    case "panel":
    case "none":
      return "";
  }
}

export function setupRibbon(host: RibbonHost): RibbonHandle | null {
  const root = document.getElementById("ribbon");
  const tabsEl = document.getElementById("ribbon-tabs");
  const groupsEl = document.getElementById("ribbon-groups");
  const moreWrap = document.getElementById("ribbon-more-wrap");
  const morePanel = document.getElementById("ribbon-more-dropdown");
  const compactBtn = document.getElementById("ribbon-compact");
  if (!root || !tabsEl || !groupsEl || !moreWrap || !morePanel || !compactBtn) return null;
  const more: DropdownHandle | null = setupDropdown("ribbon-more", "ribbon-more-dropdown");
  const gridBtn = document.getElementById("edits-grid-toggle");
  const editsPanel = document.getElementById("edits-panel");

  let state: RibbonState = { ...DEFAULT_RIBBON_STATE };
  /** The strip's own buttons, in order, for the active tab (the overflow rows are separate). */
  let stripButtons: { btn: HTMLButtonElement; item: RibbonItem; groupEl: HTMLElement; first: boolean }[] = [];
  let lastWidth = -1;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Tabs ───────────────────────────────────────────────────────────────────

  const tabButtons = new Map<RibbonTabId, HTMLButtonElement>();
  for (const id of RIBBON_TABS) {
    const b = document.createElement("button");
    b.type = "button";
    b.id = `ribbon-tab-${id}`;
    b.className = "ribbon-tab";
    b.dataset.tab = id;
    b.setAttribute("role", "tab");
    b.textContent = RIBBON_TAB_LABELS[id];
    b.addEventListener("click", () => setTab(id, true));
    b.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const at = RIBBON_TABS.indexOf(id);
      const next = RIBBON_TABS[(at + (e.key === "ArrowRight" ? 1 : RIBBON_TABS.length - 1)) % RIBBON_TABS.length];
      setTab(next, true);
      tabButtons.get(next)?.focus();
    });
    tabButtons.set(id, b);
    tabsEl.appendChild(b);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function buildButton(item: RibbonItem, rowStyle: boolean): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = rowStyle ? "ribbon-more-item" : "ribbon-btn";
    b.dataset.item = item.id;
    b.title = item.title;
    b.setAttribute("aria-label", item.label);
    if (rowStyle) b.setAttribute("role", "menuitem");
    const ic = document.createElement("span");
    ic.className = "ribbon-icon";
    ic.setAttribute("aria-hidden", "true");
    if (item.icon.kind === "panel" && item.target.type === "panel") {
      const svg = document.getElementById(item.target.panelId)?.querySelector(".panel-icon svg");
      if (svg) ic.appendChild(svg.cloneNode(true));
    } else {
      ic.innerHTML = iconHtml(item);
    }
    const label = document.createElement("span");
    label.className = "ribbon-label";
    label.textContent = item.label;
    b.append(ic, label);
    b.addEventListener("click", () => run(item));
    return b;
  }

  function renderTab(): void {
    groupsEl!.textContent = "";
    stripButtons = [];
    const groups: RibbonGroup[] = ribbonGroups(state.tab);
    for (const g of groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "ribbon-group";
      groupEl.setAttribute("role", "group");
      groupEl.setAttribute("aria-label", g.title);
      groupEl.dataset.group = g.title;
      const row = document.createElement("div");
      row.className = "ribbon-group-buttons";
      const title = document.createElement("div");
      title.className = "ribbon-group-title";
      title.textContent = g.title;
      g.items.forEach((item, i) => {
        const btn = buildButton(item, false);
        row.appendChild(btn);
        stripButtons.push({ btn, item, groupEl, first: i === 0 });
      });
      groupEl.append(row, title);
      groupsEl!.appendChild(groupEl);
    }
    refresh();
    fit();
  }

  /** Rebuilds the ▸ menu from the items the strip had no room for. */
  function renderMore(overflowing: { item: RibbonItem; group: string }[]): void {
    morePanel!.textContent = "";
    let lastGroup = "";
    for (const { item, group } of overflowing) {
      if (group !== lastGroup) {
        const head = document.createElement("div");
        head.className = "ribbon-more-head";
        head.textContent = group;
        morePanel!.appendChild(head);
        lastGroup = group;
      }
      const row = buildButton(item, true);
      row.addEventListener("click", () => more?.close());
      morePanel!.appendChild(row);
    }
  }

  function fit(): void {
    // Measure with everything shown and no ▸ button, then hide what does not fit.
    for (const s of stripButtons) { s.btn.hidden = false; s.groupEl.hidden = false; }
    moreWrap!.hidden = true;
    more?.close();
    const available = groupsEl!.clientWidth;
    lastWidth = root!.clientWidth;
    if (stripButtons.length === 0) return;
    const base = groupsEl!.getBoundingClientRect().left;
    const rights = stripButtons.map((s) => s.btn.getBoundingClientRect().right - base);
    let keep = planOverflow(rights, stripButtons.map((s) => s.first), available, 0);
    if (keep < stripButtons.length) {
      moreWrap!.hidden = false;
      keep = planOverflow(rights, stripButtons.map((s) => s.first), available, moreWrap!.offsetWidth);
    }
    const overflowing: { item: RibbonItem; group: string }[] = [];
    stripButtons.forEach((s, i) => {
      s.btn.hidden = i >= keep;
      if (i >= keep) overflowing.push({ item: s.item, group: s.groupEl.dataset.group ?? "" });
    });
    for (const g of new Set(stripButtons.map((s) => s.groupEl))) {
      g.hidden = Array.from(g.querySelectorAll<HTMLButtonElement>(".ribbon-btn")).every((b) => b.hidden);
    }
    moreWrap!.hidden = overflowing.length === 0;
    renderMore(overflowing);
    refresh();
  }

  // ── Mirrored state ─────────────────────────────────────────────────────────

  function targetOf(item: RibbonItem): HTMLElement | null {
    if (item.target.type === "click") return document.querySelector<HTMLElement>(item.target.selector);
    if (item.target.type === "panel") return document.getElementById(item.target.panelId);
    return null;
  }

  function stateOf(item: RibbonItem): { disabled: boolean; pressed: boolean } {
    if (item.target.type === "op") {
      return { disabled: !host.isOpAvailable(item.target.opId), pressed: host.activeOp() === item.target.opId };
    }
    const el = targetOf(item);
    if (!el) return { disabled: true, pressed: false };
    if (item.target.type === "panel") return { disabled: isUnavailable(el), pressed: false };
    const disabled = (el as HTMLButtonElement).disabled === true || isUnavailable(el);
    return { disabled, pressed: el.getAttribute("aria-checked") === "true" || el.classList.contains("active") };
  }

  function refresh(): void {
    const seen = new Map<string, { disabled: boolean; pressed: boolean }>();
    const items = new Map(stripButtons.map((s) => [s.item.id, s.item]));
    for (const b of root!.querySelectorAll<HTMLButtonElement>("[data-item]")) {
      const id = b.dataset.item!;
      const entry = items.get(id);
      if (!entry) continue;
      let st = seen.get(id);
      if (!st) { st = stateOf(entry); seen.set(id, st); }
      b.disabled = st.disabled;
      b.classList.toggle("active", st.pressed);
      if (entry.toggle || entry.target.type === "op") b.setAttribute("aria-pressed", String(st.pressed));
      else b.removeAttribute("aria-pressed");
    }
  }

  function scheduleRefresh(): void {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 60);
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  function run(item: RibbonItem): void {
    const t = item.target;
    if (t.type === "op") {
      if (!host.isOpAvailable(t.opId) || !host.openOp(t.opId)) {
        host.setStatus(`${item.label} is not available for this document (B-rep only).`, true);
      }
    } else if (t.type === "click") {
      const el = targetOf(item);
      if (el && !(el as HTMLButtonElement).disabled && !isUnavailable(el)) el.click();
    } else {
      const el = targetOf(item);
      if (el && !isUnavailable(el)) revealPanel(el);
    }
    refresh();
  }

  function applyState(): void {
    for (const [id, b] of tabButtons) {
      const on = id === state.tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    document.body.classList.toggle("ribbon-compact", state.compact);
    compactBtn!.setAttribute("aria-pressed", String(state.compact));
    compactBtn!.title = state.compact ? "Show the button labels" : "Hide the button labels (icons only)";
    editsPanel?.classList.toggle("grid-collapsed", !state.editsGridOpen);
    gridBtn?.setAttribute("aria-pressed", String(state.editsGridOpen));
    if (gridBtn) gridBtn.title = state.editsGridOpen
      ? "Hide the op button grid (the ribbon covers it)"
      : "Show the op button grid (the ribbon covers it)";
  }

  function setTab(tab: RibbonTabId, user: boolean): void {
    if (tab === state.tab && stripButtons.length > 0) return;
    state = { ...state, tab };
    applyState();
    renderTab();
    if (user) host.onChange({ ...state });
  }

  compactBtn.addEventListener("click", () => {
    state = { ...state, compact: !state.compact };
    applyState();
    fit();
    host.onChange({ ...state });
  });
  gridBtn?.addEventListener("click", () => {
    state = { ...state, editsGridOpen: !state.editsGridOpen };
    applyState();
    host.onChange({ ...state });
  });

  // ── Wiring ─────────────────────────────────────────────────────────────────

  // Re-plan on width changes. Observes the strip's OWN box (which spans the
  // window), not #ribbon-groups, whose width changes whenever ▸ appears — that
  // would re-trigger fit() from fit()'s own result.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      if (root.clientWidth !== lastWidth) fit();
    }).observe(root);
  }

  // Mirror target state. Never observes #ribbon itself, so refresh() cannot feed back.
  if (typeof MutationObserver !== "undefined") {
    const mo = new MutationObserver(scheduleRefresh);
    const watch = (el: Element | null, filter: string[]): void => {
      if (el) mo.observe(el, { subtree: true, attributes: true, attributeFilter: filter });
    };
    watch(document.getElementById("toolbar"), ["aria-checked", "class", "hidden", "disabled", "style"]);
    watch(document.getElementById("view-controls"), ["aria-checked", "class", "hidden", "disabled"]);
    watch(document.getElementById("menubar"), ["aria-checked", "class", "hidden", "disabled"]);
    watch(document.getElementById("side"), ["class", "hidden", "disabled"]);
  }

  applyState();
  renderTab();

  return {
    getState: () => ({ ...state }),
    setState(next) {
      state = {
        tab: sanitizeRibbonTab(next?.tab) ?? DEFAULT_RIBBON_STATE.tab,
        compact: next?.compact === true,
        editsGridOpen: next?.editsGridOpen === true,
      };
      applyState();
      renderTab();
    },
    refresh,
    fit,
  };
}
