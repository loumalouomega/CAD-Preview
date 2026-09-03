import { describe, it, expect } from "vitest";
import { validateEditOp, BREP_ONLY_OPS, TOPOLOGY_CHANGING_OPS, GUIDE_KINDS } from "./editOps";

describe("validateEditOp", () => {
  it("accepts well-formed transform ops", () => {
    expect(validateEditOp({ op: "translate", targets: ["solid-0"], vec: [1, 2, 3] }))
      .toEqual({ op: "translate", targets: ["solid-0"], vec: [1, 2, 3] });
    expect(validateEditOp({ op: "scale", targets: ["solid-0"], center: [0, 0, 0], factors: [2, 1, 1] }))
      .toMatchObject({ op: "scale" });
    expect(validateEditOp({ op: "mirror", targets: ["solid-0"], planePoint: [0, 0, 5], planeNormal: [1, 2, -1] }))
      .toEqual({ op: "mirror", targets: ["solid-0"], planePoint: [0, 0, 5], planeNormal: [1, 2, -1] });
  });

  it("accepts well-formed boolean and fillet/chamfer ops", () => {
    expect(validateEditOp({ op: "boolean", kind: "union", a: ["solid-0"], b: ["solid-1"] }))
      .toMatchObject({ op: "boolean", kind: "union" });
    expect(validateEditOp({ op: "fillet", edges: ["edge-3"], radius: 0.5 }))
      .toEqual({ op: "fillet", edges: ["edge-3"], radius: 0.5 });
    expect(validateEditOp({ op: "chamfer", edges: ["edge-3"], distance: 0.5 }))
      .toEqual({ op: "chamfer", edges: ["edge-3"], distance: 0.5 });
  });

  it("rejects malformed ops", () => {
    expect(validateEditOp(null)).toBeNull();
    expect(validateEditOp({ op: "translate", targets: [], vec: [1, 2, 3] })).toBeNull(); // empty targets
    expect(validateEditOp({ op: "translate", targets: ["a"], vec: [1, 2] })).toBeNull(); // short vec
    expect(validateEditOp({ op: "translate", targets: ["a"], vec: [1, null, 3] })).toBeNull(); // non-finite
    expect(validateEditOp({ op: "boolean", kind: "nope", a: ["a"], b: ["b"] })).toBeNull(); // bad kind
    expect(validateEditOp({ op: "fillet", edges: ["e"] })).toBeNull(); // missing radius
    expect(validateEditOp({ op: "loft", profiles: ["one"] })).toBeNull(); // loft needs ≥2
    expect(validateEditOp({ op: "bogus" })).toBeNull();
  });

  it("classifies B-rep-only and topology-changing ops", () => {
    expect(BREP_ONLY_OPS.has("fillet")).toBe(true);
    expect(BREP_ONLY_OPS.has("translate")).toBe(false);
    expect(TOPOLOGY_CHANGING_OPS.has("boolean")).toBe(true);
    expect(TOPOLOGY_CHANGING_OPS.has("translate")).toBe(false);
  });

  it("accepts well-formed primitive ops", () => {
    expect(validateEditOp({ op: "addBox", center: [0, 0, 0], size: [1, 2, 3] }))
      .toEqual({ op: "addBox", center: [0, 0, 0], size: [1, 2, 3] });
    expect(validateEditOp({ op: "addSphere", center: [0, 0, 0], radius: 5 }))
      .toEqual({ op: "addSphere", center: [0, 0, 0], radius: 5 });
    expect(validateEditOp({ op: "addCylinder", center: [0, 0, 0], axis: [0, 0, 1], radius: 5, height: 10 }))
      .toEqual({ op: "addCylinder", center: [0, 0, 0], axis: [0, 0, 1], radius: 5, height: 10 });
    expect(validateEditOp({ op: "addCone", center: [0, 0, 0], axis: [0, 0, 1], radius1: 5, radius2: 0, height: 10 }))
      .toEqual({ op: "addCone", center: [0, 0, 0], axis: [0, 0, 1], radius1: 5, radius2: 0, height: 10 });
    expect(validateEditOp({ op: "addTorus", center: [0, 0, 0], axis: [0, 0, 1], majorRadius: 10, minorRadius: 2 }))
      .toEqual({ op: "addTorus", center: [0, 0, 0], axis: [0, 0, 1], majorRadius: 10, minorRadius: 2 });
    expect(validateEditOp({ op: "addPrism", center: [0, 0, 0], axis: [0, 0, 1], radius: 5, sides: 6, height: 10 }))
      .toEqual({ op: "addPrism", center: [0, 0, 0], axis: [0, 0, 1], radius: 5, sides: 6, height: 10 });
  });

  it("rejects malformed primitive ops", () => {
    // non-positive dimensions
    expect(validateEditOp({ op: "addBox", center: [0, 0, 0], size: [1, 0, 3] })).toBeNull();
    expect(validateEditOp({ op: "addSphere", center: [0, 0, 0], radius: 0 })).toBeNull();
    expect(validateEditOp({ op: "addSphere", center: [0, 0, 0], radius: -1 })).toBeNull();
    expect(validateEditOp({ op: "addCylinder", center: [0, 0, 0], axis: [0, 0, 1], radius: 5, height: 0 })).toBeNull();
    // zero-length axis
    expect(validateEditOp({ op: "addCylinder", center: [0, 0, 0], axis: [0, 0, 0], radius: 5, height: 10 })).toBeNull();
    // cone: both radii zero is degenerate
    expect(validateEditOp({ op: "addCone", center: [0, 0, 0], axis: [0, 0, 1], radius1: 0, radius2: 0, height: 10 })).toBeNull();
    // cone: negative radius
    expect(validateEditOp({ op: "addCone", center: [0, 0, 0], axis: [0, 0, 1], radius1: -1, radius2: 0, height: 10 })).toBeNull();
    // torus: minorRadius >= majorRadius
    expect(validateEditOp({ op: "addTorus", center: [0, 0, 0], axis: [0, 0, 1], majorRadius: 5, minorRadius: 5 })).toBeNull();
    expect(validateEditOp({ op: "addTorus", center: [0, 0, 0], axis: [0, 0, 1], majorRadius: 5, minorRadius: 6 })).toBeNull();
    // prism: sides < 3 or non-integer
    expect(validateEditOp({ op: "addPrism", center: [0, 0, 0], axis: [0, 0, 1], radius: 5, sides: 2, height: 10 })).toBeNull();
    expect(validateEditOp({ op: "addPrism", center: [0, 0, 0], axis: [0, 0, 1], radius: 5, sides: 3.5, height: 10 })).toBeNull();
    // missing/short center
    expect(validateEditOp({ op: "addBox", center: [0, 0], size: [1, 2, 3] })).toBeNull();
  });

  it("primitive ops are topology-changing and not B-rep-only", () => {
    for (const kind of ["addBox", "addSphere", "addCylinder", "addCone", "addTorus", "addPrism"] as const) {
      expect(TOPOLOGY_CHANGING_OPS.has(kind)).toBe(true);
      expect(BREP_ONLY_OPS.has(kind)).toBe(false);
    }
  });

  it("accepts well-formed 2D profile ops", () => {
    expect(validateEditOp({ op: "addCircleProfile", center: [0, 0, 0], normal: [0, 0, 1], radius: 5 }))
      .toEqual({ op: "addCircleProfile", center: [0, 0, 0], normal: [0, 0, 1], radius: 5 });
    expect(validateEditOp({
      op: "addRectangleProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], width: 10, height: 6,
    })).toEqual({
      op: "addRectangleProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], width: 10, height: 6,
    });
    expect(validateEditOp({
      op: "addPolygonProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], radius: 5, sides: 6,
    })).toEqual({
      op: "addPolygonProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], radius: 5, sides: 6,
    });
  });

  it("rejects malformed 2D profile ops", () => {
    // non-positive dimensions
    expect(validateEditOp({ op: "addCircleProfile", center: [0, 0, 0], normal: [0, 0, 1], radius: 0 })).toBeNull();
    expect(validateEditOp({
      op: "addRectangleProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], width: 0, height: 6,
    })).toBeNull();
    expect(validateEditOp({
      op: "addPolygonProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], radius: -1, sides: 6,
    })).toBeNull();
    // zero-length normal/up
    expect(validateEditOp({ op: "addCircleProfile", center: [0, 0, 0], normal: [0, 0, 0], radius: 5 })).toBeNull();
    expect(validateEditOp({
      op: "addRectangleProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [0, 0, 0], width: 10, height: 6,
    })).toBeNull();
    // up parallel to normal — no well-defined in-plane frame
    expect(validateEditOp({
      op: "addRectangleProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [0, 0, 5], width: 10, height: 6,
    })).toBeNull();
    expect(validateEditOp({
      op: "addPolygonProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [0, 0, -3], radius: 5, sides: 6,
    })).toBeNull();
    // polygon: sides < 3 or non-integer
    expect(validateEditOp({
      op: "addPolygonProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], radius: 5, sides: 2,
    })).toBeNull();
    expect(validateEditOp({
      op: "addPolygonProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], radius: 5, sides: 4.5,
    })).toBeNull();
  });

  it("accepts well-formed modify ops (shell/split/section)", () => {
    expect(validateEditOp({ op: "shell", thickness: -1, openingFaces: ["face-0", "face-1"] }))
      .toEqual({ op: "shell", thickness: -1, openingFaces: ["face-0", "face-1"] });
    expect(validateEditOp({
      op: "splitByPlane", targets: ["solid-0"], planePoint: [0, 0, 5], planeNormal: [0, 0, 1], keep: "positive",
    })).toEqual({
      op: "splitByPlane", targets: ["solid-0"], planePoint: [0, 0, 5], planeNormal: [0, 0, 1], keep: "positive",
    });
    expect(validateEditOp({
      op: "section", targets: ["solid-0"], planePoint: [0, 0, 5], planeNormal: [0, 0, 1],
    })).not.toBeNull();
  });

  it("rejects malformed modify ops", () => {
    // shell: zero thickness / empty opening list (empty ≠ hollow in this OCCT build)
    expect(validateEditOp({ op: "shell", thickness: 0, openingFaces: ["face-0"] })).toBeNull();
    expect(validateEditOp({ op: "shell", thickness: -1, openingFaces: [] })).toBeNull();
    // split: bad keep enum / zero-length normal / no targets
    expect(validateEditOp({
      op: "splitByPlane", targets: ["solid-0"], planePoint: [0, 0, 0], planeNormal: [0, 0, 1], keep: "top",
    })).toBeNull();
    expect(validateEditOp({
      op: "splitByPlane", targets: ["solid-0"], planePoint: [0, 0, 0], planeNormal: [0, 0, 0], keep: "both",
    })).toBeNull();
    expect(validateEditOp({
      op: "splitByPlane", targets: [], planePoint: [0, 0, 0], planeNormal: [0, 0, 1], keep: "both",
    })).toBeNull();
    // section: zero-length normal
    expect(validateEditOp({
      op: "section", targets: ["solid-0"], planePoint: [0, 0, 0], planeNormal: [0, 0, 0],
    })).toBeNull();
    // mirror: zero-length planeNormal — same gate as splitByPlane/section
    // (gp_Dir(0,0,0) throws inside OCCT and the op would silently no-op)
    expect(validateEditOp({
      op: "mirror", targets: ["solid-0"], planePoint: [0, 0, 5], planeNormal: [0, 0, 0],
    })).toBeNull();
  });

  it("modify ops are topology-changing, B-rep only", () => {
    for (const kind of ["shell", "splitByPlane", "section", "rib"] as const) {
      expect(TOPOLOGY_CHANGING_OPS.has(kind)).toBe(true);
      expect(BREP_ONLY_OPS.has(kind)).toBe(true);
    }
  });

  it("accepts well-formed wedge and hole ops", () => {
    expect(validateEditOp({
      op: "addWedge", center: [0, 0, 0], axis: [0, 0, 1], up: [1, 0, 0], dx: 10, dy: 6, dz: 4, ltx: 3,
    })).toEqual({
      op: "addWedge", center: [0, 0, 0], axis: [0, 0, 1], up: [1, 0, 0], dx: 10, dy: 6, dz: 4, ltx: 3,
    });
    // ltx = 0 (sharp edge) is legal
    expect(validateEditOp({
      op: "addWedge", center: [0, 0, 0], axis: [0, 0, 1], up: [1, 0, 0], dx: 10, dy: 6, dz: 4, ltx: 0,
    })).not.toBeNull();
    expect(validateEditOp({
      op: "addHole", targets: ["solid-0"], position: [0, 0, 10], axis: [0, 0, -1], radius: 2, depth: 5,
    })).toEqual({
      op: "addHole", targets: ["solid-0"], position: [0, 0, 10], axis: [0, 0, -1], radius: 2, depth: 5,
    });
    expect(validateEditOp({
      op: "addCounterboreHole", targets: ["solid-0"], position: [0, 0, 10], axis: [0, 0, -1],
      radius: 2, depth: 5, cbRadius: 4, cbDepth: 2,
    })).not.toBeNull();
    expect(validateEditOp({
      op: "addCountersinkHole", targets: ["solid-0"], position: [0, 0, 10], axis: [0, 0, -1],
      radius: 2, depth: 5, csRadius: 4, csAngleDeg: 90,
    })).not.toBeNull();
  });

  it("rejects malformed wedge and hole ops", () => {
    // wedge: non-positive extents / negative ltx / up parallel to axis
    expect(validateEditOp({
      op: "addWedge", center: [0, 0, 0], axis: [0, 0, 1], up: [1, 0, 0], dx: 0, dy: 6, dz: 4, ltx: 3,
    })).toBeNull();
    expect(validateEditOp({
      op: "addWedge", center: [0, 0, 0], axis: [0, 0, 1], up: [1, 0, 0], dx: 10, dy: 6, dz: 4, ltx: -1,
    })).toBeNull();
    expect(validateEditOp({
      op: "addWedge", center: [0, 0, 0], axis: [0, 0, 1], up: [0, 0, 2], dx: 10, dy: 6, dz: 4, ltx: 3,
    })).toBeNull();
    // hole: no targets / zero axis / non-positive radius or depth
    expect(validateEditOp({
      op: "addHole", targets: [], position: [0, 0, 10], axis: [0, 0, -1], radius: 2, depth: 5,
    })).toBeNull();
    expect(validateEditOp({
      op: "addHole", targets: ["solid-0"], position: [0, 0, 10], axis: [0, 0, 0], radius: 2, depth: 5,
    })).toBeNull();
    expect(validateEditOp({
      op: "addHole", targets: ["solid-0"], position: [0, 0, 10], axis: [0, 0, -1], radius: 0, depth: 5,
    })).toBeNull();
    // counterbore: cbRadius must exceed radius; cbDepth must stay under depth
    expect(validateEditOp({
      op: "addCounterboreHole", targets: ["solid-0"], position: [0, 0, 10], axis: [0, 0, -1],
      radius: 2, depth: 5, cbRadius: 2, cbDepth: 2,
    })).toBeNull();
    expect(validateEditOp({
      op: "addCounterboreHole", targets: ["solid-0"], position: [0, 0, 10], axis: [0, 0, -1],
      radius: 2, depth: 5, cbRadius: 4, cbDepth: 5,
    })).toBeNull();
    // countersink: csRadius must exceed radius; angle in (0°, 180°)
    expect(validateEditOp({
      op: "addCountersinkHole", targets: ["solid-0"], position: [0, 0, 10], axis: [0, 0, -1],
      radius: 2, depth: 5, csRadius: 1, csAngleDeg: 90,
    })).toBeNull();
    expect(validateEditOp({
      op: "addCountersinkHole", targets: ["solid-0"], position: [0, 0, 10], axis: [0, 0, -1],
      radius: 2, depth: 5, csRadius: 4, csAngleDeg: 180,
    })).toBeNull();
  });

  it("wedge is B-rep only; holes work on every format", () => {
    expect(BREP_ONLY_OPS.has("addWedge")).toBe(true);
    for (const kind of ["addHole", "addCounterboreHole", "addCountersinkHole"] as const) {
      expect(BREP_ONLY_OPS.has(kind)).toBe(false);
      expect(TOPOLOGY_CHANGING_OPS.has(kind)).toBe(true);
    }
    expect(TOPOLOGY_CHANGING_OPS.has("addWedge")).toBe(true);
  });

  it("accepts well-formed ellipse/rounded-rect/slot/trapezoid profile ops", () => {
    expect(validateEditOp({
      op: "addEllipseProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], radiusX: 8, radiusY: 5,
    })).toEqual({
      op: "addEllipseProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], radiusX: 8, radiusY: 5,
    });
    expect(validateEditOp({
      op: "addRoundedRectangleProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], width: 10, height: 6, cornerRadius: 1,
    })).toEqual({
      op: "addRoundedRectangleProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], width: 10, height: 6, cornerRadius: 1,
    });
    expect(validateEditOp({
      op: "addSlotProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], length: 12, width: 4,
    })).toEqual({
      op: "addSlotProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], length: 12, width: 4,
    });
    expect(validateEditOp({
      op: "addTrapezoidProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], bottomWidth: 10, topWidth: 6, height: 5,
    })).toEqual({
      op: "addTrapezoidProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], bottomWidth: 10, topWidth: 6, height: 5,
    });
  });

  it("rejects malformed ellipse/rounded-rect/slot/trapezoid profile ops", () => {
    // non-positive radii / dimensions
    expect(validateEditOp({
      op: "addEllipseProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], radiusX: 0, radiusY: 5,
    })).toBeNull();
    expect(validateEditOp({
      op: "addTrapezoidProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], bottomWidth: 10, topWidth: 0, height: 5,
    })).toBeNull();
    // corner radius too large: 2·r must stay under min(width, height)
    expect(validateEditOp({
      op: "addRoundedRectangleProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], width: 10, height: 6, cornerRadius: 3,
    })).toBeNull();
    expect(validateEditOp({
      op: "addRoundedRectangleProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], width: 10, height: 6, cornerRadius: 0,
    })).toBeNull();
    // slot must be longer than wide (the equal case is a plain circle)
    expect(validateEditOp({
      op: "addSlotProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0], length: 4, width: 4,
    })).toBeNull();
    // up parallel to normal — no well-defined in-plane frame
    expect(validateEditOp({
      op: "addEllipseProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [0, 0, 2], radiusX: 8, radiusY: 5,
    })).toBeNull();
    expect(validateEditOp({
      op: "addSlotProfile", center: [0, 0, 0], normal: [0, 0, 1], up: [0, 0, -1], length: 12, width: 4,
    })).toBeNull();
  });

  it("2D profile ops are topology-changing, B-rep only", () => {
    for (const kind of [
      "addCircleProfile", "addRectangleProfile", "addPolygonProfile",
      "addEllipseProfile", "addRoundedRectangleProfile", "addSlotProfile", "addTrapezoidProfile",
    ] as const) {
      expect(TOPOLOGY_CHANGING_OPS.has(kind)).toBe(true);
      expect(BREP_ONLY_OPS.has(kind)).toBe(true);
    }
  });

  it("accepts well-formed curve ops", () => {
    expect(validateEditOp({ op: "addPolyline", points: [[0, 0, 0], [10, 0, 0]], closed: false }))
      .toEqual({ op: "addPolyline", points: [[0, 0, 0], [10, 0, 0]], closed: false });
    expect(validateEditOp({ op: "addPolyline", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], closed: true }))
      .toEqual({ op: "addPolyline", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], closed: true });
    expect(validateEditOp({ op: "addThreePointArc", p1: [0, 0, 0], p2: [5, 5, 0], p3: [10, 0, 0] }))
      .toEqual({ op: "addThreePointArc", p1: [0, 0, 0], p2: [5, 5, 0], p3: [10, 0, 0] });
    expect(validateEditOp({ op: "addSpline", points: [[0, 0, 0], [5, 5, 0], [10, 0, 0]] })).not.toBeNull();
    // Bézier control points MAY repeat consecutively (weighting trick) — only the count matters.
    expect(validateEditOp({ op: "addBezier", controlPoints: [[0, 0, 0], [5, 10, 0], [5, 10, 0], [10, 0, 0]] }))
      .not.toBeNull();
    expect(validateEditOp({
      op: "addEllipseArc", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0],
      radiusX: 8, radiusY: 5, startAngleDeg: 0, endAngleDeg: 90,
    })).not.toBeNull();
    expect(validateEditOp({ op: "addHelix", center: [0, 0, 0], axis: [0, 0, 1], radius: 5, pitch: 3, turns: 2 }))
      .not.toBeNull();
  });

  it("rejects malformed curve ops", () => {
    // too few points
    expect(validateEditOp({ op: "addPolyline", points: [[0, 0, 0]], closed: false })).toBeNull();
    expect(validateEditOp({ op: "addPolyline", points: [[0, 0, 0], [10, 0, 0]], closed: true })).toBeNull();
    expect(validateEditOp({ op: "addSpline", points: [[0, 0, 0]] })).toBeNull();
    expect(validateEditOp({ op: "addBezier", controlPoints: [[0, 0, 0]] })).toBeNull();
    // consecutive duplicate points (degenerate segment)
    expect(validateEditOp({ op: "addPolyline", points: [[0, 0, 0], [0, 0, 0], [10, 0, 0]], closed: false })).toBeNull();
    expect(validateEditOp({ op: "addSpline", points: [[0, 0, 0], [0, 0, 0], [10, 0, 0]] })).toBeNull();
    // closed polyline whose explicit first/last coincide (the closing edge is implicit)
    expect(validateEditOp({
      op: "addPolyline", points: [[0, 0, 0], [10, 0, 0], [0, 0, 0]], closed: true,
    })).toBeNull();
    // malformed point entry drops the whole op
    expect(validateEditOp({ op: "addSpline", points: [[0, 0, 0], [1, "x", 0]] })).toBeNull();
    // three-point arc with coincident points
    expect(validateEditOp({ op: "addThreePointArc", p1: [0, 0, 0], p2: [0, 0, 0], p3: [10, 0, 0] })).toBeNull();
    // ellipse arc: zero radius / up parallel to normal / equal angles
    expect(validateEditOp({
      op: "addEllipseArc", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0],
      radiusX: 0, radiusY: 5, startAngleDeg: 0, endAngleDeg: 90,
    })).toBeNull();
    expect(validateEditOp({
      op: "addEllipseArc", center: [0, 0, 0], normal: [0, 0, 1], up: [0, 0, 1],
      radiusX: 8, radiusY: 5, startAngleDeg: 0, endAngleDeg: 90,
    })).toBeNull();
    expect(validateEditOp({
      op: "addEllipseArc", center: [0, 0, 0], normal: [0, 0, 1], up: [1, 0, 0],
      radiusX: 8, radiusY: 5, startAngleDeg: 90, endAngleDeg: 90,
    })).toBeNull();
    // helix: non-positive radius/pitch/turns
    expect(validateEditOp({ op: "addHelix", center: [0, 0, 0], axis: [0, 0, 1], radius: 0, pitch: 3, turns: 2 })).toBeNull();
    expect(validateEditOp({ op: "addHelix", center: [0, 0, 0], axis: [0, 0, 1], radius: 5, pitch: -1, turns: 2 })).toBeNull();
    expect(validateEditOp({ op: "addHelix", center: [0, 0, 0], axis: [0, 0, 0], radius: 5, pitch: 3, turns: 2 })).toBeNull();
  });

  it("curve ops are topology-changing, B-rep only", () => {
    for (const kind of [
      "addPolyline", "addThreePointArc", "addSpline", "addBezier", "addEllipseArc", "addHelix",
    ] as const) {
      expect(TOPOLOGY_CHANGING_OPS.has(kind)).toBe(true);
      expect(BREP_ONLY_OPS.has(kind)).toBe(true);
    }
  });

  it("accepts well-formed wireframe ops", () => {
    expect(validateEditOp({ op: "addPoint", position: [1, 2, 3] }))
      .toEqual({ op: "addPoint", position: [1, 2, 3] });
    expect(validateEditOp({ op: "addLine", start: [0, 0, 0], end: [10, 0, 0] }))
      .toEqual({ op: "addLine", start: [0, 0, 0], end: [10, 0, 0] });
    expect(validateEditOp({
      op: "addArc", center: [0, 0, 0], normal: [0, 0, 1], radius: 5, startAngleDeg: 0, endAngleDeg: 90,
    })).toEqual({
      op: "addArc", center: [0, 0, 0], normal: [0, 0, 1], radius: 5, startAngleDeg: 0, endAngleDeg: 90,
    });
    expect(validateEditOp({ op: "addSurfaceFromLines", edges: ["edge-0", "edge-1", "edge-2"] }))
      .toEqual({ op: "addSurfaceFromLines", edges: ["edge-0", "edge-1", "edge-2"] });
    expect(validateEditOp({ op: "addVolumeFromSurfaces", faces: ["face-0", "face-1", "face-2", "face-3"] }))
      .toEqual({ op: "addVolumeFromSurfaces", faces: ["face-0", "face-1", "face-2", "face-3"] });
  });

  it("rejects malformed wireframe ops", () => {
    // missing position
    expect(validateEditOp({ op: "addPoint", position: [0, 0] })).toBeNull();
    // degenerate zero-length line
    expect(validateEditOp({ op: "addLine", start: [1, 2, 3], end: [1, 2, 3] })).toBeNull();
    // arc: non-positive radius, zero-length normal, equal angles
    expect(validateEditOp({
      op: "addArc", center: [0, 0, 0], normal: [0, 0, 1], radius: 0, startAngleDeg: 0, endAngleDeg: 90,
    })).toBeNull();
    expect(validateEditOp({
      op: "addArc", center: [0, 0, 0], normal: [0, 0, 0], radius: 5, startAngleDeg: 0, endAngleDeg: 90,
    })).toBeNull();
    expect(validateEditOp({
      op: "addArc", center: [0, 0, 0], normal: [0, 0, 1], radius: 5, startAngleDeg: 45, endAngleDeg: 45,
    })).toBeNull();
    // surface-from-lines needs >=3 edges
    expect(validateEditOp({ op: "addSurfaceFromLines", edges: ["edge-0", "edge-1"] })).toBeNull();
    expect(validateEditOp({ op: "addSurfaceFromLines", edges: [] })).toBeNull();
    // volume-from-surfaces needs >=4 faces
    expect(validateEditOp({ op: "addVolumeFromSurfaces", faces: ["face-0", "face-1", "face-2"] })).toBeNull();
  });

  it("wireframe ops are topology-changing, B-rep only", () => {
    for (const kind of [
      "addPoint", "addLine", "addArc", "addSurfaceFromLines", "addVolumeFromSurfaces",
    ] as const) {
      expect(TOPOLOGY_CHANGING_OPS.has(kind)).toBe(true);
      expect(BREP_ONLY_OPS.has(kind)).toBe(true);
    }
  });
});

