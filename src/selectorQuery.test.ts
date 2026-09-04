import { describe, expect, it } from "vitest";
import {
  bucketReferenceIds,
  isBindableSelector,
  validateSelectorQuery,
} from "./selectorQuery";
import { ROLE_LABELS, type OpBucket } from "./opBuckets";
import type { EditOp } from "./editOps";

const box = (center: [number, number, number] = [0, 0, 0]): EditOp =>
  ({ op: "addBox", center, size: [10, 10, 10] }) as EditOp;
const pattern = (): EditOp =>
  ({ op: "patternLinear", targets: ["solid-0"], direction: [1, 0, 0], spacing: 10, count: 3 }) as EditOp;

describe("selectorQuery: validateSelectorQuery", () => {
  it("accepts a well-formed bucket query and round-trips through JSON", () => {
    const q = validateSelectorQuery({ version: 1, source: { kind: "bucket", op: 2, role: "endCap" } });
    expect(q).toEqual({ version: 1, source: { kind: "bucket", op: 2, role: "endCap" } });
    expect(JSON.parse(JSON.stringify(q))).toEqual(q);
  });

  it("accepts every known role label", () => {
    for (const role of Object.keys(ROLE_LABELS)) {
      expect(validateSelectorQuery({ version: 1, source: { kind: "bucket", op: 0, role } })).not.toBeNull();
    }
  });

  it("accepts the rung-2 induced layer and round-trips it", () => {
    const q = validateSelectorQuery({
      version: 1,
      source: { kind: "bucket", op: 3, role: "endCap", filter: { kind: "planar" }, rank: { by: "area", order: "max", n: 1 } },
    });
    expect(q).toEqual({
      version: 1,
      source: { kind: "bucket", op: 3, role: "endCap", filter: { kind: "planar" }, rank: { by: "area", order: "max", n: 1 } },
    });
    expect(JSON.parse(JSON.stringify(q))).toEqual(q);
  });

  it("a malformed induced layer fails the whole query (never a half-understood predicate)", () => {
    expect(
      validateSelectorQuery({ version: 1, source: { kind: "bucket", op: 0, role: "body", filter: { kind: "alongX" } } })
    ).toBeNull();
    expect(
      validateSelectorQuery({ version: 1, source: { kind: "bucket", op: 0, role: "body", rank: { by: "area", order: "max", n: 0 } } })
    ).toBeNull();
    expect(
      validateSelectorQuery({ version: 1, source: { kind: "bucket", op: 0, role: "body", filter: { kind: "normal", dir: [0, 0, 0] } } })
    ).toBeNull();
  });

  it("accepts the rung-3 scene source and round-trips it", () => {
    const q = validateSelectorQuery({
      version: 1,
      source: { kind: "scene", filter: [{ kind: "planar" }, { kind: "areaGte", value: 10 }], rank: { by: "area", order: "max", n: 1 } },
    });
    expect(q).toEqual({
      version: 1,
      source: { kind: "scene", filter: [{ kind: "planar" }, { kind: "areaGte", value: 10 }], rank: { by: "area", order: "max", n: 1 } },
    });
    expect(JSON.parse(JSON.stringify(q))).toEqual(q);
  });

  it("rejects a bare scene query (names the entire model, never meant)", () => {
    expect(validateSelectorQuery({ version: 1, source: { kind: "scene" } })).toBeNull();
    expect(validateSelectorQuery({ version: 1, source: { kind: "scene", filter: [] } })).toBeNull();
    expect(validateSelectorQuery({ version: 1, source: { kind: "scene", filter: [{ kind: "planar" }, { kind: "alongX" }] } })).toBeNull();
    expect(
      validateSelectorQuery({
        version: 1,
        source: { kind: "scene", rank: { by: "area", order: "max", n: 1 }, filter: [{ kind: "planar" }, { kind: "planar" }, { kind: "planar" }, { kind: "planar" }, { kind: "planar" }, { kind: "planar" }, { kind: "planar" }, { kind: "planar" }, { kind: "planar" }] },
      })
    ).toBeNull();
  });

  it("a scene query is always bindable (no producing op to be ambiguous across)", () => {
    expect(isBindableSelector([], { version: 1, source: { kind: "scene", rank: { by: "area", order: "max", n: 1 } } })).toBe(true);
  });

  it("bucketReferenceIds ignores scene queries (no anchor, no reference set)", () => {
    expect(
      bucketReferenceIds([{ op: 0, kind: "addBox", roles: { body: ["face-0"] } }], {
        version: 1,
        source: { kind: "scene", filter: { kind: "planar" } },
      })
    ).toEqual([]);
  });

  it("rejects malformed input without throwing", () => {
    expect(validateSelectorQuery(null)).toBeNull();
    expect(validateSelectorQuery([])).toBeNull();
    expect(validateSelectorQuery({})).toBeNull();
    expect(validateSelectorQuery({ version: 2, source: { kind: "bucket", op: 0, role: "body" } })).toBeNull();
    expect(validateSelectorQuery({ version: 1, source: { kind: "predicate", op: 0, role: "body" } })).toBeNull();
    expect(validateSelectorQuery({ version: 1, source: { kind: "bucket", op: -1, role: "body" } })).toBeNull();
    expect(validateSelectorQuery({ version: 1, source: { kind: "bucket", op: 1.5, role: "body" } })).toBeNull();
    expect(validateSelectorQuery({ version: 1, source: { kind: "bucket", op: 10001, role: "body" } })).toBeNull();
    expect(validateSelectorQuery({ version: 1, source: { kind: "bucket", op: 0, role: "nope" } })).toBeNull();
    expect(validateSelectorQuery({ version: 1, source: { kind: "bucket", op: 0 } })).toBeNull();
  });
});

