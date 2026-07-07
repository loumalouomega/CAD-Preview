import { describe, it, expect, vi } from "vitest";
import { EditsModel } from "./editsModel";
import type { EditOp } from "../editOps";

const T = (x: number): EditOp => ({ op: "translate", targets: ["solid-0"], vec: [x, 0, 0] });

describe("EditsModel", () => {
  it("push appends in order and fires onChange", () => {
    const onChange = vi.fn();
    const m = new EditsModel(onChange);
    m.push(T(1));
    m.push(T(2));
    expect(m.list().map((o) => (o as { vec: number[] }).vec[0])).toEqual([1, 2]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("undo/redo move ops across the redo buffer", () => {
    const m = new EditsModel(() => {});
    m.push(T(1));
    m.push(T(2));
    expect(m.canUndo).toBe(true);
    expect(m.canRedo).toBe(false);

    m.undo();
    expect(m.size).toBe(1);
    expect(m.canRedo).toBe(true);

    m.redo();
    expect(m.size).toBe(2);
    expect(m.canRedo).toBe(false);
  });

  it("push clears the redo buffer (new branch)", () => {
    const m = new EditsModel(() => {});
    m.push(T(1));
    m.undo();
    expect(m.canRedo).toBe(true);
    m.push(T(9));
    expect(m.canRedo).toBe(false);
    expect(m.list()).toEqual([T(9)]);
  });

  it("clear empties both stacks and load does not fire onChange", () => {
    const onChange = vi.fn();
    const m = new EditsModel(onChange);
    m.load([T(1), T(2)]);
    expect(onChange).not.toHaveBeenCalled();
    expect(m.size).toBe(2);

    m.clear();
    expect(m.size).toBe(0);
    expect(m.canUndo).toBe(false);
    expect(m.canRedo).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("no-op mutations on an empty model do not fire onChange", () => {
    const onChange = vi.fn();
    const m = new EditsModel(onChange);
    m.undo();
    m.redo();
    m.clear();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("list returns deep copies (no aliasing)", () => {
    const m = new EditsModel(() => {});
    m.push(T(1));
    const a = m.list()[0] as { vec: number[] };
    a.vec[0] = 999;
    expect((m.list()[0] as { vec: number[] }).vec[0]).toBe(1);
  });

  it("remove splices out a single op from anywhere in the list", () => {
    const onChange = vi.fn();
    const m = new EditsModel(onChange);
    m.push(T(1));
    m.push(T(2));
    m.push(T(3));
    m.remove(1); // the middle one
    expect(m.list().map((o) => (o as { vec: number[] }).vec[0])).toEqual([1, 3]);
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it("remove clears the redo buffer", () => {
    const m = new EditsModel(() => {});
    m.push(T(1));
    m.push(T(2));
    m.undo();
    expect(m.canRedo).toBe(true);
    m.remove(0);
    expect(m.canRedo).toBe(false);
    expect(m.list()).toEqual([]);
  });

  it("remove is a no-op for an out-of-range index", () => {
    const onChange = vi.fn();
    const m = new EditsModel(onChange);
    m.push(T(1));
    onChange.mockClear();
    m.remove(-1);
    m.remove(5);
    expect(onChange).not.toHaveBeenCalled();
    expect(m.list()).toEqual([T(1)]);
  });
});
