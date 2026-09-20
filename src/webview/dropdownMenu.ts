/**
 * Shared open/close plumbing for the webview's dropdown menus — the File ▾
 * menubar menu and the toolbar's View/Select/Measure/Markup menus.
 *
 * All DOM access happens inside `setupDropdown()`, never at module load: this
 * repo's vitest config has no jsdom, and module-scope `document` access has
 * broken headless imports before (see `geometryBuilder.dotTexture()` and
 * `labelOverlay.drawLabel()`). Module scope here holds only plain JS values.
 *
 * The markup contract is the one `#file-menu`/`#file-dropdown` already used:
 *
 *   <div class="tb-menu-wrap">                    <!-- position: relative -->
 *     <button id="x-menu" aria-haspopup="true" aria-expanded="false">…</button>
 *     <div id="x-dropdown" class="tb-dropdown hidden" role="menu">…</div>
 *   </div>
 */

export interface DropdownHandle {
  readonly trigger: HTMLElement;
  readonly panel: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

const registry = new Set<DropdownHandle>();
let globalsWired = false;

/** Closes every dropdown wired so far. */
export function closeAllDropdowns(): void {
  for (const handle of registry) handle.close();
}

function anyOpen(): boolean {
  for (const handle of registry) if (handle.isOpen()) return true;
  return false;
}

/** True when the event landed inside some registered menu (its panel or its trigger). */
function insideAnyMenu(target: Node | null): boolean {
  if (!target) return false;
  for (const handle of registry) {
    if (handle.trigger.contains(target) || handle.panel.contains(target)) return true;
  }
  return false;
}

function wireGlobals(): void {
  if (globalsWired) return;
  globalsWired = true;

  // A click outside any menu dismisses the open one — and *only* dismisses it.
  // Swallowing the event matters because the 3D canvas underneath is live: with
  // markup mode on, `#markup-canvas` is `pointer-events: auto`, so the same
  // click would otherwise also start drawing a stroke.
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (!anyOpen() || insideAnyMenu(e.target as Node | null)) return;
      e.preventDefault();
      e.stopPropagation();
      closeAllDropdowns();
    },
    true // capture: run before the canvas's own pointerdown listener
  );

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // Escape closes AND returns focus to the trigger that opened the menu —
    // keyboard-only users otherwise land nowhere (the panel is display:none,
    // so focus falls into the body) with no way back to what they opened.
    for (const handle of registry) {
      if (!handle.isOpen()) continue;
      closeAllDropdowns();
      handle.trigger.focus();
      return;
    }
    closeAllDropdowns();
  });
}

/**
 * Focusable elements inside a menu panel, in DOM order, visibility-filtered —
 * the arrow-key menu items. `<select>`/`<input>` are deliberately EXCLUDED:
 * a text field owns its arrows for caret motion and a `<select>` owns
 * up/down for option selection, so they stay reachable via Tab only.
 */
function focusablesIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>("button")).filter(
    (el) => !el.hasAttribute("disabled") && el.offsetParent !== null
  );
}

/**
 * Wires one trigger/panel pair. Returns `null` rather than throwing when either
 * element is missing — callers run inside `main.ts`'s shared setup `try` block,
 * where a throw must never block the `ready` handshake.
 */
export function setupDropdown(triggerId: string, panelId: string): DropdownHandle | null {
  const trigger = document.getElementById(triggerId);
  const panel = document.getElementById(panelId);
  if (!trigger || !panel) return null;

  const handle: DropdownHandle = {
    trigger,
    panel,
    isOpen: () => !panel.classList.contains("hidden"),
    open() {
      // Only one menu open at a time.
      for (const other of registry) if (other !== handle) other.close();
      panel.classList.remove("hidden");
      trigger.setAttribute("aria-expanded", "true");
    },
    close() {
      panel.classList.add("hidden");
      trigger.setAttribute("aria-expanded", "false");
    },
    toggle() {
      if (handle.isOpen()) handle.close();
      else handle.open();
    },
  };

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    handle.toggle();
  });

  // Roving arrow-key navigation WAI-ARIA menus expect (roadmap "Sidebar
  // layout and keyboard usability"): ArrowDown/ArrowUp cycle the menu's
  // buttons (wrapping), Home/End jump to first/last. Deliberately NOT applied
  // to `<input>`/`<select>` — a text field owns its arrows for caret motion
  // and a `<select>` owns up/down for option selection; those are reachable
  // via Tab. Tab itself stays native: the natural tab order already visits
  // everything in DOM order. Registered on the TRIGGER as well as the panel:
  // right after keyboard-opening, focus is still on the trigger (a sibling of
  // the panel, not a descendant), so a panel-only listener never fires for
  // the first step.
  const navigateByArrow = (e: KeyboardEvent): void => {
    if (!handle.isOpen()) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = focusablesIn(panel);
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowUp") next = idx <= 0 ? items.length - 1 : idx - 1;
    else next = idx < 0 ? 0 : (idx + 1) % items.length;
    if (next === idx && idx >= 0) return;
    e.preventDefault();
    e.stopPropagation();
    items[next].focus();
  };
  panel.addEventListener("keydown", navigateByArrow);
  trigger.addEventListener("keydown", navigateByArrow);

  // Clicks *inside* the panel deliberately leave it open — toggling a mode,
  // picking a tool, or opening the colour picker are all things you do in one
  // visit. One-shot items (Open…, Screenshot…) call `close()` themselves.

  registry.add(handle);
  wireGlobals();
  return handle;
}
