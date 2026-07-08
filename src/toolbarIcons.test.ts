import { describe, expect, it } from "vitest";
import { TOOLBAR_ICONS, type ToolbarIconId } from "./toolbarIcons";

const EXPECTED_IDS: ToolbarIconId[] = [
  "close", "export", "feMesh", "fit", "generate", "home", "line", "open",
  "point", "save", "saveAs", "select", "surface", "tree", "volume", "warning", "wireframe",
];

describe("TOOLBAR_ICONS", () => {
  it("has exactly the expected ids", () => {
    expect(Object.keys(TOOLBAR_ICONS).sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("every icon is non-empty SVG markup with a viewBox", () => {
    for (const [id, svg] of Object.entries(TOOLBAR_ICONS)) {
      expect(svg.startsWith("<svg"), `${id} should start with <svg`).toBe(true);
      expect(svg, `${id} should end with </svg>`).toMatch(/<\/svg>\s*$/);
      expect(svg, `${id} should have a viewBox`).toMatch(/viewBox="[\d.\s]+"/);
    }
  });

  it("never leaves a hardcoded width/height that would override CSS sizing", () => {
    for (const [id, svg] of Object.entries(TOOLBAR_ICONS)) {
      const svgTag = svg.slice(0, svg.indexOf(">") + 1);
      expect(svgTag, `${id} should not hardcode width`).not.toMatch(/\swidth="/);
      expect(svgTag, `${id} should not hardcode height`).not.toMatch(/\sheight="/);
    }
  });

  it("never leaves literal black — every stroke/fill should be currentColor-based", () => {
    for (const [id, svg] of Object.entries(TOOLBAR_ICONS)) {
      expect(svg, `${id} should not contain literal black rgb(0%,...)`).not.toMatch(/rgb\(0%, 0%, 0%\)/);
    }
  });

  it("never emits a duplicate fill-opacity attribute on the same path", () => {
    for (const [id, svg] of Object.entries(TOOLBAR_ICONS)) {
      for (const path of svg.match(/<path[^/]*\/>/g) ?? []) {
        const count = (path.match(/fill-opacity="/g) ?? []).length;
        expect(count, `${id} path has ${count} fill-opacity attrs: ${path}`).toBeLessThanOrEqual(1);
      }
    }
  });
});
