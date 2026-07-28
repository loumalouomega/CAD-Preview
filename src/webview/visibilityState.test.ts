import { describe, it, expect } from "vitest";
import { VisibilityState } from "./visibilityState";

describe("VisibilityState — parts hide/isolate", () => {
  it("toggles hidden state per part index independently", () => {
    const v = new VisibilityState();
    expect(v.isPartHidden(0)).toBe(false);
    v.toggleHiddenPart(0);
    expect(v.isPartHidden(0)).toBe(true);
    expect(v.isPartHidden(1)).toBe(false);
    v.toggleHiddenPart(0);
    expect(v.isPartHidden(0)).toBe(false);
  });

  it("isolate is a single index, toggled by clicking the same part again", () => {
    const v = new VisibilityState();
    expect(v.isolatedPartIndex()).toBeNull();
    v.toggleIsolatedPart(2);
    expect(v.isolatedPartIndex()).toBe(2);
    expect(v.isPartIsolated(2)).toBe(true);
    v.toggleIsolatedPart(3);
    expect(v.isolatedPartIndex()).toBe(3);
    v.toggleIsolatedPart(3);
    expect(v.isolatedPartIndex()).toBeNull();
  });

  it("hidden parts stay hidden after isolate is set and cleared (composition, not clobbering)", () => {
    const v = new VisibilityState();
    v.toggleHiddenPart(0);
    v.setIsolatedPart(1);
    expect(v.isPartHidden(0)).toBe(true);
    v.setIsolatedPart(null);
    expect(v.isPartHidden(0)).toBe(true);
  });

  it("onPartCountChanged drops stale indices (e.g. after a part delete)", () => {
    const v = new VisibilityState();
    v.toggleHiddenPart(0);
    v.toggleHiddenPart(3);
    v.setIsolatedPart(4);
    v.onPartCountChanged(2); // only indices 0,1 remain valid
    expect(v.hiddenPartIndices()).toEqual([0]);
    expect(v.isolatedPartIndex()).toBeNull();
  });
});

describe("VisibilityState — tree groups", () => {
  it("toggles hidden state per group id", () => {
    const v = new VisibilityState();
    expect(v.isTreeGroupHidden("solid-0")).toBe(false);
    v.toggleTreeGroupHidden("solid-0");
    expect(v.isTreeGroupHidden("solid-0")).toBe(true);
    v.toggleTreeGroupHidden("solid-0");
    expect(v.isTreeGroupHidden("solid-0")).toBe(false);
  });
});
