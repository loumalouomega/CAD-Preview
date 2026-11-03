/**
 * The ribbon's tab ids and their sanitizer — split out of `ribbon.ts` so the
 * HOST-side `viewStateSidecar.ts` can value-import them without dragging the op
 * catalog (and its icons) into the extension-host bundle, the same reason
 * `collapsiblePanels.ts` keeps `sanitizeCollapsedPanels` pure and tiny. No DOM,
 * no `three`, nothing at module scope but plain values.
 */
export const RIBBON_TABS = ["view", "model", "inspect", "mesh", "export"] as const;
export type RibbonTabId = (typeof RIBBON_TABS)[number];

export const RIBBON_TAB_LABELS: Readonly<Record<RibbonTabId, string>> = {
  view: "View",
  model: "Model",
  inspect: "Inspect",
  mesh: "Mesh",
  export: "Export",
};

/** What a document with no persisted choice shows (and what is NOT written to the sidecar). */
export const DEFAULT_RIBBON_TAB: RibbonTabId = "model";

/** A persisted tab id, or `null` when it is not one this build knows (hand-edited or newer sidecar). */
export function sanitizeRibbonTab(value: unknown): RibbonTabId | null {
  return typeof value === "string" && (RIBBON_TABS as readonly string[]).includes(value) ? (value as RibbonTabId) : null;
}
