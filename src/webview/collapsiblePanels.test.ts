import { describe, it, expect } from "vitest";
import {
  COLLAPSIBLE_PANELS,
  ADVANCED_CHILDREN,
  advancedCountLabel,
  sanitizeCollapsedPanels,
} from "./collapsiblePanels";
import { viewerBodyHtml } from "../viewerDom";

/**
 * `viewerDom.ts` is `vscode`-free and returns a plain string, so the registry
 * can be cross-checked against the REAL shipped markup here — the one thing
 * that would otherwise only fail at runtime, silently, as a section whose
 * chevron does nothing.
 */
describe("COLLAPSIBLE_PANELS matches the shipped DOM", () => {
  const html = viewerBodyHtml();

  it.each(COLLAPSIBLE_PANELS.map((e) => [e.panel, e.header] as const))(
    "%s / %s exist in viewerBodyHtml()",
    (panel, header) => {
      expect(html).toContain(`id="${panel}"`);
      expect(html).toContain(`id="${header}"`);
    }
  );

  it("gives every registered header the .panel-header class the CSS keys off", () => {
    for (const { header } of COLLAPSIBLE_PANELS) {
      expect(html).toContain(`<div id="${header}" class="panel-header">`);
    }
  });

  it("gives every registered header exactly one chevron button", () => {
    // Scoped per header: a global count would still pass if one header had two
    // chevrons and another none.
    for (const { header } of COLLAPSIBLE_PANELS) {
      const start = html.indexOf(`id="${header}"`);
      expect(start).toBeGreaterThan(-1);
      const segment = html.slice(start, html.indexOf("</div>", start));
      expect(segment.split('class="panel-chevron"').length - 1).toBe(1);
    }
  });

  it("covers every .side-section, so no section is silently uncollapsible", () => {
    // Keyed off the class the collapse CSS itself uses, not an id suffix: the
    // Advanced group is `#advanced-group`, and a `-panel`-shaped scan would
    // have missed it while still passing.
    const side = html.slice(html.indexOf('<div id="side">'), html.indexOf('<div id="app">'));
    const ids = [...side.matchAll(/<div id="([a-z-]+)" class="side-section/g)].map((m) => m[1]);
    expect(new Set(ids)).toEqual(new Set(COLLAPSIBLE_PANELS.map((e) => e.panel)));
  });

  it("nests exactly the eight Advanced children inside #advanced-body", () => {
    const start = html.indexOf('<div id="advanced-body">');
    expect(start).toBeGreaterThan(-1);
    const body = html.slice(start);
    for (const id of ADVANCED_CHILDREN) expect(body).toContain(`id="${id}"`);
    // The four that edit the document must stay OUT of the group.
    const before = html.slice(0, start);
    for (const id of ["tree-panel", "parts-panel", "edits-panel", "meshing-panel"]) {
      expect(before).toContain(`id="${id}"`);
    }
  });

  it("has unique ids", () => {
    expect(new Set(COLLAPSIBLE_PANELS.map((e) => e.panel)).size).toBe(COLLAPSIBLE_PANELS.length);
    expect(new Set(COLLAPSIBLE_PANELS.map((e) => e.header)).size).toBe(COLLAPSIBLE_PANELS.length);
  });
});

describe("sanitizeCollapsedPanels", () => {
  it("keeps known ids", () => {
    expect(sanitizeCollapsedPanels(["parts-panel", "mass-panel"])).toEqual(["parts-panel", "mass-panel"]);
  });

  it("drops ids this build doesn't know — a hand-edited sidecar must not reach other elements", () => {
    expect(sanitizeCollapsedPanels(["app", "side", "parts-panel", "toolbar"])).toEqual(["parts-panel"]);
  });

  it("dedupes and returns registry order regardless of input order", () => {
    expect(sanitizeCollapsedPanels(["mass-panel", "parts-panel", "mass-panel"])).toEqual([
      "parts-panel",
      "mass-panel",
    ]);
  });

  it("degrades to [] for a non-array, matching every other tolerant sidecar field", () => {
    for (const bad of [undefined, null, "parts-panel", 42, {}]) {
      expect(sanitizeCollapsedPanels(bad)).toEqual([]);
    }
  });

  it("ignores non-string elements without dropping the good ones beside them", () => {
    expect(sanitizeCollapsedPanels([1, "parts-panel", null, { panel: "mass-panel" }])).toEqual(["parts-panel"]);
  });

  it("accepts every registered id at once", () => {
    const all = COLLAPSIBLE_PANELS.map((e) => e.panel);
    expect(sanitizeCollapsedPanels(all)).toEqual(all);
  });
});

describe("advancedCountLabel", () => {
  it("shows a bare total when every child is available", () => {
    expect(advancedCountLabel(7, 7)).toBe("7");
  });

  it("shows N of M once a source format gates some out", () => {
    expect(advancedCountLabel(5, 7)).toBe("5 of 7");
    expect(advancedCountLabel(0, 7)).toBe("0 of 7");
  });

  it("covers the whole Advanced group", () => {
    expect(ADVANCED_CHILDREN).toHaveLength(9);
    // Every child must also be individually collapsible, or its chevron is dead.
    const registered = new Set(COLLAPSIBLE_PANELS.map((e) => e.panel));
    for (const id of ADVANCED_CHILDREN) expect(registered.has(id)).toBe(true);
  });
});
