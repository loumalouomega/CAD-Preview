import { describe, it, expect } from "vitest";
import { FIT_TO_CAD_LEVELS } from "./fitToCadLevels";

describe("Fit to CAD levels", () => {
  it("offers the kernel defaults first, so a plain Enter changes nothing", () => {
    expect(FIT_TO_CAD_LEVELS[0].id).toBe("default");
    expect(FIT_TO_CAD_LEVELS[0].options).toEqual({});
  });
  it("refines the patches at a tolerance above an optimizer skin's roughness", () => {
    const refine = FIT_TO_CAD_LEVELS.find((l) => l.id === "refine")!;
    expect(refine.options).toEqual({ refineSegmentation: true, refineTolerance: 2e-3 });
  });
  it("keeps the freeform modes out of the pick (slow, worse deviation)", () => {
    for (const level of FIT_TO_CAD_LEVELS) expect(level.options.freeformMode).toBeUndefined();
  });
  it("describes each level for the quick pick", () => {
    for (const level of FIT_TO_CAD_LEVELS) {
      expect(level.label.length).toBeGreaterThan(5);
      expect(level.detail.length).toBeGreaterThan(20);
    }
  });
});
