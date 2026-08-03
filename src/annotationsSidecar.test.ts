import { describe, it, expect } from "vitest";
import { parseAnnotationsJson, serializeAnnotationsJson, SIDECAR_VERSION } from "./annotationsSidecar";
import type { Annotation } from "./protocol";

const BASE: Annotation = {
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

describe("parseAnnotationsJson", () => {
  it("parses a well-formed sidecar", () => {
    const text = JSON.stringify({ version: 1, source: "bull.stp", annotations: [BASE] });
    expect(parseAnnotationsJson(text)).toEqual([BASE]);
  });

  it("keeps an optional label when present, drops it when absent/empty", () => {
    const withLabel = { ...BASE, label: "wall thickness" };
    const text = JSON.stringify({ annotations: [withLabel, { ...BASE, label: "" }] });
    const parsed = parseAnnotationsJson(text);
    expect(parsed[0].label).toBe("wall thickness");
    expect(parsed[1].label).toBeUndefined();
  });

  it("returns [] for invalid JSON or missing annotations array", () => {
    expect(parseAnnotationsJson("not json")).toEqual([]);
    expect(parseAnnotationsJson("{}")).toEqual([]);
    expect(parseAnnotationsJson(JSON.stringify({ annotations: "nope" }))).toEqual([]);
  });

  it("drops malformed entries and coerces missing id buckets to empty arrays", () => {
    const text = JSON.stringify({
      annotations: [
        { ...BASE, surfaces: undefined, points: undefined }, // missing buckets -> []
        { ...BASE, id: undefined }, // missing id -> dropped
        { ...BASE, tool: "not-a-tool" }, // invalid tool -> dropped
        { ...BASE, text: 5 }, // non-string text -> dropped
        { ...BASE, anchorPoint: [1, 2] }, // malformed anchor -> dropped
        { ...BASE, id: "ann-filtered", surfaces: ["a", 2, "b"] }, // non-strings filtered
      ],
    });
    const parsed = parseAnnotationsJson(text);
    expect(parsed.map((a) => a.id)).toEqual(["ann-1", "ann-filtered"]);
    expect(parsed[0].surfaces).toEqual([]);
    expect(parsed[0].points).toEqual([]);
    expect(parsed[1].surfaces).toEqual(["a", "b"]);
  });

  it("drops non-finite or malformed linePoints entries but keeps well-formed ones", () => {
    const text = JSON.stringify({
      annotations: [{ ...BASE, linePoints: [[1, 2, 3], [1, 2], [NaN, 0, 0], [4, 5, 6]] }],
    });
    expect(parseAnnotationsJson(text)[0].linePoints).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });
});

describe("serializeAnnotationsJson", () => {
  it("round-trips through parse and stamps version + source", () => {
    const text = serializeAnnotationsJson("model.step", [BASE]);
    const obj = JSON.parse(text);
    expect(obj.version).toBe(SIDECAR_VERSION);
    expect(obj.source).toBe("model.step");
    expect(parseAnnotationsJson(text)).toEqual([BASE]);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("round-trips an annotation with a label and an empty linePoints (radius/edgeLength tools)", () => {
    const a: Annotation = { ...BASE, tool: "radius", label: "rim", linePoints: [], surfaces: [], lines: ["edge-3"] };
    const text = serializeAnnotationsJson("model.step", [a]);
    expect(parseAnnotationsJson(text)).toEqual([a]);
  });
});
