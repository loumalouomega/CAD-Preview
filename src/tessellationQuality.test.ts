import { describe, it, expect } from "vitest";
import {
  normalizeTessellationQuality,
  tessellationParamsFor,
  TESSELLATION_PRESETS,
  DEFAULT_TESSELLATION_QUALITY,
} from "./tessellationQuality";

describe("normalizeTessellationQuality", () => {
  it("accepts each valid quality unchanged", () => {
    expect(normalizeTessellationQuality("draft")).toBe("draft");
    expect(normalizeTessellationQuality("standard")).toBe("standard");
    expect(normalizeTessellationQuality("fine")).toBe("fine");
  });

  it("falls back to the default for anything else", () => {
    expect(normalizeTessellationQuality(undefined)).toBe(DEFAULT_TESSELLATION_QUALITY);
    expect(normalizeTessellationQuality(null)).toBe(DEFAULT_TESSELLATION_QUALITY);
    expect(normalizeTessellationQuality("ultra")).toBe(DEFAULT_TESSELLATION_QUALITY);
    expect(normalizeTessellationQuality(42)).toBe(DEFAULT_TESSELLATION_QUALITY);
  });
});

describe("tessellationParamsFor", () => {
  it("standard matches the original hardcoded constants exactly (backward compatibility)", () => {
    expect(tessellationParamsFor("standard")).toEqual({ linearDeflection: 0.1, angularDeflectionRad: 0.5 });
  });

  it("draft is coarser (larger deflections) than standard", () => {
    const draft = tessellationParamsFor("draft");
    const standard = tessellationParamsFor("standard");
    expect(draft.linearDeflection).toBeGreaterThan(standard.linearDeflection);
    expect(draft.angularDeflectionRad).toBeGreaterThan(standard.angularDeflectionRad);
  });

  it("fine is finer (smaller deflections) than standard", () => {
    const fine = tessellationParamsFor("fine");
    const standard = tessellationParamsFor("standard");
    expect(fine.linearDeflection).toBeLessThan(standard.linearDeflection);
    expect(fine.angularDeflectionRad).toBeLessThan(standard.angularDeflectionRad);
  });

  it("every preset has strictly positive deflections", () => {
    for (const quality of Object.keys(TESSELLATION_PRESETS) as Array<keyof typeof TESSELLATION_PRESETS>) {
      const params = tessellationParamsFor(quality);
      expect(params.linearDeflection).toBeGreaterThan(0);
      expect(params.angularDeflectionRad).toBeGreaterThan(0);
    }
  });
});
