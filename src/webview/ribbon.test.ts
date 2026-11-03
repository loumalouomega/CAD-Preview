import { describe, expect, it } from "vitest";
import { TOOLBAR_ICONS } from "../toolbarIcons";
import { UI_GLYPHS } from "../uiGlyphs";
import { viewerBodyHtml } from "../viewerDom";
import { COLLAPSIBLE_PANELS } from "./collapsiblePanels";
import { OP_CATALOG, allCatalogEntries } from "./opCatalog";
import { OP_ICONS } from "./opIcons";
import {
  RIBBON_TABS,
  allRibbonItems,
  modelGroups,
  planOverflow,
  ribbonGroups,
  ribbonOpIds,
  sanitizeRibbonTab,
  type RibbonItem,
} from "./ribbon";

const html = viewerBodyHtml();

/** Does `viewerBodyHtml()` contain an element matching a simple `#id` or `.cls[data-a="v"]` selector? */
function selectorExists(selector: string): boolean {
  const id = /^#([\w-]+)$/.exec(selector);
  if (id) return html.includes(`id="${id[1]}"`);
  const seg = /^\.([\w-]+)\[data-([\w-]+)="([^"]+)"\]$/.exec(selector);
  if (seg) {
    const tag = new RegExp(`<button[^>]*data-${seg[2]}="${seg[3]}"[^>]*>`).exec(html)?.[0] ?? "";
    return new RegExp(`class="[^"]*\\b${seg[1]}\\b`).test(tag);
  }
  throw new Error(`ribbon test cannot parse selector ${selector}`);
}

