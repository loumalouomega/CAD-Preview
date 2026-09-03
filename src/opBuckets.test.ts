import { describe, expect, it } from "vitest";
import { PRODUCED_ROLE, ROLE_LABELS, bucketSummary, type OpBucket } from "./opBuckets";
import { TOPOLOGY_CHANGING_OPS, type EditOpKind } from "./editOps";

describe("opBuckets: record shape", () => {
  it("is JSON-round-trippable (kernelIpc/postMessage-safe by construction)", () => {
    const bucket: OpBucket = { op: 3, kind: "extrude", roles: { startCap: ["face-5"], endCap: ["face-11"], side: ["face-6", "face-7"] } };
    const round = JSON.parse(JSON.stringify(bucket));
    expect(round).toEqual(bucket);
  });

  it("roles is a plain object, never a Map", () => {
    const bucket: OpBucket = { op: 0, kind: "fillet", roles: { band: ["face-2"] } };
    expect(bucket.roles instanceof Map).toBe(false);
    expect(Object.keys(bucket.roles)).toEqual(["band"]);
  });
});

describe("opBuckets: role vocabulary", () => {
  it("gives every topology-changing face-producing kind a PRODUCED_ROLE or the extrude/revolve special case", () => {
    // The kinds the collector can classify: everything in TOPOLOGY_CHANGING_OPS
    // produces faces EXCEPT the wireframe ops (point/line/arc/… produce edges
    // and vertices only) and mate (rigid) — those correctly have no entry.
    const faceProducing: EditOpKind[] = [...TOPOLOGY_CHANGING_OPS].filter(
      (k) => !["addPoint", "addLine", "addArc", "addPolyline", "addThreePointArc", "addSpline", "addBezier", "addEllipseArc", "addHelix"].includes(k)
    );
    for (const kind of faceProducing) {
      const named = kind in PRODUCED_ROLE || kind === "extrude" || kind === "revolve";
      expect(named, `kind ${kind} must have a role mapping (or the extrude/revolve special case)`).toBe(true);
    }
  });

  it("maps the canonical ops to their documented roles", () => {
    expect(PRODUCED_ROLE.fillet).toBe("band");
    expect(PRODUCED_ROLE.chamfer).toBe("band");
    expect(PRODUCED_ROLE.shell).toBe("inner");
    expect(PRODUCED_ROLE.addHole).toBe("wall");
    expect(PRODUCED_ROLE.splitByPlane).toBe("cutFace");
    expect(PRODUCED_ROLE.section).toBe("sectionFace");
    expect(PRODUCED_ROLE.patternLinear).toBe("copies");
    expect(PRODUCED_ROLE.addBox).toBe("body");
    expect(PRODUCED_ROLE.boolean).toBe("produced");
    // No fabricated role names: unlisted kinds degrade to "produced" at the
    // collector (PRODUCED_ROLE[kind] ?? "produced"), never to a guess.
    expect(PRODUCED_ROLE.translate).toBeUndefined();
    expect(PRODUCED_ROLE.extrude).toBeUndefined(); // special-cased in the collector
  });

  it("every PRODUCED_ROLE value and special-case role has a display label", () => {
    const values = [...Object.values(PRODUCED_ROLE), "startCap", "endCap", "side"];
    for (const role of values) expect(ROLE_LABELS[role], `role ${role} needs a label`).toBeTruthy();
  });

  it("rigid transforms have no role mapping (they are not classified)", () => {
    // The TOPOLOGY_CHANGING_OPS gate makes this moot at runtime (translate
    // never reaches the classifier), but the vocabulary agrees: no entries.
    expect(PRODUCED_ROLE.translate).toBeUndefined();
    expect(PRODUCED_ROLE.rotate).toBeUndefined();
    expect(PRODUCED_ROLE.scale).toBeUndefined();
    expect(PRODUCED_ROLE.mirror).toBeUndefined();
    expect(PRODUCED_ROLE.align).toBeUndefined();
    expect(PRODUCED_ROLE.mate).toBeUndefined();
  });
});

describe("opBuckets: bucketSummary", () => {
  it("renders roles in the fixed label order with counts", () => {
    const roles = { side: ["face-6", "face-7", "face-8", "face-9"], startCap: ["face-5"], endCap: ["face-11"] };
    // Fixed order puts startCap/endCap/side first regardless of key order.
    expect(bucketSummary(roles)).toBe("start cap ×1, end cap ×1, side walls ×4");
  });

  it("skips empty roles and handles the generic role", () => {
    expect(bucketSummary({ produced: ["face-1", "face-2"], side: [] })).toBe("produced ×2");
    expect(bucketSummary({})).toBe("");
    expect(bucketSummary({ band: ["face-0"] })).toBe("band ×1");
  });
});