describe("validateEditOp exprs annotation", () => {
  it("preserves valid exprs entries", () => {
    const op = validateEditOp({
      op: "extrude", profile: "face-1", dir: [0, 0, 1], length: 5,
      exprs: { "length": "L*2", "dir[2]": "H" },
    });
    expect(op).toMatchObject({ op: "extrude", length: 5, exprs: { "length": "L*2", "dir[2]": "H" } });
  });

  it("drops entries with bad keys, paths, or syntax", () => {
    const op = validateEditOp({
      op: "addBox", center: [0, 0, 0], size: [1, 2, 3],
      exprs: {
        "size[1]": "W",          // kept
        "size[5]": "W",          // out-of-range index
        "op": "W",               // non-numeric slot
        "targets[0]": "W",       // structural field (not on this op anyway)
        "__proto__": "W",        // unsafe key shape
        "center[0]": "1 +",      // syntax error
        "center[1]": 5,          // non-string value
      },
    });
    expect(op?.exprs).toEqual({ "size[1]": "W" });
  });

  it("omits exprs entirely when nothing survives", () => {
    const op = validateEditOp({
      op: "addBox", center: [0, 0, 0], size: [1, 2, 3],
      exprs: { "nope": "W" },
    });
    expect(op).not.toBeNull();
    expect(op && "exprs" in op).toBe(false);
    const noAnn = validateEditOp({ op: "addBox", center: [0, 0, 0], size: [1, 2, 3] });
    expect(noAnn && "exprs" in noAnn).toBe(false);
  });

  it("caps oversized expressions", () => {
    const op = validateEditOp({
      op: "addSphere", center: [0, 0, 0], radius: 5,
      exprs: { "radius": "1+".repeat(200) + "1" },
    });
    expect(op && "exprs" in op).toBe(false);
  });
});

