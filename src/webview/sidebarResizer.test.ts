import { describe, it, expect } from "vitest";
import {
  SIDEBAR_MIN_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_DEFAULT_PX,
  SIDEBAR_KEYBOARD_STEP_PX,
  clampSidebarWidth,
} from "./sidebarResizer";
import { viewerBodyHtml } from "../viewerDom";

/**
 * Pure half, headless. The DOM wiring is exercised over the real bundle by
 * `npm run test:webview` (this repo has no jsdom; the exact precedent is
 * `collapsiblePanels.test.ts`'s header note).
 */
describe("clampSidebarWidth", () => {
  it("keeps in-range values", () => {
    expect(clampSidebarWidth(220)).toBe(220);
    expect(clampSidebarWidth(SIDEBAR_MIN_PX)).toBe(SIDEBAR_MIN_PX);
    expect(clampSidebarWidth(SIDEBAR_MAX_PX)).toBe(SIDEBAR_MAX_PX);
  });

  it("clamps outside the range", () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_PX);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_PX);
    expect(clampSidebarWidth(-50)).toBe(SIDEBAR_MIN_PX);
  });

  it("rejects non-finite and non-numeric values as null — 'not persisted', never 0px", () => {
    expect(clampSidebarWidth(undefined)).toBeNull();
    expect(clampSidebarWidth(null)).toBeNull();
    expect(clampSidebarWidth("220")).toBeNull();
    expect(clampSidebarWidth("220px")).toBeNull();
    expect(clampSidebarWidth(NaN)).toBeNull();
    expect(clampSidebarWidth(Infinity)).toBeNull();
  });

  it("rounds to whole px", () => {
    expect(clampSidebarWidth(220.4)).toBe(220);
    expect(clampSidebarWidth(220.6)).toBe(221);
  });
});

describe("constants", () => {
  it("keep the documented contract", () => {
    expect(SIDEBAR_MIN_PX).toBeGreaterThanOrEqual(160);
    expect(SIDEBAR_MIN_PX).toBeLessThan(200);
    expect(SIDEBAR_MAX_PX).toBeGreaterThan(SIDEBAR_MIN_PX);
    expect(SIDEBAR_DEFAULT_PX).toBe(220);
    expect(SIDEBAR_KEYBOARD_STEP_PX).toBeGreaterThan(0);
  });
});

/**
 * `viewerDom.ts` is `vscode`-free and returns a plain string, so the handle is
 * cross-checked against the REAL shipped markup here — the one thing that
 * would otherwise only fail at runtime, silently, as a button that does
 * nothing (the `collapsiblePanels.test.ts` precedent).
 */
describe("the resize handle exists in the shipped DOM", () => {
  const html = viewerBodyHtml();

  it("has exactly one #sidebar-resize separator inside #side, before #app", () => {
    const sideStart = html.indexOf('<div id="side">');
    const appStart = html.indexOf('<div id="app">');
    expect(sideStart).toBeGreaterThan(-1);
    const segment = html.slice(sideStart, appStart);
    expect(segment.split('id="sidebar-resize"').length - 1).toBe(1);
  });

  it("is a real keyboard-separable button, not just a hover strip", () => {
    expect(html).toContain('id="sidebar-resize" type="button" role="separator"');
  });
});
