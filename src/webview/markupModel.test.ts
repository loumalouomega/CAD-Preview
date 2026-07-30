import { describe, it, expect } from "vitest";
import { MarkupModel, type MarkupStroke } from "./markupModel";

function line(x1: number, y1: number, x2: number, y2: number): MarkupStroke {
  return { tool: "line", color: "#ff0000", points: [{ x: x1, y: y1 }, { x: x2, y: y2 }] };
}

describe("MarkupModel", () => {
  it("push/list/clear", () => {
    const m = new MarkupModel();
    expect(m.list()).toEqual([]);
    m.push(line(0, 0, 10, 10));
    expect(m.list().length).toBe(1);
    m.clear();
    expect(m.list()).toEqual([]);
  });

  it("undo/redo the most recent stroke", () => {
    const m = new MarkupModel();
    m.push(line(0, 0, 1, 1));
    m.push(line(2, 2, 3, 3));
    expect(m.canUndo()).toBe(true);
    expect(m.canRedo()).toBe(false);
    m.undo();
    expect(m.list().length).toBe(1);
    expect(m.canRedo()).toBe(true);
    m.redo();
    expect(m.list().length).toBe(2);
  });

  it("a new push clears the redo stack", () => {
    const m = new MarkupModel();
    m.push(line(0, 0, 1, 1));
    m.undo();
    expect(m.canRedo()).toBe(true);
    m.push(line(5, 5, 6, 6));
    expect(m.canRedo()).toBe(false);
  });

  it("undo/redo on an empty stack is a no-op", () => {
    const m = new MarkupModel();
    m.undo();
    m.redo();
    expect(m.list()).toEqual([]);
  });

  it("eraseAt removes strokes with a point near the given position", () => {
    const m = new MarkupModel();
    m.push(line(0, 0, 10, 10));
    m.push(line(100, 100, 110, 110));
    expect(m.eraseAt({ x: 1, y: 1 })).toBe(true);
    expect(m.list().length).toBe(1);
    expect(m.list()[0].points[0]).toEqual({ x: 100, y: 100 });
  });

  it("eraseAt is a no-op (returns false) when nothing is near the position", () => {
    const m = new MarkupModel();
    m.push(line(0, 0, 10, 10));
    expect(m.eraseAt({ x: 500, y: 500 })).toBe(false);
    expect(m.list().length).toBe(1);
  });

  it("erasing is not undoable — it does not touch the redo stack", () => {
    const m = new MarkupModel();
    m.push(line(0, 0, 10, 10));
    m.eraseAt({ x: 0, y: 0 });
    expect(m.list()).toEqual([]);
    m.redo(); // nothing to redo — erase bypasses the undo/redo stack entirely
    expect(m.list()).toEqual([]);
  });
});