describe("thin (sweep-family thin-walled features)", () => {
  const extrude = (extra: Record<string, unknown>) =>
    validateEditOp({ op: "extrude", profile: "face-1", dir: [0, 0, 1], length: 5, ...extra });

  it("accepts thin on all four sweep-family kinds", () => {
    expect(extrude({ thin: 2 })).toMatchObject({ op: "extrude", thin: 2 });
    expect(validateEditOp({ op: "revolve", profile: "face-1", axisPoint: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 90, thin: 2 }))
      .toMatchObject({ op: "revolve", thin: 2 });
    expect(validateEditOp({ op: "sweep", profile: "face-1", path: "edge-0", thin: 2 }))
      .toMatchObject({ op: "sweep", thin: 2 });
    expect(validateEditOp({ op: "loft", profiles: ["face-1", "face-2"], thin: 2 }))
      .toMatchObject({ op: "loft", thin: 2 });
  });

  it("omits the fields entirely when not thin", () => {
    const op = extrude({});
    expect(op).not.toBeNull();
    expect(op && "thin" in op).toBe(false);
    expect(op && "thinOuter" in op).toBe(false);
  });

  it("accepts thinOuter across its whole range, including fully outward", () => {
    expect(extrude({ thin: 2, thinOuter: 0 })).toMatchObject({ thin: 2, thinOuter: 0 });
    expect(extrude({ thin: 2, thinOuter: 1 })).toMatchObject({ thin: 2, thinOuter: 1 });
    expect(extrude({ thin: 2, thinOuter: 2 })).toMatchObject({ thin: 2, thinOuter: 2 });
  });

  it("rejects a non-positive or non-finite thin", () => {
    expect(extrude({ thin: 0 })).toBeNull();
    expect(extrude({ thin: -2 })).toBeNull();
    expect(extrude({ thin: Number.NaN })).toBeNull();
    expect(extrude({ thin: "2" })).toBeNull();
  });

  it("rejects thinOuter without thin, or outside [0, thin]", () => {
    expect(extrude({ thinOuter: 1 })).toBeNull();
    expect(extrude({ thin: 2, thinOuter: -1 })).toBeNull();
    expect(extrude({ thin: 2, thinOuter: 3 })).toBeNull();
    expect(extrude({ thin: 2, thinOuter: "1" })).toBeNull();
  });

  it("keeps thin expression-addressable — the reason the fields are flat", () => {
    // `paramExpr.ts`'s parseFieldPath accepts an identifier plus numeric
    // indices only, with no dotted form, so a nested `thin: {inner}` object
    // would be the one numeric op field a parametric variable cannot drive.
    const flat = extrude({ thin: 2, exprs: { thin: "wall" } });
    expect(flat).toMatchObject({ thin: 2, exprs: { thin: "wall" } });
    const nested = extrude({ thin: 2, exprs: { "thin.inner": "wall" } });
    expect(nested && "exprs" in nested).toBe(false);
  });
});

