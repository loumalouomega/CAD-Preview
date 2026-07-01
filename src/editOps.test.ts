import { describe, it, expect } from "vitest";
import { validateEditOp, BREP_ONLY_OPS, TOPOLOGY_CHANGING_OPS } from "./editOps";

describe("validateEditOp", () => {
  it("accepts well-formed transform ops", () => {
    expect(validateEditOp({ op: "translate", targets: ["solid-0"], vec: [1, 2, 3] }))
      .toEqual({ op: "translate", targets: ["solid-0"], vec: [1, 2, 3] });
    expect(validateEditOp({ op: "scale", targets: ["solid-0"], center: [0, 0, 0], factors: [2, 1, 1] }))
      .toMatchObject({ op: "scale" });
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

  it("2D profile ops are topology-changing, B-rep only", () => {
    for (const kind of ["addCircleProfile", "addRectangleProfile", "addPolygonProfile"] as const) {
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
