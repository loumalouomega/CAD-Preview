/**
 * A resizable sidebar: a drag handle on `#side`'s right edge plus the
 * minimum/maximum widths that dragging (and keyboard steps) clamp to.
 *
 * Split the way `collapsiblePanels.ts` is — pure clamping constants at the top
 * (unit-testable headless, safe to import by VALUE from the host-side
 * `viewStateSidecar.ts`), DOM wiring below with **no DOM access at module
 * scope** (this project's vitest config has no jsdom; a module-scope
 * `document` access has broken headless imports before).
 *
 * Persistence rides `ViewState.sidebarWidth` in `<model>.view.json` — the
 * `collapsedPanels` precedent exactly: an additive top-level sibling of
 * `view`, no `VIEW_STATE_SIDECAR_VERSION` bump, and any value a hand-edited
 * sidecar carries is clamped through {@link clampSidebarWidth} before it
 * reaches the layout.
 */

/** Minimum usable width — below this the FE Mesh/Standard Parts rows wrap badly. */
export const SIDEBAR_MIN_PX = 176;

/** Anything wider steals more canvas than an inspection sidebar is worth. */
export const SIDEBAR_MAX_PX = 420;

/** The pre-resizer fixed width; widths equal to this are never serialized. */
export const SIDEBAR_DEFAULT_PX = 220;

/**
 * Clamps a sidecar/drag width into `[SIDEBAR_MIN_PX, SIDEBAR_MAX_PX]`.
 * `null` for a non-finite/non-numeric value — a genuinely missing or
 * hand-garbage field means "not persisted", never "as narrow as 0px".
 */
export function clampSidebarWidth(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(SIDEBAR_MAX_PX, Math.max(SIDEBAR_MIN_PX, Math.round(value)));
}

/** How far a keyboard step (ArrowLeft/ArrowRight on the handle) moves the edge. */
export const SIDEBAR_KEYBOARD_STEP_PX = 16;

/** What `setupSidebarResizer` hands back. */
export interface SidebarResizerHandle {
  /** Current width, px (the live drag state; `SIDEBAR_DEFAULT_PX` when untouched). */
  getWidth(): number;
  /**
   * Applies a width directly — the restore path, deliberately SILENT: it never
   * calls `onChange`, so reopening a document can't rewrite the sidecar it
   * just read (the same silent-`load()` contract `PartsModel`/`PlanesModel`
   * and `setCollapsed` follow).
   */
  setWidth(width: number): void;
}

/**
 * Wires the `#sidebar-resize` handle inside `#side`. `onChange` fires after a
 * drag moves the edge and after every keyboard step — never from `setWidth`.
 * It receives the clamped width in px; the caller owns applying the layout
 * (CSS var + viewer reflow) and persisting it.
 *
 * Returns `null` rather than throwing when the sidebar or handle is missing —
 * callers sit inside `main.ts`'s shared setup `try` where a throw would block
 * the `ready` handshake and leave the webview permanently blank (the reason
 * `dropdownMenu.ts`'s `setupDropdown` states for the same choice).
 */
export function setupSidebarResizer(onChange: (width: number) => void): SidebarResizerHandle | null {
  const side = document.getElementById("side");
  const handle = document.getElementById("sidebar-resize");
  if (!side || !handle) return null;

  // The caller reads this var for `#side{width}` and `#view-controls`' centre —
  // one custom property on <body> is the single shared fact both read.
  const applyVar = (width: number): void => {
    document.body.style.setProperty("--side-width", `${width}px`);
  };

  let current = SIDEBAR_DEFAULT_PX;
  applyVar(current);

  const step = (delta: number): void => {
    const next = clampSidebarWidth(current + delta);
    if (next === null || next === current) return;
    current = next;
    applyVar(current);
    onChange(current);
  };

  // The handle is a real `<button role="separator">`, so keyboard resize is
  // operable without a mouse: ArrowLeft/Right step, Home/End jump to the clamps.
  handle.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") step(-SIDEBAR_KEYBOARD_STEP_PX);
    else if (e.key === "ArrowRight") step(SIDEBAR_KEYBOARD_STEP_PX);
    else if (e.key === "Home") step(SIDEBAR_MIN_PX - current);
    else if (e.key === "End") step(SIDEBAR_MAX_PX - current);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  let dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    document.body.classList.add("sidebar-resizing");
    // Capture so a drag that leaves the 6px strip keeps resizing, and so the
    // canvas's own pane-gate/orbit listeners never see this pointer (the same
    // capture-discipline `dropdownMenu.ts`'s outside-click rule established;
    // setPointerCapture additionally keeps the drag alive past the window edge).
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // A released pointer can refuse capture — drag still works locally.
    }
    e.preventDefault();
    e.stopPropagation();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    // The rect can be 0 wide while #side is display:none, which must never
    // drive the width — the clamp is the only width authority.
    const next = clampSidebarWidth(e.clientX - side.getBoundingClientRect().left);
    if (next === null || next === current) return;
    current = next;
    applyVar(current);
    onChange(current);
  });
  const endDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("sidebar-resizing");
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    // Persist via the same callback the moves used — one save path; the
    // debounced (500 ms) autosave coalesces the whole drag into one write.
    onChange(current);
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);

  return {
    getWidth: () => current,
    setWidth(width: number) {
      const clamped = clampSidebarWidth(width);
      if (clamped === null) return;
      current = clamped;
      applyVar(current);
      // No onChange — restore must not echo a save.
    },
  };
}
