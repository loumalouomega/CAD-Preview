import { describe, it, expect } from "vitest";
import { COLLAPSIBLE_PANELS, sanitizeCollapsedPanels } from "./collapsiblePanels";
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

  it("covers every direct #side panel, so no section is silently uncollapsible", () => {
    const side = html.slice(html.indexOf('<div id="side">'), html.indexOf('<div id="app">'));
    const ids = [...side.matchAll(/<div id="([a-z-]+-panel)"/g)].map((m) => m[1]);
    expect(new Set(ids)).toEqual(new Set(COLLAPSIBLE_PANELS.map((e) => e.panel)));
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
