/**
 * The ribbon command strip — the pure half (roadmap "Ribbon command strip").
 * DOM-free and `three`-free so it unit-tests headless; `ribbonStrip.ts` owns
 * the DOM and only calls into this module.
 *
 * The strip adds NO feature surface. Every button is one of three things, all
 * of which already exist:
 *  - an **op** — `opCatalog.ts`'s `PanelOpId`, opening the same form the
 *    Edits panel's button opens (the Model tab is GENERATED from the catalog,
 *    so a new op button is on the strip with no second list);
 *  - a **click** — a toolbar/menu element, clicked exactly as the user would;
 *  - a **panel** — a sidebar section, expanded and scrolled into view.
 *
 * `ribbon.test.ts` locks the single-source rule: every catalog op is reachable
 * from some tab, every op button has a form (an icon and a catalog entry), and
 * every click target exists in `viewerBodyHtml()`.
 */
import type { ToolbarIconId } from "../toolbarIcons";
import type { UiGlyphId } from "../uiGlyphs";
import { OP_CATALOG, type CatalogCategory, type PanelOpId } from "./opCatalog";
import { DEFAULT_RIBBON_TAB, RIBBON_TABS, type RibbonTabId } from "./ribbonTabs";

// ── Tabs ────────────────────────────────────────────────────────────────────

export { RIBBON_TABS, RIBBON_TAB_LABELS, DEFAULT_RIBBON_TAB, sanitizeRibbonTab, type RibbonTabId } from "./ribbonTabs";

// ── Items ───────────────────────────────────────────────────────────────────

/** Which existing icon a button draws. No icon is ever generated for the strip. */
export type RibbonIcon =
  | { kind: "op"; id: PanelOpId }
  | { kind: "toolbar"; id: ToolbarIconId }
  | { kind: "glyph"; id: UiGlyphId }
  /** The target sidebar section's own header icon. */
  | { kind: "panel" }
  /** Text only (the label stands alone). */
  | { kind: "none" };

/** What a button does. */
export type RibbonTarget =
  | { type: "op"; opId: PanelOpId }
  /** `selector` is clicked as the user would; `.click()` works inside a closed dropdown. */
  | { type: "click"; selector: string }
  /** A sidebar section id (`COLLAPSIBLE_PANELS`), expanded and scrolled into view. */
  | { type: "panel"; panelId: string };

export interface RibbonItem {
  /** Stable, unique across every tab (`op:fillet`, `click:grid`, `panel:mass-panel`). */
  id: string;
  label: string;
  title: string;
  target: RibbonTarget;
  icon: RibbonIcon;
  /** Greyed out for mesh sources — op items derive it from the catalog. */
  brepOnly?: boolean;
  /** The button mirrors an on/off state of its target (`aria-pressed`). */
  toggle?: boolean;
}

export interface RibbonGroup {
  title: string;
  items: RibbonItem[];
}

const click = (key: string, label: string, title: string, selector: string, icon: RibbonIcon, toggle = false): RibbonItem => ({
  id: `click:${key}`, label, title, target: { type: "click", selector }, icon, ...(toggle ? { toggle: true } : {}),
});
const panel = (panelId: string, label: string, title: string, idSuffix = ""): RibbonItem => ({
  id: `panel:${panelId}${idSuffix}`, label, title, target: { type: "panel", panelId }, icon: { kind: "panel" },
});
const tb = (id: ToolbarIconId): RibbonIcon => ({ kind: "toolbar", id });
const gl = (id: UiGlyphId): RibbonIcon => ({ kind: "glyph", id });

// ── Model tab: generated from the op catalog ────────────────────────────────

