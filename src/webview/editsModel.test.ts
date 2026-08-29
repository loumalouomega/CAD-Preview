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

  it("redoList returns the buffer in chronological order (deep copies)", () => {
    const m = new EditsModel(() => {});
    m.push(T(1));
    m.push(T(2));
    m.push(T(3));
    m.undo(); // pops 3 → redo [T3]
    m.undo(); // pops 2 → redo [T3, T2]
    expect(m.redoList().map((o) => (o as { vec: number[] }).vec[0])).toEqual([2, 3]);
    const a = m.redoList()[0] as { vec: number[] };
    a.vec[0] = 999;
    expect((m.redoList()[0] as { vec: number[] }).vec[0]).toBe(2);
  });

  it("jumpTo backward keeps the prefix and demotes the rest in redo order", () => {
    const onChange = vi.fn();
    const m = new EditsModel(onChange);
    m.push(T(1));
    m.push(T(2));
    m.push(T(3));
    onChange.mockClear();
    m.jumpTo(0); // timeline position 0 → only op 1 applied
    expect(m.list().map((o) => (o as { vec: number[] }).vec[0])).toEqual([1]);
    // Chronologically-first demoted op (T2) must be the next one redo() applies.
    expect(m.redoList().map((o) => (o as { vec: number[] }).vec[0])).toEqual([2, 3]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("jumpTo forward re-applies through the pending row in one splice", () => {
    const onChange = vi.fn();
    const m = new EditsModel(onChange);
    m.push(T(1));
    m.push(T(2));
    m.push(T(3));
    m.undo();
    m.undo(); // ops=[T1], redo=[T3,T2]
    onChange.mockClear();
    m.jumpTo(2); // timeline: T1 applied, T2 pos 1, T3 pos 2 → apply through T3
    expect(m.list().map((o) => (o as { vec: number[] }).vec[0])).toEqual([1, 2, 3]);
    expect(m.canRedo).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("jumpTo forward partially leaves the rest of the buffer intact and in order", () => {
    const m = new EditsModel(() => {});
    m.push(T(1));
    m.push(T(2));
    m.push(T(3));
    m.undo();
    m.undo(); // ops=[T1], redo=[T3,T2]
    m.jumpTo(1); // apply through T2 only
    expect(m.list().map((o) => (o as { vec: number[] }).vec[0])).toEqual([1, 2]);
    expect(m.redoList().map((o) => (o as { vec: number[] }).vec[0])).toEqual([3]);
  });

  it("jumpTo to the last applied row is a no-op (no onChange)", () => {
    const onChange = vi.fn();
    const m = new EditsModel(onChange);
    m.push(T(1));
    m.push(T(2));
    onChange.mockClear();
    m.jumpTo(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(m.list()).toEqual([T(1), T(2)]);
  });

  it("jumpTo is a no-op for out-of-range indices", () => {
    const onChange = vi.fn();
    const m = new EditsModel(onChange);
    m.push(T(1));
    m.undo(); // one pending
    onChange.mockClear();
    m.jumpTo(-1);
    m.jumpTo(5);
    expect(onChange).not.toHaveBeenCalled();
    expect(m.size).toBe(0);
    expect(m.canRedo).toBe(true);
  });

  it("jump back then jump forward restores the identical list", () => {
    const m = new EditsModel(() => {});
    m.push(T(1));
    m.push(T(2));
    m.push(T(3));
    m.jumpTo(0);
    m.jumpTo(2);
    expect(m.list().map((o) => (o as { vec: number[] }).vec[0])).toEqual([1, 2, 3]);
    expect(m.canRedo).toBe(false);
  });

  it("undo/redo keep working correctly after a jump", () => {
    const m = new EditsModel(() => {});
    m.push(T(1));
    m.push(T(2));
    m.push(T(3));
    m.jumpTo(0); // demote [T2,T3] in order
    m.redo();
    expect(m.list().map((o) => (o as { vec: number[] }).vec[0])).toEqual([1, 2]);
    m.undo();
    expect(m.list().map((o) => (o as { vec: number[] }).vec[0])).toEqual([1]);
    m.jumpTo(2); // apply both again via one jump
    expect(m.list().map((o) => (o as { vec: number[] }).vec[0])).toEqual([1, 2, 3]);
  });

  it("push after a jump still clears the redo buffer (new branch)", () => {
    const m = new EditsModel(() => {});
    m.push(T(1));
    m.push(T(2));
    m.jumpTo(0);
    expect(m.canRedo).toBe(true);
    m.push(T(9));
    expect(m.canRedo).toBe(false);
    expect(m.list().map((o) => (o as { vec: number[] }).vec[0])).toEqual([1, 9]);
  });
});