describe("profile operand (open/closed wire profiles)", () => {
  const extrude = (extra: Record<string, unknown>) =>
    validateEditOp({ op: "extrude", dir: [0, 0, 1], length: 5, ...extra });

  it("accepts either operand form on the three single-profile kinds", () => {
    expect(extrude({ profile: "face-1" })).toMatchObject({ profile: "face-1" });
    expect(extrude({ profileEdges: ["edge-2", "edge-3"] })).toMatchObject({ profileEdges: ["edge-2", "edge-3"] });
    expect(validateEditOp({ op: "revolve", profileEdges: ["edge-0"], axisPoint: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 90 }))
      .toMatchObject({ op: "revolve", profileEdges: ["edge-0"] });
    expect(validateEditOp({ op: "sweep", profileEdges: ["edge-0"], path: "edge-9" }))
      .toMatchObject({ op: "sweep", profileEdges: ["edge-0"], path: "edge-9" });
  });

  it("rejects neither form, and both forms at once", () => {
    expect(extrude({})).toBeNull();
    expect(extrude({ profile: "face-1", profileEdges: ["edge-2"] })).toBeNull();
    expect(validateEditOp({ op: "sweep", path: "edge-9" })).toBeNull();
    expect(validateEditOp({ op: "loft", profiles: ["face-1", "face-2"], profileEdgeSets: [["edge-0"], ["edge-1"]] })).toBeNull();
    expect(validateEditOp({ op: "loft" })).toBeNull();
  });

  it("pattern-checks the edge ids, unlike the face form", () => {
    // The id SHAPE is what distinguishes the two operand forms, so a face id
    // smuggled into the edge form would be a silently-wrong operand rather
    // than a resolve-time miss.
    expect(extrude({ profileEdges: ["face-2"] })).toBeNull();
    expect(extrude({ profileEdges: ["edge-2", "face-3"] })).toBeNull();
    expect(extrude({ profileEdges: ["edge-x"] })).toBeNull();
    expect(extrude({ profileEdges: [] })).toBeNull();
    expect(extrude({ profileEdges: "edge-2" })).toBeNull();
  });

  it("accepts loft's per-section edge form and checks its arity", () => {
    expect(validateEditOp({ op: "loft", profileEdgeSets: [["edge-0", "edge-1"], ["edge-2"]] }))
      .toMatchObject({ profileEdgeSets: [["edge-0", "edge-1"], ["edge-2"]] });
    expect(validateEditOp({ op: "loft", profileEdgeSets: [["edge-0"]] })).toBeNull(); // one section is not a loft
    expect(validateEditOp({ op: "loft", profileEdgeSets: [["edge-0"], []] })).toBeNull(); // an empty section
    expect(validateEditOp({ op: "loft", profileEdgeSets: [["edge-0"], ["face-1"]] })).toBeNull();
    expect(validateEditOp({ op: "loft", profileEdgeSets: ["edge-0"] })).toBeNull(); // not nested
  });

  it("composes with thin and with exprs", () => {
    expect(extrude({ profileEdges: ["edge-2"], thin: 2, exprs: { thin: "wall" } }))
      .toMatchObject({ profileEdges: ["edge-2"], thin: 2, exprs: { thin: "wall" } });
  });
});

