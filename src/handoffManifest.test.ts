import { describe, it, expect } from "vitest";
import { buildHandoffManifest, checkHandoffManifest, parseHandoffManifest, replayFingerprint, serializeHandoffManifest } from "./handoffManifest";
import { DEFAULT_MESH_OPTIONS } from "./meshOptions";
import type { HandoffFacts } from "./gmshService";
import type { Part } from "./protocol";

const part = (name: string, surfaces: string[] = [], volumes: string[] = []): Part =>
  ({ name, color: "#fff", volumes, surfaces, lines: [], points: [] }) as Part;

const facts: HandoffFacts = {
  engineUsed: "gmsh",
  nodeCount: 100,
  elementCount: 300,
  groups: [
    { dim: 2, physicalTag: 1, name: "Inlet", entityTags: [3], elementCount: 12 },
    { dim: 2, physicalTag: 2, name: "Wall", entityTags: [3, 4], elementCount: 30 },
  ],
  unassignedSurfaceTags: [1, 2, 5],
  overlaps: [{ dim: 2, entityTag: 3, groups: ["Inlet", "Wall"] }],
  subModelParts: [{ name: "Inlet", nodeCount: 10, volumeCellCount: 0, surfaceCellCount: 12 }],
  warnings: [],
};

function build(overrides: Partial<Parameters<typeof buildHandoffManifest>[0]> = {}) {
  return buildHandoffManifest({
    createdAt: "2026-09-23T00:00:00.000Z",
    source: { path: "/m/a.step", format: "step", bytes: new TextEncoder().encode("ISO-10303-21;") },
    ops: [{ op: "addBox" }],
    bakedThrough: 0,
    editsBaked: true,
    unit: "mm",
    scaleFactor: 1,
    meshOptions: DEFAULT_MESH_OPTIONS,
    kernels: { "opencascade.js": "1.1.1", "@loumalouomega/gmsh-wasm": "0.3.0", "@meshioplusplus/wasm": null, "float-tetwild-wasm": null },
    outputs: [{ path: "/m/a.mdpa", format: "mdpaElements", bytes: new TextEncoder().encode("Begin Nodes") }],
    parts: [part("Inlet", ["face-1"]), part("Wall", ["face-2"]), part("Ghost", ["face-99"]), part("Empty")],
    facts,
    ...overrides,
  });
}

describe("buildHandoffManifest", () => {
  it("reports each Part's status and groups, and coverage as facts", () => {
    const m = build();
    expect(m.parts.map((p) => [p.name, p.status])).toEqual([["Inlet", "resolved"], ["Wall", "resolved"], ["Ghost", "unresolved"], ["Empty", "empty"]]);
    expect(m.parts[0].subModelPart).toEqual({ nodeCount: 10, volumeCellCount: 0, surfaceCellCount: 12 });
    expect(m.parts[1].groups[0]).toEqual({ dim: 2, physicalTag: 2, entityCount: 2, elementCount: 30 });
    expect(m.coverage).toMatchObject({ emptyParts: ["Empty"], unresolvedParts: ["Ghost"], unassignedSurfaceCount: 3 });
    expect(m.coverage.overlaps[0].groups).toEqual(["Inlet", "Wall"]);
    expect(m.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.outputs[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records a unit conversion exactly once", () => {
    const m = build({ unit: "in", scaleFactor: 1 / 25.4 });
    expect(m.unit).toEqual({ unit: "in", scaleFactor: 1 / 25.4 });
    expect(m.notes.filter((n) => /scaled by/.test(n))).toHaveLength(1);
    expect(build().notes.some((n) => /scaled by/.test(n))).toBe(false);
  });

  it("round-trips through serialize/parse and rejects non-manifests", () => {
    const m = build();
    expect(parseHandoffManifest(serializeHandoffManifest(m))).toEqual(m);
    expect(parseHandoffManifest('{"kind":"other"}')).toBeNull();
    expect(parseHandoffManifest("not json")).toBeNull();
  });
});

describe("checkHandoffManifest", () => {
  const m = build();
  const out = { path: "/m/a.mdpa", sha256: m.outputs[0].sha256 };
  it("is current when source, edits and outputs are unchanged", () => {
    const r = checkHandoffManifest(m, { sourceSha256: m.source.sha256, replayFingerprint: m.replay.fingerprint, outputs: [out] });
    expect(r.current).toBe(true);
  });
  it("goes stale on an edit after export, and names why", () => {
    const edited = replayFingerprint([{ op: "addBox" }, { op: "fillet" }], 0);
    const r = checkHandoffManifest(m, { sourceSha256: m.source.sha256, replayFingerprint: edited, outputs: [out] });
    expect(r.current).toBe(false);
    expect(r.checks.find((c) => c.name === "edits")?.detail).toMatch(/changed/);
  });
  it("goes stale on a changed source or a missing output", () => {
    expect(checkHandoffManifest(m, { sourceSha256: "0".repeat(64), replayFingerprint: m.replay.fingerprint, outputs: [out] }).current).toBe(false);
    expect(checkHandoffManifest(m, { sourceSha256: m.source.sha256, replayFingerprint: m.replay.fingerprint, outputs: [] }).current).toBe(false);
  });
  it("the replay fingerprint is order- and bake-sensitive", () => {
    expect(replayFingerprint([1, 2], 0)).not.toBe(replayFingerprint([2, 1], 0));
    expect(replayFingerprint([1], 0)).not.toBe(replayFingerprint([1], 1));
  });
});
