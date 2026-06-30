import { describe, it, expect } from "vitest";
import { SelectionSet } from "./selection";

describe("SelectionSet", () => {
  it("toggles membership and reports the new state", () => {
    const sel = new SelectionSet();
    const e = { entityType: "surface" as const, entityId: "face-1" };
    expect(sel.toggle(e)).toBe(true);
    expect(sel.has(e)).toBe(true);
    expect(sel.size).toBe(1);
    expect(sel.toggle(e)).toBe(false);
    expect(sel.has(e)).toBe(false);
    expect(sel.size).toBe(0);
  });

  it("distinguishes entities of the same id but different type", () => {
    const sel = new SelectionSet();
    sel.add({ entityType: "surface", entityId: "1" });
    sel.add({ entityType: "line", entityId: "1" });
    expect(sel.size).toBe(2);
  });

  it("dedupes repeated adds and lists current entities", () => {
    const sel = new SelectionSet();
    sel.add({ entityType: "volume", entityId: "solid-0" });
    sel.add({ entityType: "volume", entityId: "solid-0" });
    expect(sel.size).toBe(1);
    expect(sel.list()).toEqual([{ entityType: "volume", entityId: "solid-0" }]);
  });

  it("clears all entities", () => {
    const sel = new SelectionSet();
    sel.add({ entityType: "surface", entityId: "a" });
    sel.clear();
    expect(sel.size).toBe(0);
  });
});