describe("selectorQuery: isBindableSelector", () => {
  it("binds an ordinary producing op", () => {
    expect(isBindableSelector([box()], { version: 1, source: { kind: "bucket", op: 0, role: "body" } })).toBe(true);
  });

  it("refuses pattern-instance producers (ambiguous across instances)", () => {
    expect(isBindableSelector([box(), pattern()], { version: 1, source: { kind: "bucket", op: 1, role: "copies" } })).toBe(
      false
    );
  });

  it("refuses out-of-range op indices", () => {
    expect(isBindableSelector([box()], { version: 1, source: { kind: "bucket", op: 1, role: "body" } })).toBe(false);
    expect(isBindableSelector([], { version: 1, source: { kind: "bucket", op: 0, role: "body" } })).toBe(false);
  });
});

describe("selectorQuery: bucketReferenceIds", () => {
  const buckets: OpBucket[] = [
    { op: 0, kind: "addBox", roles: { body: ["face-0", "face-1"] } },
    { op: 2, kind: "extrude", roles: { startCap: ["face-5"], endCap: ["face-11"], side: ["face-6"] } },
  ];

  it("extracts the role's recorded ids", () => {
    expect(bucketReferenceIds(buckets, { version: 1, source: { kind: "bucket", op: 2, role: "endCap" } })).toEqual([
      "face-11",
    ]);
  });

  it("returns [] for a missing bucket or absent role (never a fabricated match)", () => {
    expect(bucketReferenceIds(buckets, { version: 1, source: { kind: "bucket", op: 1, role: "body" } })).toEqual([]);
    expect(bucketReferenceIds(buckets, { version: 1, source: { kind: "bucket", op: 0, role: "band" } })).toEqual([]);
    expect(bucketReferenceIds([], { version: 1, source: { kind: "bucket", op: 0, role: "body" } })).toEqual([]);
  });

  it("returns a copy, not the live array", () => {
    const ids = bucketReferenceIds(buckets, { version: 1, source: { kind: "bucket", op: 0, role: "body" } });
    ids.push("face-9");
    expect(buckets[0].roles.body).toEqual(["face-0", "face-1"]);
  });
});
