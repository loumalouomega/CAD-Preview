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
