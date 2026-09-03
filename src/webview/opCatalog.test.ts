import { describe, expect, it } from "vitest";
import { OP_CATALOG, allCatalogEntries, describeOp, referencedEntities, buildEntityReferenceIndex } from "./opCatalog";
import { OP_ICONS } from "./opIcons";
import { BREP_ONLY_OPS, QUERYABLE_OPERAND_FIELDS, type EditOp, type EditOpKind } from "../editOps";

/** One representative well-formed op per kind, for describeOp coverage. */
const REPRESENTATIVE_OPS: Record<EditOpKind, EditOp> = {
  translate: { op: "translate", targets: ["solid-0"], vec: [1, 2, 3] },
  rotate: { op: "rotate", targets: ["solid-0"], axisPoint: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 90 },
  scale: { op: "scale", targets: ["solid-0"], center: [0, 0, 0], factors: [2, 2, 2] },
  mirror: { op: "mirror", targets: ["solid-0"], planePoint: [0, 0, 0], planeNormal: [1, 0, 0] },
  boolean: { op: "boolean", kind: "union", a: ["solid-0"], b: ["solid-1"] },
  fillet: { op: "fillet", edges: ["edge-0"], radius: 1 },
  chamfer: { op: "chamfer", edges: ["edge-0"], distance: 1 },
  extrude: { op: "extrude", profile: "face-0", dir: [0, 0, 1], length: 10 },
  revolve: { op: "revolve", profile: "face-0", axisPoint: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360 },
  sweep: { op: "sweep", profile: "face-0", path: "edge-0" },
  loft: { op: "loft", profiles: ["face-0", "face-1"] },
  explode: { op: "explode", factor: 1 },
  mate: { op: "mate", faceA: "face-0", faceB: "face-1" },
  shell: { op: "shell", thickness: -1, openingFaces: ["face-0"] },
  draft: { op: "draft", faces: ["face-0"], angleDeg: 10 },
  splitByPlane: { op: "splitByPlane", targets: ["solid-0"], planePoint: [0, 0, 0], planeNormal: [0, 0, 1], keep: "both" },
  section: { op: "section", targets: ["solid-0"], planePoint: [0, 0, 0], planeNormal: [0, 0, 1] },
  rib: { op: "rib", spineEdges: ["edge-0", "edge-1"], dir: [0, 0, 1], thin: 2, upTo: "face-0" },
  addBox: { op: "addBox", center: [0, 0, 0], size: [10, 10, 10] },
  addSphere: { op: "addSphere", center: [0, 0, 0], radius: 5 },
  addCylinder: { op: "addCylinder", center: [0, 0, 0], axis: [0, 0, 1], radius: 5, height: 10 },
  addCone: { op: "addCone", center: [0, 0, 0], axis: [0, 0, 1], radius1: 5, radius2: 0, height: 10 },
  addTorus: { op: "addTorus", center: [0, 0, 0], axis: [0, 0, 1], majorRadius: 10, minorRadius: 2 },
  addPrism: { op: "addPrism", center: [0, 0, 0], axis: [0, 0, 1], radius: 5, sides: 6, height: 10 },
  addWedge: { op: "addWedge", center: [0, 0, 0], axis: [0, 0, 1], up: [1, 0, 0], dx: 10, dy: 6, dz: 4, ltx: 3 },
  addHole: { op: "addHole", targets: ["solid-0"], position: [0, 0, 10], axis: [0, 0, -1], radius: 2, depth: 5 },
  addCounterboreHole: { op: "addCounterboreHole", targets: ["solid-0"], position: [0, 0, 10], axis: [0, 0, -1], radius: 2, depth: 5, cbRadius: 4, cbDepth: 2 },
  addCountersinkHole: { op: "addCountersinkHole", targets: ["solid-0"], position: [0, 0, 10], axis: [0, 0, -1], radius: 2, depth: 5, csRadius: 4, csAngleDeg: 90 },
  addCircleProfile: { op: "addCircleProfile", center: [0, 0, 0], normal: [0, 0, 1], radius: 5 },
  addRectangleProfile: { op: "addRectangleProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], width: 10, height: 6 },
  addPolygonProfile: { op: "addPolygonProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], radius: 5, sides: 6 },
  addEllipseProfile: { op: "addEllipseProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], radiusX: 8, radiusY: 5 },
  addRoundedRectangleProfile: { op: "addRoundedRectangleProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], width: 10, height: 6, cornerRadius: 1 },
  addSlotProfile: { op: "addSlotProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], length: 12, width: 4 },
  addTrapezoidProfile: { op: "addTrapezoidProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], bottomWidth: 10, topWidth: 6, height: 5 },
  addPoint: { op: "addPoint", position: [1, 2, 3] },
  addLine: { op: "addLine", start: [0, 0, 0], end: [10, 0, 0] },
  addArc: { op: "addArc", center: [0, 0, 0], normal: [0, 0, 1], radius: 5, startAngleDeg: 0, endAngleDeg: 180 },
  addPolyline: { op: "addPolyline", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], closed: false },
  addThreePointArc: { op: "addThreePointArc", p1: [0, 0, 0], p2: [5, 5, 0], p3: [10, 0, 0] },
  addSpline: { op: "addSpline", points: [[0, 0, 0], [5, 5, 0], [10, 0, 0]] },
  addBezier: { op: "addBezier", controlPoints: [[0, 0, 0], [5, 10, 0], [10, 0, 0]] },
  addEllipseArc: { op: "addEllipseArc", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], radiusX: 8, radiusY: 5, startAngleDeg: 0, endAngleDeg: 90 },
  addHelix: { op: "addHelix", center: [0, 0, 0], axis: [0, 0, 1], radius: 5, pitch: 3, turns: 2 },
  addSurfaceFromLines: { op: "addSurfaceFromLines", edges: ["edge-0", "edge-1", "edge-2"] },
  addVolumeFromSurfaces: { op: "addVolumeFromSurfaces", faces: ["face-0", "face-1", "face-2", "face-3"] },
  addEdgeSlot: { op: "addEdgeSlot", edge: "edge-0", width: 2 },
  align: { op: "align", targets: ["solid-0"], axis: "z", extent: "min", to: 0 },
  patternLinear: { op: "patternLinear", targets: ["solid-0"], direction: [1, 0, 0], spacing: 10, count: 4 },
  patternCircular: { op: "patternCircular", targets: ["solid-0"], axisPoint: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 60, count: 6 },
};

describe("OP_CATALOG", () => {
  it("has unique panel op ids across all tabs", () => {
    const ids = allCatalogEntries().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has an icon for every catalog entry", () => {
    for (const e of allCatalogEntries()) {
      expect(OP_ICONS[e.id], `icon for ${e.id}`).toBeTruthy();
    }
  });

  it("has no orphan icons (every icon key is a catalog entry)", () => {
    const ids = new Set(allCatalogEntries().map((e) => e.id));
    for (const key of Object.keys(OP_ICONS)) {
      expect(ids.has(key as never), `catalog entry for icon ${key}`).toBe(true);
    }
  });

  it("brepOnly flags agree with BREP_ONLY_OPS over each entry's kinds", () => {
    for (const e of allCatalogEntries()) {
      const expected = e.kinds.every((k) => BREP_ONLY_OPS.has(k));
      expect(e.brepOnly, `brepOnly for ${e.id}`).toBe(expected);
    }
  });

  it("reaches every EditOp kind from at least one button", () => {
    const reachable = new Set(allCatalogEntries().flatMap((e) => e.kinds));
    for (const kind of Object.keys(REPRESENTATIVE_OPS) as EditOpKind[]) {
      expect(reachable.has(kind), `button emitting ${kind}`).toBe(true);
    }
  });

  it("keeps every 2D-tab entry B-rep-only (the 2D subtab greys out wholesale for meshes)", () => {
    for (const cat of OP_CATALOG.geometry2d) {
      for (const e of cat.ops) {
        expect(e.brepOnly, `${e.id} in 2D tab`).toBe(true);
      }
    }
  });
});

describe("describeOp", () => {
  it("labels a wire-form profile by its edges", () => {
    expect(describeOp({ op: "extrude", profileEdges: ["edge-2", "edge-3"], dir: [0, 0, 1], length: 5 }))
      .toContain("edge-2+edge-3");
    expect(describeOp({ op: "loft", profileEdgeSets: [["edge-0"], ["edge-1"]] })).toContain("2 profiles");
  });

  it("returns a non-empty label for every op kind", () => {
    for (const op of Object.values(REPRESENTATIVE_OPS)) {
      const label = describeOp(op);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("returns distinct labels across kinds", () => {
    const labels = Object.values(REPRESENTATIVE_OPS).map(describeOp);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("appends the expression bindings for parametric ops", () => {
    const plain = describeOp({ op: "extrude", profile: "face-1", dir: [0, 0, 1], length: 40 });
    const parametric = describeOp({
      op: "extrude", profile: "face-1", dir: [0, 0, 1], length: 40,
      exprs: { "length": "L*2" },
    });
    expect(plain).not.toContain("[");
    expect(parametric).toBe(`${plain} [length = L*2]`);
  });
});

describe("referencedEntities", () => {
  it("covers every op kind without throwing or returning undefined", () => {
    // The exhaustive switch makes a missing kind a compile error (verified: a
    // removed case yields TS2366), but this also pins the runtime shape.
    for (const kind of Object.keys(REPRESENTATIVE_OPS) as EditOpKind[]) {
      const ids = referencedEntities(REPRESENTATIVE_OPS[kind]);
      expect(Array.isArray(ids), `${kind} returns an array`).toBe(true);
      for (const id of ids) expect(typeof id).toBe("string");
    }
  });

  it("reads the `targets` family", () => {
    expect(referencedEntities({ op: "translate", targets: ["solid-1", "solid-2"], vec: [1, 0, 0] }))
      .toEqual(["solid-1", "solid-2"]);
    expect(referencedEntities({ op: "align", targets: ["solid-3"], axis: "z", extent: "min", to: 0 }))
      .toEqual(["solid-3"]);
  });

  it("reads BOTH boolean operand sides", () => {
    expect(referencedEntities({ op: "boolean", kind: "subtract", a: ["solid-0"], b: ["solid-1", "solid-2"] }))
      .toEqual(["solid-0", "solid-1", "solid-2"]);
  });

  it("reads the edge and face families", () => {
    expect(referencedEntities({ op: "fillet", edges: ["edge-4", "edge-5"], radius: 1 }))
      .toEqual(["edge-4", "edge-5"]);
    expect(referencedEntities({ op: "addVolumeFromSurfaces", faces: ["face-1", "face-2"] }))
      .toEqual(["face-1", "face-2"]);
    expect(referencedEntities({ op: "shell", thickness: -1, openingFaces: ["face-9"] }))
      .toEqual(["face-9"]);
  });

  it("reads the scalar-string operands, including sweep's second one", () => {
    expect(referencedEntities({ op: "extrude", profile: "face-7", dir: [0, 0, 1], length: 2 }))
      .toEqual(["face-7"]);
    // `path` is easy to forget — sweep is the only op with two differently-named
    // scalar operands.
    expect(referencedEntities({ op: "sweep", profile: "face-7", path: "edge-3" }))
      .toEqual(["face-7", "edge-3"]);
    expect(referencedEntities({ op: "mate", faceA: "face-1", faceB: "face-2" }))
      .toEqual(["face-1", "face-2"]);
  });

  it("reads the wire form of a profile operand", () => {
    expect(referencedEntities({ op: "extrude", profileEdges: ["edge-2", "edge-3"], dir: [0, 0, 1], length: 2 }))
      .toEqual(["edge-2", "edge-3"]);
    expect(referencedEntities({ op: "sweep", profileEdges: ["edge-2"], path: "edge-3" }))
      .toEqual(["edge-2", "edge-3"]);
    expect(referencedEntities({ op: "loft", profileEdgeSets: [["edge-0", "edge-1"], ["edge-2"]] }))
      .toEqual(["edge-0", "edge-1", "edge-2"]);
  });

  it("returns nothing for ops that genuinely name no entity", () => {
    expect(referencedEntities({ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] })).toEqual([]);
    expect(referencedEntities({ op: "explode", factor: 2 })).toEqual([]);
  });

  it("does not alias the op's own arrays", () => {
    // A caller must not be able to mutate an op through the returned list.
    const op: EditOp = { op: "fillet", edges: ["edge-1"], radius: 1 };
    referencedEntities(op).push("edge-999");
    expect(op.edges).toEqual(["edge-1"]);
  });

  it("covers every QUERYABLE_OPERAND_FIELDS entry (the op-model side of query storage)", () => {
    // Lock the two enumerations together: a field the sanitizer accepts must
    // be visible to hover tooltips, or a stored query names an entity the UI
    // claims no op mentions. Plane references (planeId/midplaneFaces) are
    // excluded from both surfaces by design — a plane is already a datum.
    const sampleFor = (field: string): { value: unknown; ids: string[] } => {
      switch (field) {
        case "profiles": return { value: ["__Q0", "__Q1"], ids: ["__Q0", "__Q1"] };
        case "profileEdgeSets": return { value: [["__Q0"]], ids: ["__Q0"] };
        case "profile": case "face": case "path": case "edge":
        case "upToFace": case "upTo": case "faceA": case "faceB":
          return { value: "__Q0", ids: ["__Q0"] };
        default: return { value: ["__Q0"], ids: ["__Q0"] };
      }
    };
    // Mutually-exclusive operand forms: setting one requires clearing its
    // sibling, or the op is invalid input (and referencedEntities rightfully
    // assumes valid ops — e.g. spreading a deleted boolean side would throw).
    const conflicts: Record<string, string[][]> = {
      extrude: [["profile", "profileEdges"]],
      revolve: [["profile", "profileEdges"]],
      sweep: [["profile", "profileEdges"]],
      loft: [["profiles", "profileEdgeSets"]],
    };
    for (const kind of Object.keys(QUERYABLE_OPERAND_FIELDS) as EditOpKind[]) {
      for (const field of QUERYABLE_OPERAND_FIELDS[kind]) {
        const op = { ...(REPRESENTATIVE_OPS[kind] as unknown as Record<string, unknown>) };
        for (const group of conflicts[kind] ?? []) {
          if (group.includes(field)) for (const sibling of group) if (sibling !== field) delete op[sibling];
        }
        const { value, ids } = sampleFor(field);
        op[field] = value;
        expect(referencedEntities(op as unknown as EditOp), `${kind}.${field} is read`).toEqual(
          expect.arrayContaining(ids)
        );
      }
    }
  });
});

describe("buildEntityReferenceIndex", () => {
  it("maps an id to every 1-based op position that mentions it", () => {
    const ops: EditOp[] = [
      { op: "addBox", center: [0, 0, 0], size: [1, 1, 1] },
      { op: "fillet", edges: ["edge-4"], radius: 1 },
      { op: "translate", targets: ["solid-0"], vec: [1, 0, 0] },
      { op: "chamfer", edges: ["edge-4", "edge-7"], distance: 1 },
    ];
    const index = buildEntityReferenceIndex(ops);
    expect(index.get("edge-4")).toEqual([2, 4]);
    expect(index.get("edge-7")).toEqual([4]);
    expect(index.get("solid-0")).toEqual([3]);
    expect(index.get("face-99")).toBeUndefined();
  });

  it("is empty for an empty op list", () => {
    expect(buildEntityReferenceIndex([]).size).toBe(0);
  });
});
