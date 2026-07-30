import { describe, it, expect } from "vitest";
import { DISPLAY_MODES, DISPLAY_MODE_LABELS, isDisplayMode } from "./displayMode";

describe("isDisplayMode", () => {
  it("accepts every declared mode", () => {
    for (const mode of DISPLAY_MODES) expect(isDisplayMode(mode)).toBe(true);
  });

  it("rejects unknown strings", () => {
    expect(isDisplayMode("solid")).toBe(false);
    expect(isDisplayMode("")).toBe(false);
  });
});

describe("DISPLAY_MODE_LABELS", () => {
  it("has a label for every mode, and no extras", () => {
    expect(Object.keys(DISPLAY_MODE_LABELS).sort()).toEqual([...DISPLAY_MODES].sort());
  });
});