/** Most-used first: primitives and features lead; the 2D sketch tools close the row. */
const MODEL_ORDER: readonly { from: keyof typeof OP_CATALOG; title: string; as?: string }[] = [
  { from: "geometry3d", title: "Primitives" },
  { from: "geometry3d", title: "Holes" },
  { from: "edit", title: "Features" },
  { from: "edit", title: "Refine" },
  { from: "edit", title: "Boolean" },
  { from: "edit", title: "Modify" },
  { from: "edit", title: "Transform" },
  { from: "edit", title: "Assembly" },
  { from: "geometry3d", title: "Build from selection", as: "Build (3D)" },
  { from: "geometry2d", title: "Wireframe" },
  { from: "geometry2d", title: "Curves" },
  { from: "geometry2d", title: "Sketch profiles", as: "Sketch" },
  { from: "geometry2d", title: "Build from selection", as: "Build (2D)" },
];

function groupFromCategory(cat: CatalogCategory, title: string): RibbonGroup {
  return {
    title,
    items: cat.ops.map((o) => ({
      id: `op:${o.id}`,
      label: o.label,
      title: o.key ? `${o.label} (${o.key} with single-key commands on)` : o.label,
      target: { type: "op" as const, opId: o.id },
      icon: { kind: "op" as const, id: o.id },
      ...(o.brepOnly ? { brepOnly: true } : {}),
    })),
  };
}

/** The Model tab's groups, built from the catalog — never a hand-kept op list. */
export function modelGroups(): RibbonGroup[] {
  const groups: RibbonGroup[] = [];
  const used = new Set<CatalogCategory>();
  for (const spec of MODEL_ORDER) {
    const cat = OP_CATALOG[spec.from].find((c) => c.title === spec.title);
    if (!cat) continue;
    used.add(cat);
    groups.push(groupFromCategory(cat, spec.as ?? spec.title));
  }
  // A category added to the catalog later lands here instead of vanishing from the strip.
  for (const key of ["geometry3d", "edit", "geometry2d"] as const) {
    for (const cat of OP_CATALOG[key]) {
      if (!used.has(cat)) groups.push(groupFromCategory(cat, `${cat.title}${key === "geometry2d" ? " (2D)" : ""}`));
    }
  }
  groups.push({
    title: "Import",
    items: [
      click("import-svg", "Import SVG", "Import an SVG file's paths as standalone sketch polylines", "#menu-import-svg", tb("open")),
      click("import-dxf", "Import DXF", "Import a DXF file's entities as standalone sketch primitives", "#menu-import-dxf", tb("open")),
    ],
  });
  return groups;
}

// ── The non-op actions ──────────────────────────────────────────────────────

const VIEW_GROUPS: RibbonGroup[] = [
  {
    title: "Navigate",
    items: [
      click("fit", "Fit", "Fit the model to the view", "#fit", tb("fit")),
      click("view-reset", "Reset", "Reset to the default view", "#view-reset", gl("rotateCcw")),
      click("select-zoom", "Zoom to selection", "Frame the current selection", "#select-zoom", tb("view")),
      click("tree-toggle", "Tree", "Toggle the component tree (assemblies)", "#tree-toggle", gl("gitFork")),
    ],
  },
  {
    title: "Display",
    items: [
      click("mode-shaded", "Shaded", "Shaded: normal lit faces", '.display-mode-btn[data-mode="shaded"]', tb("shaded"), true),
      click("mode-wireframe", "Wire", "Wireframe: faces rendered as a mesh of lines", '.display-mode-btn[data-mode="wireframe"]', tb("wireframe"), true),
      click("mode-xray", "X-Ray", "X-Ray: translucent faces, edges visible through them", '.display-mode-btn[data-mode="xray"]', tb("xray"), true),
      click("mode-hiddenLines", "Hidden", "Hidden lines: occluded edges shown faintly", '.display-mode-btn[data-mode="hiddenLines"]', tb("hiddenLines"), true),
      click("mode-flat", "Flat", "Flat: unlit constant-colour faces", '.display-mode-btn[data-mode="flat"]', tb("flat"), true),
      click("mode-geometry", "Geometry", "Geometry: points, edges, faces and solids as distinct primitives", '.display-mode-btn[data-mode="geometry"]', tb("edges"), true),
    ],
  },
  {
    title: "Show",
    items: [
      click("grid", "Grid", "Toggle the grid and axis helpers", "#grid", tb("grid"), true),
      click("edges", "Edges", "Toggle edge visibility", "#edges", tb("edges"), true),
      click("ortho", "Projection", "Toggle orthographic / perspective projection", "#vc-ortho", gl("cube")),
    ],
  },
  {
    title: "Layout",
    items: [
      click("layout-1x1", "1×1", "Single view", '.layout-btn[data-layout="1x1"]', tb("layout1x1"), true),
      click("layout-1x2", "1×2", "Two side-by-side views", '.layout-btn[data-layout="1x2"]', tb("layout1x2"), true),
      click("layout-2x1", "2×1", "Two stacked views", '.layout-btn[data-layout="2x1"]', tb("layout2x1"), true),
      click("layout-2x2", "2×2", "Four views on a 2×2 grid", '.layout-btn[data-layout="2x2"]', tb("layout2x2"), true),
    ],
  },
  {
    title: "Pick & mark",
    items: [
      click("sel-toggle", "Select", "Toggle selection mode", "#sel-toggle", tb("select"), true),
      click("markup-toggle", "Markup", "Toggle markup mode", "#markup-toggle", tb("markup"), true),
      click("screenshot", "Screenshot", "Save the current view as a PNG", "#screenshot", tb("screenshot")),
    ],
  },
];

