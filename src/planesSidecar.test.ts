import { describe, expect, it } from "vitest";
import {
  parsePlanesJson,
  serializePlanesJson,
  nextPlaneId,
  PLANES_SIDECAR_VERSION,
} from "./planesSidecar";
import type { ConstructionPlane } from "./protocol";

const plane = (over: Partial<ConstructionPlane> = {}): ConstructionPlane => ({
  id: "plane-0",
  name: "Datum",
  point: [1, 2, 3],
  normal: [0, 0, 1],
  ...over,
});

describe("parsePlanesJson — round trip", () => {
  it("recovers a well-formed file exactly", () => {
    const p = plane({ derivedFrom: "face-12" });
    expect(parsePlanesJson(serializePlanesJson("m.stp", [p]))).toEqual([p]);
  });

  it("returns [] for missing, empty, or non-JSON input rather than throwing", () => {
    expect(parsePlanesJson("")).toEqual([]);
    expect(parsePlanesJson("not json")).toEqual([]);
    expect(parsePlanesJson("null")).toEqual([]);
    expect(parsePlanesJson(JSON.stringify({ version: 1, source: "m.stp" }))).toEqual([]);
  });
});

describe("parsePlanesJson — tolerance", () => {
  const withPlanes = (planes: unknown[]) => JSON.stringify({ version: 1, source: "m.stp", planes });

  it("drops a malformed entry while its siblings survive", () => {
    const r = parsePlanesJson(
      withPlanes([plane({ id: "plane-0" }), { id: "" }, null, 42, plane({ id: "plane-1" })])
    );
    expect(r.map((p) => p.id)).toEqual(["plane-0", "plane-1"]);
  });

  it("drops a plane whose normal is zero-length — it describes no plane at all", () => {
    // The failure mode to avoid is storing it as-is and later dividing by zero
    // when it is turned into a clip plane.
    const r = parsePlanesJson(withPlanes([plane({ normal: [0, 0, 0] }), plane({ id: "plane-9" })]));
    expect(r.map((p) => p.id)).toEqual(["plane-9"]);
  });

  it("drops a plane with a non-finite or wrong-shaped vector", () => {
    expect(parsePlanesJson(withPlanes([plane({ point: [1, 2] as never })]))).toEqual([]);
    expect(parsePlanesJson(withPlanes([plane({ normal: [0, 0, NaN] })]))).toEqual([]);
    expect(parsePlanesJson(withPlanes([plane({ point: ["a", 2, 3] as never })]))).toEqual([]);
  });

  it("NORMALIZES the stored normal, so a hand-edited sidecar stays usable", () => {
    const r = parsePlanesJson(withPlanes([plane({ normal: [0, 0, 10] })]));
    expect(r[0].normal[2]).toBeCloseTo(1, 12);
    expect(Math.hypot(...r[0].normal)).toBeCloseTo(1, 12);
  });

  it("falls back to the id when the name is missing or empty", () => {
    const r = parsePlanesJson(withPlanes([{ id: "plane-3", point: [0, 0, 0], normal: [1, 0, 0] }]));
    expect(r[0].name).toBe("plane-3");
  });

  it("drops a non-string derivedFrom rather than the whole plane", () => {
    const r = parsePlanesJson(withPlanes([plane({ derivedFrom: 7 as never })]));
    expect(r).toHaveLength(1);
    expect(r[0].derivedFrom).toBeUndefined();
  });
});

describe("serializePlanesJson", () => {
  it("records the version and source, and ends in a newline", () => {
    const text = serializePlanesJson("bull.stp", [plane()]);
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(PLANES_SIDECAR_VERSION);
    expect(parsed.source).toBe("bull.stp");
  });
});

describe("nextPlaneId", () => {
  it("starts at plane-0", () => {
    expect(nextPlaneId([])).toBe("plane-0");
  });

  it("never REUSES an id, so a deleted plane's id cannot be resurrected", () => {
    // plane-1 was deleted; the next must be plane-2, not plane-1 — any
    // derivedFrom string or future op reference would otherwise retarget.
    expect(nextPlaneId([plane({ id: "plane-0" }), plane({ id: "plane-2" })])).toBe("plane-3");
  });

  it("ignores ids that do not match the scheme", () => {
    expect(nextPlaneId([plane({ id: "custom" }), plane({ id: "plane-4" })])).toBe("plane-5");
  });
});
