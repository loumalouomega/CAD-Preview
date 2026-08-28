import { describe, it, expect, beforeEach } from "vitest";
import { parseCssColor, palette, refreshPalette, paletteColor, resetPaletteForTest, PALETTE_FALLBACKS } from "./palette";

describe("parseCssColor", () => {
  it("parses 6-digit hex", () => {
    expect(parseCssColor("#c0c4cc")).toBe(0xc0c4cc);
    expect(parseCssColor("#000000")).toBe(0x000000);
    expect(parseCssColor("#ffffff")).toBe(0xffffff);
  });

  it("expands 3-digit hex the way CSS does", () => {
    expect(parseCssColor("#abc")).toBe(0xaabbcc);
    expect(parseCssColor("#fff")).toBe(0xffffff);
  });

  it("is case-insensitive", () => {
    expect(parseCssColor("#C0C4CC")).toBe(0xc0c4cc);
  });

  it("tolerates the surrounding whitespace a computed custom property carries", () => {
    // getPropertyValue on a custom property preserves leading whitespace from
    // the declaration — a real source of misses if not trimmed.
    expect(parseCssColor("  #3b82f6 ")).toBe(0x3b82f6);
  });

  it("parses rgb() and rgba(), in case a host normalizes the value", () => {
    expect(parseCssColor("rgb(192, 196, 204)")).toBe(0xc0c4cc);
    expect(parseCssColor("rgba(59, 130, 246, 0.5)")).toBe(0x3b82f6);
    expect(parseCssColor("rgb(192 196 204)")).toBe(0xc0c4cc);
  });

  it("clamps out-of-range rgb channels rather than producing a corrupt number", () => {
    // 300 would overflow into the green byte if it were shifted unclamped.
    expect(parseCssColor("rgb(300, 0, 0)")).toBe(0xff0000);
    expect(parseCssColor("rgb(-20, 0, 0)")).toBe(0x000000);
  });

  it("returns null for anything it cannot read, so callers fall back", () => {
    // An undefined custom property computes to the empty string — this is the
    // case that actually matters in production.
    expect(parseCssColor("")).toBeNull();
    expect(parseCssColor("   ")).toBeNull();
    expect(parseCssColor("rebeccapurple")).toBeNull();
    expect(parseCssColor("color(display-p3 1 0 0)")).toBeNull();
    expect(parseCssColor("#ab")).toBeNull();
    expect(parseCssColor("#abcde")).toBeNull();
  });
});

describe("palette", () => {
  beforeEach(() => resetPaletteForTest());

  it("starts at the pre-theming constants", () => {
    expect(palette()).toEqual(PALETTE_FALLBACKS);
    expect(paletteColor("face")).toBe(0xc0c4cc);
    expect(paletteColor("accent")).toBe(0x3b82f6);
  });

  it("keeps the fallbacks when there is no DOM at all", () => {
    // This module is imported by geometryBuilder/viewer, which headless tests
    // import with no jsdom — refreshPalette must degrade, not throw.
    expect(() => refreshPalette()).not.toThrow();
    expect(palette()).toEqual(PALETTE_FALLBACKS);
  });

  it("collapses the selection and measurement accents onto one entry", () => {
    // These were two constants with the same value in two files. If a future
    // change reintroduces a second source, this pins the intent.
    expect(PALETTE_FALLBACKS.accent).toBe(0x3b82f6);
  });
});