const INSPECT_GROUPS: RibbonGroup[] = [
  {
    title: "Measure",
    items: [
      click("measure-toggle", "Measure", "Toggle measure mode", "#measure-toggle", tb("measure"), true),
      click("tool-distance", "Distance", "Distance between two picks", '.measure-tool-btn[data-tool="distance"]', tb("distance"), true),
      click("tool-edgeLength", "Length", "Length of a picked edge", '.measure-tool-btn[data-tool="edgeLength"]', tb("edgeLength"), true),
      click("tool-angle", "Angle", "Angle between two picks", '.measure-tool-btn[data-tool="angle"]', tb("angle"), true),
      click("tool-radius", "Radius", "Radius of a picked arc", '.measure-tool-btn[data-tool="radius"]', tb("radius"), true),
      click("measure-clear", "Clear", "Clear the current measurement", "#measure-clear", tb("clear")),
    ],
  },
  {
    title: "Analysis",
    items: [
      panel("mass-panel", "Mass Properties", "Volume, area, mass and centre of mass"),
      panel("clash-panel", "Clash", "Check Parts for overlap and clearance"),
      panel("draft-panel", "Draft", "Draft and undercut analysis along a pull direction"),
      panel("printability-panel", "Printability", "Overhang, wall thickness and build-plate fit"),
      panel("brep-health-panel", "B-rep Health", "Validity check on the edited model"),
      panel("passages-panel", "Passages", "Annular gaps and slots against the mesh size"),
      panel("primitives-panel", "Primitives", "Recognise boxes, spheres, cylinders, cones and tori"),
    ],
  },
];

const MESH_GROUPS: RibbonGroup[] = [
  {
    title: "FE mesh",
    items: [
      click("meshing-toggle", "FE Mesh", "Toggle the FE mesh overlay", "#meshing-toggle", tb("feMesh"), true),
      panel("meshing-panel", "Mesh settings", "Open the FE Mesh panel: generate, quality, export"),
    ],
  },
  {
    title: "Repair & fit",
    items: [
      panel("mesh-health-panel", "Mesh Health", "Can this mesh be closed into a valid B-rep solid?"),
      panel("region-fit-panel", "Region fit", "Fit a plane, cylinder or sphere to a mesh region"),
    ],
  },
  {
    title: "Surface",
    items: [panel("surface-tools-panel", "Surface Tools", "Project a mesh to the CAD surface, grow prism layers")],
  },
];

