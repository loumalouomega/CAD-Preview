import { describe, it, expect } from "vitest";
import { parsePartsJson, serializePartsJson, SIDECAR_VERSION } from "./partsSidecar";
import type { Part } from "./protocol";

describe("parsePartsJson", () => {
  it("parses a well-formed sidecar", () => {
    const text = JSON.stringify({
      version: 1,
      source: "bull.stp",
      parts: [{
        name: "Inlet", color: "#ff0000", volumes: ["solid-0"], surfaces: ["face-1"], lines: [], points: ["point-2"],
      }],
    });
    const parts = parsePartsJson(text);
    expect(parts).toEqual([
      { name: "Inlet", color: "#ff0000", volumes: ["solid-0"], surfaces: ["face-1"], lines: [], points: ["point-2"] },
    ]);
  });

  it("coerces a missing points bucket to [] (back-compat with sidecars written before points existed)", () => {
    const text = JSON.stringify({
      parts: [{ name: "Old", color: "#fff", volumes: ["solid-0"], surfaces: [], lines: [] }], // no `points` key at all
    });
    const parts = parsePartsJson(text);
    expect(parts).toEqual([
      { name: "Old", color: "#fff", volumes: ["solid-0"], surfaces: [], lines: [], points: [] },
    ]);
  });

  it("returns [] for invalid JSON or missing parts array", () => {
    expect(parsePartsJson("not json")).toEqual([]);
    expect(parsePartsJson("{}")).toEqual([]);
    expect(parsePartsJson(JSON.stringify({ parts: "nope" }))).toEqual([]);
  });

  it("drops malformed parts and coerces missing buckets to empty arrays", () => {
    const text = JSON.stringify({
      parts: [
        { name: "ok", color: "#fff" }, // missing buckets
        { color: "#000" },             // missing name → dropped
        { name: "bad", color: 5 },     // non-string color → dropped
        { name: "filtered", color: "#abc", surfaces: ["a", 2, "b"] }, // non-strings filtered
      ],
    });
    const parts = parsePartsJson(text);
    expect(parts.map((p) => p.name)).toEqual(["ok", "filtered"]);
    expect(parts[0]).toEqual({ name: "ok", color: "#fff", volumes: [], surfaces: [], lines: [], points: [] });
    expect(parts[1].surfaces).toEqual(["a", "b"]);
  });

  it("parses a valid stored selector query with its op-kind tag", () => {
    const selector = { version: 1, source: { kind: "bucket", op: 0, role: "body" } };
    const text = JSON.stringify({
      parts: [{ name: "P", color: "#fff", volumes: [], surfaces: ["face-0"], lines: [], points: [], selector, selectorOpKind: "addBox" }],
    });
    expect(parsePartsJson(text)[0]).toEqual({
      name: "P", color: "#fff", volumes: [], surfaces: ["face-0"], lines: [], points: [],
      selector, selectorOpKind: "addBox",
    });
  });

  it("drops a malformed selector (or a dangling op-kind tag) while keeping the part on its raw ids", () => {
    const cases = [
      { selector: { version: 1, source: { kind: "bucket", op: 0, role: "nope" } }, selectorOpKind: "addBox" },
      { selector: { version: 1, source: { kind: "bucket", op: 0, role: "body" } }, selectorOpKind: "" },
      { selector: { version: 1, source: { kind: "bucket", op: 0, role: "body" } } }, // kind tag missing
      { selectorOpKind: "addBox" }, // query missing
    ];
    for (const extra of cases) {
      const text = JSON.stringify({ parts: [{ name: "P", color: "#fff", volumes: [], surfaces: ["face-0"], lines: [], points: [], ...extra }] });
      const parsed = parsePartsJson(text)[0];
      expect(parsed.surfaces).toEqual(["face-0"]);
      expect(parsed.selector).toBeUndefined();
      expect(parsed.selectorOpKind).toBeUndefined();
    }
  });

  it("parses a valid positive meshSize and coerces invalid values to undefined", () => {
    const base = { name: "P", color: "#fff", volumes: [], surfaces: [], lines: [], points: [] };
    const cases: Array<[unknown, number | undefined]> = [
      [10, 10],
      [0.5, 0.5],
      [0, undefined],
      [-5, undefined],
      [NaN, undefined],
      ["10", undefined],
      [undefined, undefined],
    ];
    for (const [raw, expected] of cases) {
      const text = JSON.stringify({ parts: [{ ...base, meshSize: raw }] });
      expect(parsePartsJson(text)[0].meshSize).toBe(expected);
    }
  });
});

describe("serializePartsJson", () => {
  it("round-trips through parse and stamps version + source", () => {
    const parts: Part[] = [{
      name: "P", color: "#123456", volumes: [], surfaces: ["face-0"], lines: [], points: ["point-1"],
    }];
    const text = serializePartsJson("model.step", parts);
    const obj = JSON.parse(text);
    expect(obj.version).toBe(SIDECAR_VERSION);
    expect(obj.source).toBe("model.step");
    expect(parsePartsJson(text)).toEqual(parts);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("round-trips a part's meshSize", () => {
    const parts: Part[] = [{
      name: "P", color: "#123456", volumes: ["solid-0"], surfaces: [], lines: [], points: [], meshSize: 0.25,
    }];
    const text = serializePartsJson("model.step", parts);
    expect(parsePartsJson(text)).toEqual(parts);
  });

  it("round-trips a part's stored selector query", () => {
    const parts: Part[] = [{
      name: "P", color: "#123456", volumes: [], surfaces: ["face-0"], lines: [], points: [],
      selector: { version: 1, source: { kind: "bucket", op: 0, role: "body" } }, selectorOpKind: "addBox",
    }];
    const text = serializePartsJson("model.step", parts);
    expect(parsePartsJson(text)).toEqual(parts);
  });
});
