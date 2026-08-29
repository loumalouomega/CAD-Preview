import { describe, it, expect, vi } from "vitest";
import { AnnotationsModel } from "./annotationsModel";
import type { Annotation } from "../protocol";

const SAMPLE: Annotation = {
  id: "ann-1",
  tool: "distance",
  text: "12.5 mm",
  anchorPoint: [1, 2, 3],
  linePoints: [
    [0, 0, 0],
    [1, 2, 3],
  ],
  volumes: [],
  surfaces: ["face-1"],
  lines: [],
  points: ["point-2"],
};

describe("AnnotationsModel", () => {
  it("push() appends and fires onChange", () => {
    const onChange = vi.fn();
    const m = new AnnotationsModel(onChange);
    m.push(SAMPLE);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(m.list()).toEqual([SAMPLE]);
    expect(m.size).toBe(1);
  });

  it("load() replaces data silently (no onChange echo)", () => {
    const onChange = vi.fn();
    const m = new AnnotationsModel(onChange);
    m.load([SAMPLE]);
    expect(onChange).not.toHaveBeenCalled();
    expect(m.list()).toEqual([SAMPLE]);
  });

  it("list()/load() return/accept deep copies, not live references", () => {
    const m = new AnnotationsModel(() => {});
    m.load([SAMPLE]);
    const got = m.list()[0];
    got.surfaces.push("face-99");
    got.linePoints[0][0] = 999;
    expect(m.list()[0].surfaces).toEqual(["face-1"]);
    expect(m.list()[0].linePoints[0]).toEqual([0, 0, 0]);
  });

  it("rename() sets/clears the label and fires onChange; no-ops for an unknown id", () => {
    const onChange = vi.fn();
    const m = new AnnotationsModel(onChange);
    m.push(SAMPLE);
    m.rename("ann-1", "  wall thickness  ");
    expect(m.list()[0].label).toBe("wall thickness");
    m.rename("ann-1", "   ");
    expect(m.list()[0].label).toBeUndefined();
    onChange.mockClear();
    m.rename("does-not-exist", "x");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("remove() drops by id and fires onChange; no-ops for an unknown id", () => {
    const onChange = vi.fn();
    const m = new AnnotationsModel(onChange);
    m.push(SAMPLE);
    m.push({ ...SAMPLE, id: "ann-2" });
    onChange.mockClear();
    m.remove("ann-1");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(m.list().map((a) => a.id)).toEqual(["ann-2"]);
    onChange.mockClear();
    m.remove("does-not-exist");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("CARRIES the tolerance band through push, list and load", () => {
    // Regression: `clone` used to omit `tolerance`, which runs on BOTH push
    // and list — so a pinned band was dropped before it could be persisted,
    // and the render path's `a.tolerance` was always undefined. The whole
    // tolerance feature was silently inert.
    const band = { nominal: 10, plus: 0.05, minus: 0.05, measured: 10.02 };
    const m = new AnnotationsModel(() => {});
    m.push({ ...SAMPLE, tolerance: band });
    expect(m.list()[0].tolerance).toEqual(band);

    const loaded = new AnnotationsModel(() => {});
    loaded.load([{ ...SAMPLE, tolerance: band }]);
    expect(loaded.list()[0].tolerance).toEqual(band);
  });

  it("deep-clones the band, so a caller cannot mutate stored state", () => {
    const band = { nominal: 10, plus: 0.05, minus: 0.05, measured: 10.02 };
    const m = new AnnotationsModel(() => {});
    m.push({ ...SAMPLE, tolerance: band });
    m.list()[0].tolerance!.nominal = 999;
    expect(m.list()[0].tolerance!.nominal).toBe(10);
  });

  it("leaves an untoleranced annotation without a band", () => {
    const m = new AnnotationsModel(() => {});
    m.push({ ...SAMPLE });
    expect(m.list()[0].tolerance).toBeUndefined();
  });

  it("entitiesOf() flattens the four id buckets into a selection list", () => {
    const a: Annotation = { ...SAMPLE, volumes: ["solid-0"], surfaces: ["face-1"], lines: ["edge-2"], points: ["point-3"] };
    expect(AnnotationsModel.entitiesOf(a)).toEqual([
      { entityType: "volume", entityId: "solid-0" },
      { entityType: "surface", entityId: "face-1" },
      { entityType: "line", entityId: "edge-2" },
      { entityType: "point", entityId: "point-3" },
    ]);
  });
});
