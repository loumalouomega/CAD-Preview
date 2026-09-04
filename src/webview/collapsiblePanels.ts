/**
 * Collapsing sidebar sections down to their headers, so the interface can be
 * reduced to just the panels you are actually using.
 *
 * Split the way every other webview module here is: pure data + a pure
 * sanitizer at the top (unit-testable, and safe to import from the HOST-side
 * `viewStateSidecar.ts` — the same cross-import precedent `DISPLAY_MODES` and
 * `viewerPanes` already set), DOM wiring below it, with **no DOM access at
 * module scope** (this project's vitest config has no jsdom, a trap that has
 * broken headless imports before — see `geometryBuilder.ts`'s `dotTexture()`).
 *
 * The chevron is a real `<button>` in each header rather than a click handler
 * on the header itself. That is forced by the markup, not a preference: every
 * header already contains action buttons (Isolate/New, Undo/Redo/Clear,
 * Generate/Export/Clear plus two `<select>`s, Compute, Check/Promote/Repair,
 * …) and `#tree-header` additionally holds the `<input id="tree-filter">`,
 * which a header-wide handler would toggle on every keystroke's click. A
 * button is also focusable and carries `aria-expanded` for free.
 *
 * Collapse state is display-only and lives in `<model>.view.json` alongside
 * the camera/display-mode/clip state — see `ViewState.collapsedPanels`.
 */

/** The nine collapsible sidebar sections, in `#side` source order. */
export const COLLAPSIBLE_PANELS: readonly { readonly panel: string; readonly header: string }[] = [
  { panel: "tree-panel", header: "tree-header" },
  { panel: "parts-panel", header: "parts-header" },
  { panel: "edits-panel", header: "edits-header" },
  { panel: "meshing-panel", header: "meshing-header" },
  { panel: "mass-panel", header: "mass-header" },
  { panel: "mesh-health-panel", header: "mesh-health-header" },
  { panel: "region-fit-panel", header: "region-fit-header" },
  { panel: "macros-panel", header: "macros-header" },
  { panel: "standard-parts-panel", header: "standard-parts-header" },
];

/**
 * Keeps only ids this build actually knows, deduped and in registry order.
 *
 * `.view.json` is hand-editable and is also read by other builds of this
 * extension, so this is what stops a stale or hostile entry (`"app"`, say)
 * from collapsing something that is not a sidebar section at all. Tolerant
 * rather than throwing, matching every other optional sidecar field.
 */
export function sanitizeCollapsedPanels(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const wanted = new Set(ids.filter((id): id is string => typeof id === "string"));
  return COLLAPSIBLE_PANELS.filter((p) => wanted.has(p.panel)).map((p) => p.panel);
}

/** What `setupCollapsiblePanels` hands back for the view-state round trip. */
export interface CollapsiblePanelsHandle {
  /** Currently-collapsed panel ids, in registry order. */
  getCollapsed(): string[];
  /** Applies a collapsed set wholesale; anything not listed is expanded. */
  setCollapsed(ids: string[]): void;
}

function reflect(panel: HTMLElement, chevron: HTMLElement | null, collapsed: boolean): void {
  panel.classList.toggle("collapsed", collapsed);
  if (!chevron) return;
  chevron.textContent = collapsed ? "▸" : "▾";
  chevron.setAttribute("aria-expanded", collapsed ? "false" : "true");
  chevron.setAttribute("title", collapsed ? "Expand section" : "Collapse section");
}

/**
 * Wires every section's chevron. `onChange` fires after a user toggle only —
 * never from `setCollapsed`, which is the restore path and must not echo a
 * save back (the same silent-`load()` contract `PartsModel`/`PlanesModel`
 * already follow).
 *
 * Returns `null` rather than throwing when the sidebar is missing, because
 * callers sit inside `main.ts`'s shared setup `try` where a throw would block
 * the `ready` handshake and leave the webview permanently blank — the reason
 * `dropdownMenu.ts`'s `setupDropdown` states for the same choice.
 */
export function setupCollapsiblePanels(onChange: () => void): CollapsiblePanelsHandle | null {
  const found: { panel: HTMLElement; chevron: HTMLElement | null }[] = [];

  for (const entry of COLLAPSIBLE_PANELS) {
    const panel = document.getElementById(entry.panel);
    if (!panel) continue;
    const chevron = document.getElementById(entry.header)?.querySelector<HTMLElement>(".panel-chevron") ?? null;
    found.push({ panel, chevron });
    chevron?.addEventListener("click", () => {
      reflect(panel, chevron, !panel.classList.contains("collapsed"));
      onChange();
    });
  }

  if (found.length === 0) return null;

  return {
    getCollapsed: () =>
      COLLAPSIBLE_PANELS.filter((e) => document.getElementById(e.panel)?.classList.contains("collapsed")).map(
        (e) => e.panel
      ),
    setCollapsed: (ids: string[]) => {
      const wanted = new Set(sanitizeCollapsedPanels(ids));
      for (const { panel, chevron } of found) reflect(panel, chevron, wanted.has(panel.id));
    },
  };
}
