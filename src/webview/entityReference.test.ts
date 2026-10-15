import { describe, expect, it } from "vitest";
import { formatEntityReference, formatEntityReferences, producingBucketFor } from "./entityReference";
import type { EntityFacts } from "../entityFacts";
import type { OpBucket } from "../opBuckets";

const planar = {
  entityId: "face-12",
  kind: "face",
  bbox: { min: [0, 0, 0], max: [1, 1, 0], diagonal: 1.4 },
  center: [0, 0, 0],
  area: 8119.27,
  length: null,
  normal: [0, 0, 1],
  planeOrigin: [0, 0, 0],
  surfaceType: "plane",
  surfaceParams: null,
  curveType: null,
} as unknown as EntityFacts;

describe("formatEntityReference", () => {
  it("names the file, the id and the op list the id is valid against", () => {
    expect(formatEntityReference({ path: "examples/STP/bull.stp", entityId: "face-12", opCount: 3 })).toBe(
      "examples/STP/bull.stp#face-12 (valid for 3 ops)"
    );
  });
  it("uses the singular for one op and says zero plainly", () => {
    expect(formatEntityReference({ path: "a.stp", entityId: "edge-0", opCount: 1 })).toContain("(valid for 1 op)");
    expect(formatEntityReference({ path: "a.stp", entityId: "edge-0", opCount: 0 })).toContain("(valid for 0 ops)");
  });
  it("appends the inspector's facts only when they describe this entity", () => {
    const withFacts = formatEntityReference({ path: "a.stp", entityId: "face-12", opCount: 2, facts: planar });
    expect(withFacts).toBe("a.stp#face-12 — planar, 8,119.27 mm² (valid for 2 ops)");
    // facts for a different entity must never be attributed to this one
    expect(formatEntityReference({ path: "a.stp", entityId: "face-3", opCount: 2, facts: planar })).toBe("a.stp#face-3 (valid for 2 ops)");
  });
});

describe("formatEntityReferences", () => {
  it("emits one line per entity, de-duplicated, in order", () => {
    const text = formatEntityReferences([
      { path: "a.stp", entityId: "face-2", opCount: 1 },
      { path: "a.stp", entityId: "face-1", opCount: 1 },
      { path: "a.stp", entityId: "face-2", opCount: 1 },
    ]);
    expect(text.split("\n")).toEqual(["a.stp#face-2 (valid for 1 op)", "a.stp#face-1 (valid for 1 op)"]);
  });
});

describe("stored query in a reference", () => {
  it("appends the query as compact JSON after the op count", () => {
    const query = { kind: "role", role: "endCap" } as never;
    expect(formatEntityReference({ path: "a.stp", entityId: "face-3", opCount: 2, query })).toBe(
      'a.stp#face-3 (valid for 2 ops) — query {"kind":"role","role":"endCap"}'
    );
  });
  it("omits it when there is none", () => {
    expect(formatEntityReference({ path: "a.stp", entityId: "face-3", opCount: 2, query: null })).toBe("a.stp#face-3 (valid for 2 ops)");
  });
});

describe("producingBucketFor", () => {
  const buckets: OpBucket[] = [
    { op: 0, kind: "addBox", roles: { body: ["face-0", "face-1"] } },
    { op: 2, kind: "extrude", roles: { endCap: ["face-7"], side: ["face-8", "face-9"] } },
  ];
  it("finds the role in the last bucket", () => {
    expect(producingBucketFor(buckets, "face-8")).toEqual({ op: 2, role: "side" });
  });
  it("refuses ids only in an earlier bucket (a later op may have renumbered them)", () => {
    expect(producingBucketFor(buckets, "face-1")).toBeNull();
  });
  it("refuses non-faces, empty and missing buckets", () => {
    expect(producingBucketFor(buckets, "edge-8")).toBeNull();
    expect(producingBucketFor([], "face-8")).toBeNull();
    expect(producingBucketFor(null, "face-8")).toBeNull();
  });
});