describe("extrude up-to-face terminator", () => {
  const base = { op: "extrude", profile: "face-1", dir: [0, 0, 1] } as const;
  const extrude = (extra: Record<string, unknown>) => validateEditOp({ ...base, length: 5, ...extra });

  it("accepts exactly one of length / upToFace", () => {
    expect(extrude({})).toMatchObject({ op: "extrude", length: 5 });
    expect(validateEditOp({ ...base, upToFace: "face-9" })).toMatchObject({ op: "extrude", upToFace: "face-9" });
    expect(validateEditOp({ ...base, length: 5, upToFace: "face-9" })).toBeNull(); // both at once
    expect(validateEditOp({ ...base })).toBeNull(); // neither
  });

  it("pattern-checks the terminator id (a smuggled form is a rejection, not a miss)", () => {
    expect(validateEditOp({ ...base, upToFace: "edge-2" })).toBeNull();
    expect(validateEditOp({ ...base, upToFace: "face-x" })).toBeNull();
    expect(validateEditOp({ ...base, upToFace: 7 })).toBeNull();
    expect(validateEditOp({ ...base, upToFace: "face-9", length: "5" as unknown as number })).toBeNull();
  });

  it("composes with thin on the terminator form", () => {
    expect(validateEditOp({ ...base, upToFace: "face-9", thin: 2 })).toMatchObject({ upToFace: "face-9", thin: 2 });
  });
});

