import { describe, expect, it } from "vitest";
import { OP_ICONS } from "./opIcons";

// Completeness against `PanelOpId` is already covered by opCatalog.test.ts
// (which also checks OP_ICONS); this file only locks the SVG format
// invariants — mirrors ../toolbarIcons.test.ts, since both are produced by
// the same currentColor pipeline (icons/svgIconPostProcess.mjs).
describe("OP_ICONS", () => {
  it("every icon is non-empty SVG markup with a viewBox", () => {
    for (const [id, svg] of Object.entries(OP_ICONS)) {
      expect(svg.startsWith("<svg"), `${id} should start with <svg`).toBe(true);
      expect(svg, `${id} should end with </svg>`).toMatch(/<\/svg>\s*$/);
      expect(svg, `${id} should have a viewBox`).toMatch(/viewBox="[\d.\s]+"/);
    }
  });

  it("never leaves a hardcoded width/height that would override CSS sizing", () => {
    for (const [id, svg] of Object.entries(OP_ICONS)) {
      const svgTag = svg.slice(0, svg.indexOf(">") + 1);
      expect(svgTag, `${id} should not hardcode width`).not.toMatch(/\swidth="/);
      expect(svgTag, `${id} should not hardcode height`).not.toMatch(/\sheight="/);
    }
  });

  it("never leaves literal black — every stroke/fill should be currentColor-based", () => {
    for (const [id, svg] of Object.entries(OP_ICONS)) {
      expect(svg, `${id} should not contain literal black rgb(0%,...)`).not.toMatch(/rgb\(0%, 0%, 0%\)/);
    }
  });

  it("never leaves a literal white fill (would show as a solid blob, not a hole)", () => {
    for (const [id, svg] of Object.entries(OP_ICONS)) {
      expect(svg, `${id} should not contain literal white fill`).not.toMatch(/fill="rgb\(100%, 100%, 100%\)"/);
    }
  });

  it("never emits a duplicate fill-opacity attribute on the same path", () => {
    for (const [id, svg] of Object.entries(OP_ICONS)) {
      for (const path of svg.match(/<path[^/]*\/>/g) ?? []) {
        const count = (path.match(/fill-opacity="/g) ?? []).length;
        expect(count, `${id} path has ${count} fill-opacity attrs: ${path}`).toBeLessThanOrEqual(1);
      }
    }
  });
});
