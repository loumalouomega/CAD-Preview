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

/**
 * The twelve collapsible sidebar sections, in `#side` source order.
 *
 * `advanced-group` is a GROUP rather than a leaf section: it wraps the seven
 * entries after it (the read-only analysis sections plus the two library
 * ones). It carries its own id here because collapsing it is persisted like
 * any other section, and its children keep theirs because each stays
 * independently collapsible inside it.
 */
export const COLLAPSIBLE_PANELS: readonly { readonly panel: string; readonly header: string }[] = [
  { panel: "tree-panel", header: "tree-header" },
  { panel: "parts-panel", header: "parts-header" },
  { panel: "edits-panel", header: "edits-header" },
  { panel: "meshing-panel", header: "meshing-header" },
  { panel: "advanced-group", header: "advanced-header" },
  { panel: "mass-panel", header: "mass-header" },
  { panel: "clash-panel", header: "clash-header" },
  { panel: "mesh-health-panel", header: "mesh-health-header" },
  { panel: "region-fit-panel", header: "region-fit-header" },
  { panel: "primitives-panel", header: "primitives-header" },
  { panel: "passages-panel", header: "passages-header" },
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
  // The chevron is an SVG glyph rotated by CSS off `aria-expanded`, so nothing
  // here rewrites its content.
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

/** The sections the Advanced group wraps, in `#advanced-body` source order. */
export const ADVANCED_CHILDREN: readonly string[] = [
  "mass-panel",
  "clash-panel",
  "mesh-health-panel",
  "region-fit-panel",
  "primitives-panel",
  "passages-panel",
  "macros-panel",
  "standard-parts-panel",
];

/**
 * Text for the Advanced header's availability badge.
 *
 * Four of the seven children are gated on source format and hide themselves at
 * runtime (Mesh Health and Region fit want a mesh source, Clash and Primitives
 * a B-rep one), so a collapsed group would otherwise give no hint whether
 * opening it is worth the click. Pure, so the wording is unit-testable apart
 * from the DOM that feeds it.
 */
export function advancedCountLabel(available: number, total: number): string {
  return available === total ? String(total) : `${available} of ${total}`;
}

/**
 * Keeps `#advanced-count` truthful as children hide and show themselves.
 *
 * Observes the `hidden` attribute rather than exposing a refresh the four
 * gating panels must each remember to call: eligibility is recomputed from
 * several sites (`geometry`, `loadUrl`, `loadMeshBytes`) at times this module
 * does not control, and a hand-maintained call list is exactly the kind of
 * thing that drifts. Same reasoning as `main.ts`'s aria-label mirror, which
 * had to become an observer for dynamically-built rows.
 *
 * Returns without wiring anything when the group is absent, for the same
 * reason `setupCollapsiblePanels` does: callers sit in `main.ts`'s shared
 * setup `try`, where a throw would block the `ready` handshake.
 */
export function setupAdvancedGroupCount(): void {
  const body = document.getElementById("advanced-body");
  const badge = document.getElementById("advanced-count");
  if (!body || !badge) return;

  const children = ADVANCED_CHILDREN.map((id) => document.getElementById(id)).filter(
    (el): el is HTMLElement => el !== null
  );
  if (children.length === 0) return;

  const refresh = (): void => {
    badge.textContent = advancedCountLabel(children.filter((el) => !el.hidden).length, children.length);
  };

  new MutationObserver(refresh).observe(body, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
  refresh();
}