describe("rib", () => {
  const rib = (extra: Record<string, unknown>) =>
    validateEditOp({ op: "rib", spineEdges: ["edge-0", "edge-1"], dir: [0, 0, 1], thin: 2, upTo: "face-3", ...extra });

  it("accepts a well-formed rib (blend optional, defaulting downstream)", () => {
    expect(rib({})).toMatchObject({ op: "rib", spineEdges: ["edge-0", "edge-1"], thin: 2, upTo: "face-3" });
    expect(rib({ blendRadius: 0.5 })).toMatchObject({ blendRadius: 0.5 });
    expect(rib({ blendRadius: 0 })).toMatchObject({ blendRadius: 0 });
    expect(rib({ thinOuter: 1 })).toMatchObject({ thinOuter: 1 }); // exactly thin/2: symmetric
  });

  it("rejects a missing/meaningless spine, direction-less, thin-less, or terminator-less rib", () => {
    expect(validateEditOp({ op: "rib", dir: [0, 0, 1], thin: 2, upTo: "face-3" })).toBeNull(); // no spineEdges key
    expect(rib({ spineEdges: [] })).toBeNull();
    expect(rib({ spineEdges: ["face-0"] })).toBeNull(); // face smuggled into the edge form
    expect(rib({ spineEdges: ["edge-0", "face-1"] })).toBeNull();
    expect(rib({ thin: 0 })).toBeNull();
    expect(rib({ thin: -2 })).toBeNull();
    expect(validateEditOp({ op: "rib", spineEdges: ["edge-0"], dir: [0, 0, 1], thin: 2 })).toBeNull(); // no upTo
    expect(rib({ upTo: "edge-0" })).toBeNull();
    expect(rib({ upTo: "face-x" })).toBeNull();
  });

  it("rejects asymmetric thinOuter and negative blendRadius", () => {
    expect(rib({ thinOuter: 0.5 })).toBeNull(); // not exactly thin/2 — open wire has no outside
    expect(rib({ thinOuter: 2 })).toBeNull();
    expect(rib({ blendRadius: -1 })).toBeNull();
    expect(rib({ blendRadius: "0.5" })).toBeNull();
  });
});

