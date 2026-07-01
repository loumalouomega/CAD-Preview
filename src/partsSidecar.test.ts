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
});
