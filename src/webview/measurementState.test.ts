import { describe, it, expect } from "vitest";
import { MeasurementState, type MeasurementPick } from "./measurementState";

function pick(x: number): MeasurementPick {
  return { point: [x, 0, 0], entityType: "point", entityId: `point-${x}`, direction: null, polyline: null };
}

describe("MeasurementState", () => {
  it("defaults to the distance tool, needing 2 picks", () => {
    const s = new MeasurementState();
    expect(s.getTool()).toBe("distance");
    expect(s.addPick(pick(0))).toEqual({ done: false, picks: [pick(0)] });
    expect(s.addPick(pick(1))).toEqual({ done: true, picks: [pick(0), pick(1)] });
    // buffer resets after a completed measurement
    expect(s.getPicks()).toEqual([]);
  });

  it("single-pick tools (edgeLength, radius) complete immediately", () => {
    const s = new MeasurementState();
    s.setTool("edgeLength");
    expect(s.addPick(pick(0))).toEqual({ done: true, picks: [pick(0)] });

    s.setTool("radius");
    expect(s.addPick(pick(1))).toEqual({ done: true, picks: [pick(1)] });
  });

  it("angle needs 2 picks like distance", () => {
    const s = new MeasurementState();
    s.setTool("angle");
    expect(s.addPick(pick(0)).done).toBe(false);
    expect(s.addPick(pick(1)).done).toBe(true);
  });

  it("switching tools discards an in-progress (incomplete) pick", () => {
    const s = new MeasurementState();
    s.addPick(pick(0)); // 1 of 2 for distance
    s.setTool("angle");
    expect(s.getPicks()).toEqual([]);
    expect(s.getTool()).toBe("angle");
  });

  it("clear() discards in-progress picks without changing the tool", () => {
    const s = new MeasurementState();
    s.setTool("angle");
    s.addPick(pick(0));
    s.clear();
    expect(s.getPicks()).toEqual([]);
    expect(s.getTool()).toBe("angle");
  });
});