const EXPORT_GROUPS: RibbonGroup[] = [
  {
    title: "Model",
    items: [
      click("menu-save", "Save", "Save parts/edits/mesh sidecars now", "#menu-save", tb("save")),
      click("menu-saveas", "Save As", "Export the model to a new file/format", "#menu-saveas", tb("saveAs")),
      click("menu-export", "Export", "Export the model to a new file/format", "#menu-export", tb("export")),
    ],
  },
  {
    title: "Drawings",
    items: [
      click("menu-export-svg", "SVG outline", "Export a 2D silhouette as an SVG drawing", "#menu-export-svg", tb("export")),
      click("menu-export-dxf", "DXF outline", "Export a 2D silhouette as a DXF drawing", "#menu-export-dxf", tb("export")),
      click("menu-export-drawing", "Drawing", "Export a technical drawing with hidden-line removal", "#menu-export-drawing", tb("export")),
      click("menu-export-sheet", "Drawing sheet", "Export a drafting sheet: front, top, right and iso views with a title block", "#menu-export-sheet", tb("export")),
    ],
  },
  {
    title: "Bundle",
    items: [
      click("menu-save-preprocess", "Save preprocess", "Bundle the CAD file and its sidecars into one .zip", "#menu-save-preprocess", tb("save")),
      click("menu-load-preprocess", "Load preprocess", "Restore a CAD file and its sidecars from a .zip", "#menu-load-preprocess", tb("open")),
    ],
  },
  {
    title: "Mesh",
    items: [panel("meshing-panel", "FE mesh export", "Open the FE Mesh panel: pick a format and export", "#export")],
  },
];

/** Every tab's groups, in display order. Built on demand (the Model tab reads the live catalog). */
export function ribbonGroups(tab: RibbonTabId): RibbonGroup[] {
  switch (tab) {
    case "view": return VIEW_GROUPS;
    case "model": return modelGroups();
    case "inspect": return INSPECT_GROUPS;
    case "mesh": return MESH_GROUPS;
    case "export": return EXPORT_GROUPS;
  }
}

/** Every item of every tab, flattened. */
export function allRibbonItems(): { tab: RibbonTabId; group: string; item: RibbonItem }[] {
  return RIBBON_TABS.flatMap((tab) => ribbonGroups(tab).flatMap((g) => g.items.map((item) => ({ tab, group: g.title, item }))));
}

/** The ops reachable from the strip — the reachability set `ribbon.test.ts` compares to the catalog. */
export function ribbonOpIds(): Set<PanelOpId> {
  const out = new Set<PanelOpId>();
  for (const { item } of allRibbonItems()) if (item.target.type === "op") out.add(item.target.opId);
  return out;
}

// ── Overflow planning ───────────────────────────────────────────────────────

/**
 * Decides how many leading items stay on the strip when it is too narrow.
 *
 * @param rights  each item's right edge, measured from the strip's left edge, in order
 * @param groupStart  `true` at the first item of each group
 * @param available  the strip's usable width
 * @param moreWidth  the width the ▸ button needs (reserved once anything overflows)
 * @returns the count of items kept visible; the rest belong in the overflow menu
 *
 * Everything fits → all items. Otherwise the longest prefix that fits beside
 * the ▸ button, backed off to a group boundary so a group is never split across
 * the strip and the menu — unless the FIRST group alone is wider than the strip,
 * where splitting it beats showing nothing.
 */
export function planOverflow(rights: readonly number[], groupStart: readonly boolean[], available: number, moreWidth: number): number {
  const n = rights.length;
  if (n === 0 || rights[n - 1] <= available) return n;
  const limit = available - moreWidth;
  let keep = 0;
  while (keep < n && rights[keep] <= limit) keep++;
  if (keep === 0 || keep === n) return keep;
  if (groupStart[keep]) return keep;
  for (let i = keep - 1; i > 0; i--) if (groupStart[i]) return i;
  return keep;
}

// ── Persisted state ─────────────────────────────────────────────────────────

/** The ribbon's slice of `ViewState` — all additive, all display-only. */
export interface RibbonState {
  tab: RibbonTabId;
  /** Labels hidden (icons only). */
  compact: boolean;
  /** The Edits panel's op button grid is expanded (default: collapsed, the strip covers it). */
  editsGridOpen: boolean;
}

export const DEFAULT_RIBBON_STATE: Readonly<RibbonState> = Object.freeze({
  tab: DEFAULT_RIBBON_TAB,
  compact: false,
  editsGridOpen: false,
});
