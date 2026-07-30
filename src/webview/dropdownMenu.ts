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
    if (e.key === "Escape") closeAllDropdowns();
  });
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

  // Clicks *inside* the panel deliberately leave it open — toggling a mode,
  // picking a tool, or opening the colour picker are all things you do in one
  // visit. One-shot items (Open…, Screenshot…) call `close()` themselves.

  registry.add(handle);
  wireGlobals();
  return handle;
}
