import { describe, it, expect } from "vitest";
import { parseEditsJson, serializeEditsJson, EDITS_SIDECAR_VERSION } from "./editsSidecar";
import type { EditOp } from "./editOps";
import type { ParamVariable } from "./editVariables";

describe("parseEditsJson", () => {
  it("parses a well-formed sidecar preserving op order", () => {
    const ops: EditOp[] = [
      { op: "translate", targets: ["solid-0"], vec: [1, 2, 3] },
      { op: "boolean", kind: "subtract", a: ["solid-0"], b: ["solid-1"] },
    ];
    const text = JSON.stringify({ version: 1, source: "bull.stp", ops });
    expect(parseEditsJson(text)).toEqual({ ops, variables: [] });
  });

  it("returns empty lists for invalid JSON or missing ops array", () => {
    expect(parseEditsJson("not json")).toEqual({ ops: [], variables: [] });
    expect(parseEditsJson("{}")).toEqual({ ops: [], variables: [] });
    expect(parseEditsJson(JSON.stringify({ ops: "nope" }))).toEqual({ ops: [], variables: [] });
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
    const { ops } = parseEditsJson(text);
    expect(ops.map((o) => o.op)).toEqual(["translate", "scale", "fillet"]);
  });

  it("rejects non-finite numeric params", () => {
    const text = JSON.stringify({
      ops: [{ op: "translate", targets: ["solid-0"], vec: [1, null, 3] }],
    });
    expect(parseEditsJson(text).ops).toEqual([]);
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
    expect(parseEditsJson(serializeEditsJson("model.step", ops)).ops).toEqual(ops);
  });

  it("drops only the op with a malformed points array, keeping its neighbours", () => {
    const text = JSON.stringify({
      ops: [
        { op: "addSpline", points: [[0, 0, 0], [5, 5, 0]] },       // ok
        { op: "addSpline", points: [[0, 0, 0], [1, "x", 0]] },     // malformed point → dropped
        { op: "addBezier", controlPoints: [[0, 0, 0], [1, 1, 0]] }, // ok
      ],
    });
    expect(parseEditsJson(text).ops.map((o) => o.op)).toEqual(["addSpline", "addBezier"]);
  });
});

describe("parseEditsJson — parametric variables", () => {
  it("round-trips variables and exprs", () => {
    const variables: ParamVariable[] = [
      { name: "L", expr: "20", value: 20 },
      { name: "W", expr: "L/2", value: 10 },
    ];
    const ops: EditOp[] = [
      { op: "addBox", center: [0, 0, 0], size: [20, 10, 5], exprs: { "size[0]": "L", "size[1]": "W" } },
    ];
    const parsed = parseEditsJson(serializeEditsJson("model.step", ops, variables));
    expect(parsed.variables).toEqual(variables);
    expect(parsed.ops).toEqual(ops);
  });

  it("re-resolves stale cached numbers at parse time (hand-edited sidecar heals)", () => {
    const text = JSON.stringify({
      version: 1,
      source: "model.step",
      variables: [{ name: "L", expr: "30", value: 30 }],
      ops: [{ op: "extrude", profile: "face-1", dir: [0, 0, 1], length: 20, exprs: { "length": "L" } }],
    });
    const { ops } = parseEditsJson(text);
    expect(ops[0]).toMatchObject({ length: 30 });
  });

  it("drops malformed variable entries but keeps the rest", () => {
    const text = JSON.stringify({
      variables: [
        { name: "L", expr: "20", value: 20 },
        { name: "2bad", expr: "1", value: 1 },
        { name: "L", expr: "99", value: 99 },
      ],
      ops: [],
    });
    expect(parseEditsJson(text).variables).toEqual([{ name: "L", expr: "20", value: 20 }]);
  });
});

describe("serializeEditsJson", () => {
  it("round-trips through parse and stamps version + source", () => {
    const ops: EditOp[] = [{ op: "explode", factor: 1.5 }];
    const text = serializeEditsJson("model.step", ops);
    const obj = JSON.parse(text);
    expect(obj.version).toBe(EDITS_SIDECAR_VERSION);
    expect(obj.source).toBe("model.step");
    expect(parseEditsJson(text).ops).toEqual(ops);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("omits the variables field when empty (pre-parametric output unchanged)", () => {
    const text = serializeEditsJson("model.step", [{ op: "explode", factor: 1.5 }]);
    expect("variables" in JSON.parse(text)).toBe(false);
    expect(text).toBe(serializeEditsJson("model.step", [{ op: "explode", factor: 1.5 }], []));
  });
});