describe("ribbon: single source with the op catalog", () => {
  it("every catalog op button is reachable from the strip, and the strip adds no op the catalog lacks", () => {
    const reachable = ribbonOpIds();
    const catalog = allCatalogEntries().map((e) => e.id);
    expect(catalog.filter((id) => !reachable.has(id))).toEqual([]);
    expect([...reachable].filter((id) => !catalog.includes(id))).toEqual([]);
  });

  it("every op button has a form: a catalog entry, an icon, the catalog's label and B-rep gate", () => {
    const byId = new Map(allCatalogEntries().map((e) => [e.id, e]));
    for (const { item } of allRibbonItems()) {
      if (item.target.type !== "op") continue;
      const entry = byId.get(item.target.opId);
      expect(entry, item.id).toBeDefined();
      expect(OP_ICONS[item.target.opId], `${item.id} icon`).toMatch(/^<svg/);
      expect(item.label).toBe(entry!.label);
      expect(!!item.brepOnly).toBe(entry!.brepOnly);
      expect(item.icon).toEqual({ kind: "op", id: item.target.opId });
    }
  });

  it("the Model tab lists each op exactly once, in catalog groups", () => {
    const ids = modelGroups().flatMap((g) => g.items.filter((i) => i.target.type === "op").map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(allCatalogEntries().length);
    // Same count of catalog categories as ribbon op groups: nothing folded away.
    const categories = [...OP_CATALOG.geometry2d, ...OP_CATALOG.geometry3d, ...OP_CATALOG.edit].length;
    expect(modelGroups().filter((g) => g.items.some((i) => i.target.type === "op")).length).toBe(categories);
  });
});

describe("ribbon: every button targets something that exists", () => {
  it("item ids are unique across all tabs and group titles are unique within a tab", () => {
    const ids = allRibbonItems().map((x) => x.item.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    for (const tab of RIBBON_TABS) {
      const titles = ribbonGroups(tab).map((g) => g.title);
      expect(new Set(titles).size, tab).toBe(titles.length);
      expect(titles.length, tab).toBeGreaterThan(0);
      for (const g of ribbonGroups(tab)) expect(g.items.length, `${tab}/${g.title}`).toBeGreaterThan(0);
    }
  });

  it("click targets exist in the shipped viewer markup", () => {
    for (const { item } of allRibbonItems()) {
      if (item.target.type === "click") expect(selectorExists(item.target.selector), `${item.id} -> ${item.target.selector}`).toBe(true);
    }
  });

  it("panel targets are real collapsible sidebar sections with a header icon", () => {
    const known = new Set(COLLAPSIBLE_PANELS.map((p) => p.panel));
    for (const { item } of allRibbonItems()) {
      if (item.target.type !== "panel") continue;
      const id = item.target.panelId;
      expect(known.has(id), `${item.id} is not a collapsible panel`).toBe(true);
      expect(html.includes(`id="${id}"`), `${id} missing from the markup`).toBe(true);
      const header = COLLAPSIBLE_PANELS.find((p) => p.panel === id)!.header;
      const after = html.slice(html.indexOf(`id="${header}"`));
      expect(after.slice(0, after.indexOf("</div>")), `${id} header icon`).toContain("panel-icon");
    }
  });

  it("toolbar and glyph icons are ids the generated sets really carry", () => {
    for (const { item } of allRibbonItems()) {
      if (item.icon.kind === "toolbar") expect(TOOLBAR_ICONS[item.icon.id], item.id).toMatch(/^<svg/);
      if (item.icon.kind === "glyph") expect(UI_GLYPHS[item.icon.id], item.id).toMatch(/^<svg/);
    }
  });

  it("every item has a label and a title", () => {
    const bad = allRibbonItems().filter(({ item }: { item: RibbonItem }) => !item.label.trim() || !item.title.trim());
    expect(bad).toEqual([]);
  });

  it("the markup carries the skeleton ribbonStrip.ts fills", () => {
    for (const id of ["ribbon", "ribbon-tabs", "ribbon-groups", "ribbon-more-wrap", "ribbon-more", "ribbon-more-dropdown", "ribbon-compact", "edits-grid-toggle"]) {
      expect(html.includes(`id="${id}"`), id).toBe(true);
    }
  });
});

describe("ribbon: tabs", () => {
  it("are View, Model, Inspect, Mesh, Export in that order", () => {
    expect([...RIBBON_TABS]).toEqual(["view", "model", "inspect", "mesh", "export"]);
  });
  it("sanitizeRibbonTab keeps known ids and drops everything else", () => {
    expect(sanitizeRibbonTab("mesh")).toBe("mesh");
    expect(sanitizeRibbonTab("Mesh")).toBeNull();
    expect(sanitizeRibbonTab("sketch")).toBeNull();
    expect(sanitizeRibbonTab(3)).toBeNull();
    expect(sanitizeRibbonTab(undefined)).toBeNull();
  });
});

describe("planOverflow", () => {
  // Five items of width 100 in groups [0,1] [2,3] [4].
  const rights = [100, 200, 300, 400, 500];
  const starts = [true, false, true, false, true];

  it("keeps everything when it all fits", () => {
    expect(planOverflow(rights, starts, 500, 60)).toBe(5);
    expect(planOverflow(rights, starts, 900, 60)).toBe(5);
  });
  it("reserves room for the More button once anything overflows", () => {
    // 450 available, 60 reserved -> limit 390 -> three items fit, group boundary at 2 -> keep 2.
    expect(planOverflow(rights, starts, 450, 60)).toBe(2);
    // 480 - 60 = 420 -> four fit, but the boundary before item 4 is the group start at 4.
    expect(planOverflow(rights, starts, 480, 60)).toBe(4);
  });
  it("never splits a group across the strip and the menu when an earlier boundary exists", () => {
    expect(planOverflow(rights, starts, 350, 60)).toBe(2);
  });
  it("splits the first group rather than showing nothing when it alone is too wide", () => {
    expect(planOverflow(rights, starts, 180, 60)).toBe(1);
  });
  it("keeps zero when not even one item fits beside the button", () => {
    expect(planOverflow(rights, starts, 120, 60)).toBe(0);
  });
  it("handles an empty strip", () => {
    expect(planOverflow([], [], 100, 60)).toBe(0);
  });
});
