import { describe, expect, it } from "vitest";
import { isTextEntryTarget, viewForKey } from "./viewShortcuts";

describe("viewForKey", () => {
  it("maps 1-6 to the six faces and i to isometric", () => {
    const names = ["1", "2", "3", "4", "5", "6", "i"].map((key) => viewForKey({ key })?.canonical);
    expect(names).toEqual(["front", "back", "right", "left", "top", "bottom", "iso-ftr"]);
  });

  it("is case-insensitive for i and returns the real direction", () => {
    expect(viewForKey({ key: "I" })?.canonical).toBe("iso-ftr");
    expect(viewForKey({ key: "5" })?.direction).toEqual([0, 1, 0]);
  });

  it("ignores modified chords and unrelated keys", () => {
    expect(viewForKey({ key: "1", ctrlKey: true })).toBeNull();
    expect(viewForKey({ key: "5", metaKey: true })).toBeNull();
    expect(viewForKey({ key: "i", altKey: true })).toBeNull();
    expect(viewForKey({ key: "7" })).toBeNull();
    expect(viewForKey({ key: "Escape" })).toBeNull();
  });
});

describe("isTextEntryTarget", () => {
  it("treats text controls and contenteditable as typing", () => {
    expect(isTextEntryTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "textarea" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("lets buttons, the canvas and no target through", () => {
    expect(isTextEntryTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntryTarget({ tagName: "CANVAS" })).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});
