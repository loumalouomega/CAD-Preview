import { describe, expect, it } from "vitest";
import { UI_GLYPHS, glyph } from "./uiGlyphs";

describe("UI_GLYPHS", () => {
  it("every glyph is currentColor SVG with a viewBox and no fixed size", () => {
    for (const [id, svg] of Object.entries(UI_GLYPHS)) {
      expect(svg.startsWith("<svg"), id).toBe(true);
      expect(svg, id).toMatch(/viewBox="0 0 24 24"/);
      expect(svg, id).toMatch(/currentColor/);
      const tag = svg.slice(0, svg.indexOf(">") + 1);
      expect(tag, id).not.toMatch(/\swidth="/);
      expect(tag, id).not.toMatch(/\sheight="/);
      // Only currentColor — no literal colour anywhere.
      expect(svg, id).not.toMatch(/#[0-9a-f]{3,6}|rgb\(/i);
    }
  });

  it("glyph() wraps in the shared span", () => {
    expect(glyph("eye")).toBe(`<span class="ui-glyph">${UI_GLYPHS.eye}</span>`);
  });
});
