import { describe, expect, it, vi } from "vitest";
import { PlanesModel } from "./planesModel";
import type { ConstructionPlane } from "../protocol";

const SAMPLE: ConstructionPlane = {
  id: "plane-0",
  name: "Datum",
  point: [1, 2, 3],
  normal: [0, 0, 1],
};

describe("PlanesModel — the load/onChange contract", () => {
  it("load() is SILENT — it must not echo back as a write", () => {
    // The contract every sidecar model here relies on: `load` is the sidecar
    // arriving, and firing onChange would post it straight back as a change,
    // which is a write loop.
    const onChange = vi.fn();
    const m = new PlanesModel(onChange);
    m.load([SAMPLE]);
    expect(onChange).not.toHaveBeenCalled();
    expect(m.list()).toEqual([SAMPLE]);
  });

  it("every mutation fires onChange", () => {
    const onChange = vi.fn();
    const m = new PlanesModel(onChange);
    m.add({ name: "A", point: [0, 0, 0], normal: [1, 0, 0] });
    expect(onChange).toHaveBeenCalledTimes(1);
    m.rename("plane-0", "B");
    expect(onChange).toHaveBeenCalledTimes(2);
    m.remove("plane-0");
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("a no-op mutation does NOT fire onChange", () => {
    const onChange = vi.fn();
    const m = new PlanesModel(onChange);
    m.load([SAMPLE]);
    m.rename("nope", "X");
    m.remove("nope");
    m.rename("plane-0", "   "); // blank name — a plane always has one
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("PlanesModel — cloning", () => {
  it("list() deep-clones, so a caller cannot mutate stored state", () => {
    const m = new PlanesModel(() => {});
    m.load([SAMPLE]);
    m.list()[0].point[0] = 999;
    m.list()[0].name = "hacked";
    expect(m.list()[0].point[0]).toBe(1);
    expect(m.list()[0].name).toBe("Datum");
  });

  it("load() clones its input, so the caller's array is not aliased", () => {
    const input: ConstructionPlane[] = [{ ...SAMPLE, point: [1, 2, 3] }];
    const m = new PlanesModel(() => {});
    m.load(input);
    input[0].point[0] = 999;
    expect(m.list()[0].point[0]).toBe(1);
  });

  it("carries derivedFrom through", () => {
    const m = new PlanesModel(() => {});
    m.load([{ ...SAMPLE, derivedFrom: "face-12" }]);
    expect(m.list()[0].derivedFrom).toBe("face-12");
  });
});

describe("PlanesModel — ids", () => {
  it("starts at plane-0 and increments", () => {
    const m = new PlanesModel(() => {});
    expect(m.add({ name: "A", point: [0, 0, 0], normal: [1, 0, 0] }).id).toBe("plane-0");
    expect(m.add({ name: "B", point: [0, 0, 0], normal: [1, 0, 0] }).id).toBe("plane-1");
  });

  it("never REUSES an id, so a deleted plane's id cannot come back", () => {
    const m = new PlanesModel(() => {});
    m.add({ name: "A", point: [0, 0, 0], normal: [1, 0, 0] });
    m.add({ name: "B", point: [0, 0, 0], normal: [1, 0, 0] });
    m.remove("plane-0");
    expect(m.add({ name: "C", point: [0, 0, 0], normal: [1, 0, 0] }).id).toBe("plane-2");
  });

  it("finds a plane by id, cloned", () => {
    const m = new PlanesModel(() => {});
    m.load([SAMPLE]);
    expect(m.find("plane-0")?.name).toBe("Datum");
    expect(m.find("nope")).toBeUndefined();
    m.find("plane-0")!.name = "hacked";
    expect(m.find("plane-0")!.name).toBe("Datum");
  });
});
