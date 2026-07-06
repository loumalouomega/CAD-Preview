import { describe, it, expect } from "vitest";
import { parseEditsJson, serializeEditsJson, EDITS_SIDECAR_VERSION } from "./editsSidecar";
import type { EditOp } from "./editOps";

describe("parseEditsJson", () => {
  it("parses a well-formed sidecar preserving op order", () => {
    const ops: EditOp[] = [
      { op: "translate", targets: ["solid-0"], vec: [1, 2, 3] },
      { op: "boolean", kind: "subtract", a: ["solid-0"], b: ["solid-1"] },
    ];
    const text = JSON.stringify({ version: 1, source: "bull.stp", ops });
    expect(parseEditsJson(text)).toEqual(ops);
  });

  it("returns [] for invalid JSON or missing ops array", () => {
    expect(parseEditsJson("not json")).toEqual([]);
    expect(parseEditsJson("{}")).toEqual([]);
    expect(parseEditsJson(JSON.stringify({ ops: "nope" }))).toEqual([]);
  });

  it("drops malformed ops but keeps the valid ones in order", () => {
    const text = JSON.stringify({
      ops: [
        { op: "translate", targets: ["solid-0"], vec: [1, 0, 0] }, // ok
        { op: "translate", targets: [], vec: [1, 0, 0] },          // no targets → dropped
        { op: "rotate", targets: ["solid-0"], axisPoint: [0, 0, 0], axisDir: [0, 0, 1] }, // missing angle → dropped
        { op: "scale", targets: ["solid-1"], center: [0, 0, 0], factors: [2, 2, 2] }, // ok
        { op: "bogus" },                                            // unknown → dropped
        { op: "fillet", edges: ["edge-3"], radius: 0.5 },           // ok
      ],
    });
    const ops = parseEditsJson(text);
    expect(ops.map((o) => o.op)).toEqual(["translate", "scale", "fillet"]);
  });

  it("rejects non-finite numeric params", () => {
    const text = JSON.stringify({
      ops: [{ op: "translate", targets: ["solid-0"], vec: [1, null, 3] }],
    });
    expect(parseEditsJson(text)).toEqual([]);
  });
});

describe("parseEditsJson — new op families round-trip", () => {
  it("round-trips one op per family added with the GEOMETRY/EDIT redesign", () => {
    const ops: EditOp[] = [
      { op: "addSlotProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], length: 12, width: 4 },
      { op: "addWedge", center: [0, 0, 0], axis: [0, 0, 1], up: [1, 0, 0], dx: 10, dy: 6, dz: 4, ltx: 3 },
      { op: "addCounterboreHole", targets: ["solid-0"], position: [0, 0, 10], axis: [0, 0, -1], radius: 2, depth: 5, cbRadius: 4, cbDepth: 2 },
      { op: "addPolyline", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], closed: true },
      { op: "addHelix", center: [0, 0, 0], axis: [0, 0, 1], radius: 5, pitch: 3, turns: 2 },
      { op: "shell", thickness: -1, openingFaces: ["face-5"] },
      { op: "splitByPlane", targets: ["solid-0"], planePoint: [5, 5, 4], planeNormal: [0, 0, 1], keep: "both" },
      { op: "section", targets: ["solid-0"], planePoint: [5, 5, 5], planeNormal: [0, 0, 1] },
    ];
    expect(parseEditsJson(serializeEditsJson("model.step", ops))).toEqual(ops);
  });

  it("drops only the op with a malformed points array, keeping its neighbours", () => {
    const text = JSON.stringify({
      ops: [
        { op: "addSpline", points: [[0, 0, 0], [5, 5, 0]] },       // ok
        { op: "addSpline", points: [[0, 0, 0], [1, "x", 0]] },     // malformed point → dropped
        { op: "addBezier", controlPoints: [[0, 0, 0], [1, 1, 0]] }, // ok
      ],
    });
    expect(parseEditsJson(text).map((o) => o.op)).toEqual(["addSpline", "addBezier"]);
  });
});

describe("serializeEditsJson", () => {
  it("round-trips through parse and stamps version + source", () => {
    const ops: EditOp[] = [{ op: "explode", factor: 1.5 }];
    const text = serializeEditsJson("model.step", ops);
    const obj = JSON.parse(text);
    expect(obj.version).toBe(EDITS_SIDECAR_VERSION);
    expect(obj.source).toBe("model.step");
    expect(parseEditsJson(text)).toEqual(ops);
    expect(text.endsWith("\n")).toBe(true);
  });
});