describe("align / patternLinear / patternCircular", () => {
  it("accepts well-formed align/pattern ops", () => {
    expect(validateEditOp({ op: "align", targets: ["solid-0"], axis: "z", extent: "min", to: 0 }))
      .toEqual({ op: "align", targets: ["solid-0"], axis: "z", extent: "min", to: 0 });
    expect(validateEditOp({
      op: "patternLinear", targets: ["solid-0"], direction: [1, 0, 0], spacing: 10, count: 4,
    })).toEqual({ op: "patternLinear", targets: ["solid-0"], direction: [1, 0, 0], spacing: 10, count: 4 });
    expect(validateEditOp({
      op: "patternCircular", targets: ["solid-0"], axisPoint: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 60, count: 6,
    })).toEqual({
      op: "patternCircular", targets: ["solid-0"], axisPoint: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 60, count: 6,
    });
  });

  it("rejects malformed align ops", () => {
    // bad axis enum
    expect(validateEditOp({ op: "align", targets: ["solid-0"], axis: "w", extent: "min", to: 0 })).toBeNull();
    // bad extent enum
    expect(validateEditOp({ op: "align", targets: ["solid-0"], axis: "x", extent: "top", to: 0 })).toBeNull();
    // no targets
    expect(validateEditOp({ op: "align", targets: [], axis: "x", extent: "min", to: 0 })).toBeNull();
    // non-finite `to`
    expect(validateEditOp({ op: "align", targets: ["solid-0"], axis: "x", extent: "min", to: NaN })).toBeNull();
  });

  it("rejects malformed pattern ops", () => {
    // zero direction
    expect(validateEditOp({
      op: "patternLinear", targets: ["solid-0"], direction: [0, 0, 0], spacing: 10, count: 4,
    })).toBeNull();
    // zero spacing (degenerate — every copy would coincide)
    expect(validateEditOp({
      op: "patternLinear", targets: ["solid-0"], direction: [1, 0, 0], spacing: 0, count: 4,
    })).toBeNull();
    // count below 2
    expect(validateEditOp({
      op: "patternLinear", targets: ["solid-0"], direction: [1, 0, 0], spacing: 10, count: 1,
    })).toBeNull();
    // non-integer count
    expect(validateEditOp({
      op: "patternLinear", targets: ["solid-0"], direction: [1, 0, 0], spacing: 10, count: 2.5,
    })).toBeNull();
    // zero axisDir
    expect(validateEditOp({
      op: "patternCircular", targets: ["solid-0"], axisPoint: [0, 0, 0], axisDir: [0, 0, 0], angleDeg: 60, count: 6,
    })).toBeNull();
    // count below 2
    expect(validateEditOp({
      op: "patternCircular", targets: ["solid-0"], axisPoint: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 60, count: 1,
    })).toBeNull();
  });

  it("negative spacing/angle are valid (pattern the other direction)", () => {
    expect(validateEditOp({
      op: "patternLinear", targets: ["solid-0"], direction: [1, 0, 0], spacing: -5, count: 3,
    })).not.toBeNull();
    expect(validateEditOp({
      op: "patternCircular", targets: ["solid-0"], axisPoint: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: -45, count: 3,
    })).not.toBeNull();
  });

  it("pattern ops are topology-changing; align is not (a pure rigid move, like translate)", () => {
    expect(TOPOLOGY_CHANGING_OPS.has("patternLinear")).toBe(true);
    expect(TOPOLOGY_CHANGING_OPS.has("patternCircular")).toBe(true);
    expect(TOPOLOGY_CHANGING_OPS.has("align")).toBe(false);
  });

  it("neither align nor pattern is B-rep only — both are pure rigid transforms, meaningful for meshes too", () => {
    expect(BREP_ONLY_OPS.has("align")).toBe(false);
    expect(BREP_ONLY_OPS.has("patternLinear")).toBe(false);
    expect(BREP_ONLY_OPS.has("patternCircular")).toBe(false);
  });

  it("accepts midplaneFaces references (XOR with the inline plane vectors)", () => {
    expect(validateEditOp({ op: "mirror", targets: ["solid-0"], midplaneFaces: ["face-0", "face-1"] }))
      .toEqual({ op: "mirror", targets: ["solid-0"], midplaneFaces: ["face-0", "face-1"] });
    expect(validateEditOp({ op: "splitByPlane", targets: ["solid-0"], midplaneFaces: ["face-0", "face-1"], keep: "both" }))
      .toEqual({ op: "splitByPlane", targets: ["solid-0"], midplaneFaces: ["face-0", "face-1"], keep: "both" });
    expect(validateEditOp({ op: "section", targets: ["solid-0"], midplaneFaces: ["face-0", "face-1"] }))
      .toEqual({ op: "section", targets: ["solid-0"], midplaneFaces: ["face-0", "face-1"] });
  });

  it("rejects midplaneFaces mixed with inline plane vectors, or with bad id shapes", () => {
    expect(validateEditOp({ op: "mirror", targets: ["solid-0"], midplaneFaces: ["face-0", "face-1"], planePoint: [0, 0, 0], planeNormal: [0, 0, 1] })).toBeNull();
    expect(validateEditOp({ op: "mirror", targets: ["solid-0"], midplaneFaces: ["face-0", "edge-1"] })).toBeNull();
    expect(validateEditOp({ op: "mirror", targets: ["solid-0"], midplaneFaces: ["face-0"] })).toBeNull();
    expect(validateEditOp({ op: "mirror", targets: ["solid-0"], midplaneFaces: ["solid-0", "solid-1"] })).toBeNull();
    expect(validateEditOp({ op: "section", targets: ["solid-0"], midplaneFaces: ["face-0", "face-1"], planePoint: [0, 0, 0] })).toBeNull();
    // Neither form present → rejected
    expect(validateEditOp({ op: "mirror", targets: ["solid-0"] })).toBeNull();
  });

  it("accepts midaxisOf references (XOR with the inline axis pair)", () => {
    expect(validateEditOp({ op: "patternCircular", targets: ["solid-0"], midaxisOf: ["face-0", "face-1"], angleDeg: 60, count: 4 }))
      .toEqual({ op: "patternCircular", targets: ["solid-0"], midaxisOf: ["face-0", "face-1"], angleDeg: 60, count: 4 });
    expect(validateEditOp({ op: "patternCircular", targets: ["solid-0"], midaxisOf: ["edge-0", "edge-1"], angleDeg: 60, count: 4 }))
      .not.toBeNull();
  });

  it("rejects midaxisOf mixed with inline axis vectors, or mixed face/edge pairs", () => {
    expect(validateEditOp({ op: "patternCircular", targets: ["solid-0"], midaxisOf: ["face-0", "face-1"], axisPoint: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 60, count: 4 })).toBeNull();
    expect(validateEditOp({ op: "patternCircular", targets: ["solid-0"], midaxisOf: ["face-0", "edge-1"], angleDeg: 60, count: 4 })).toBeNull();
    expect(validateEditOp({ op: "patternCircular", targets: ["solid-0"], midaxisOf: ["solid-0", "solid-1"], angleDeg: 60, count: 4 })).toBeNull();
    expect(validateEditOp({ op: "patternCircular", targets: ["solid-0"], angleDeg: 60, count: 4 })).toBeNull(); // neither form
  });

  it("guide is accepted on the 16 guide kinds and rejected elsewhere / non-boolean", () => {
    expect(validateEditOp({ op: "addLine", start: [0, 0, 0], end: [1, 0, 0], guide: true }))
      .toEqual({ op: "addLine", start: [0, 0, 0], end: [1, 0, 0], guide: true });
    expect(validateEditOp({ op: "addCircleProfile", center: [0, 0, 0], normal: [0, 0, 1], radius: 2, guide: false }))
      .toEqual({ op: "addCircleProfile", center: [0, 0, 0], normal: [0, 0, 1], radius: 2, guide: false });
    expect(validateEditOp({ op: "addLine", start: [0, 0, 0], end: [1, 0, 0], guide: "yes" })).toBeNull();
    expect(validateEditOp({ op: "addBox", center: [0, 0, 0], size: [1, 2, 3], guide: true })).toBeNull();
  });

  it("GUIDE_KINDS covers exactly the 16 profile/curve creation kinds", () => {
    expect(GUIDE_KINDS.size).toBe(16);
    for (const kind of GUIDE_KINDS) expect(BREP_ONLY_OPS.has(kind)).toBe(true);
  });
});
