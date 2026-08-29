import { describe, expect, it } from "vitest";
import { recognizePrimitive, inventoryOf, type FaceEntry } from "./primitiveRecognition";
import type { Vec3 } from "./primitiveSdf";

const plane = (id: string, origin: Vec3, normal: Vec3): FaceEntry => ({
  faceId: id,
  surfaceType: "plane",
  params: { kind: "plane", origin, normal },
});

/** The six faces of an axis-aligned box centred at the origin. */
const boxFaces = (sx: number, sy: number, sz: number): FaceEntry[] => [
  plane("face-0", [sx / 2, 0, 0], [1, 0, 0]),
  plane("face-1", [-sx / 2, 0, 0], [-1, 0, 0]),
  plane("face-2", [0, sy / 2, 0], [0, 1, 0]),
  plane("face-3", [0, -sy / 2, 0], [0, -1, 0]),
  plane("face-4", [0, 0, sz / 2], [0, 0, 1]),
  plane("face-5", [0, 0, -sz / 2], [0, 0, -1]),
];

const cylinderFaces = (radius: number, height: number): FaceEntry[] => [
  {
    faceId: "face-0",
    surfaceType: "cylinder",
    params: { kind: "cylinder", radius, axisLocation: [0, 0, 0], axisDirection: [0, 0, 1] },
  },
  plane("face-1", [0, 0, 0], [0, 0, -1]),
  plane("face-2", [0, 0, height], [0, 0, 1]),
];

describe("inventoryOf", () => {
  it("counts by surface type with every key present", () => {
    expect(inventoryOf(boxFaces(2, 2, 2))).toEqual({
      plane: 6, cylinder: 0, cone: 0, sphere: 0, torus: 0, other: 0,
    });
  });

  it("reports an all-zero inventory for no faces rather than an empty object", () => {
    // The shape must be stable so a caller can read `inventory.cylinder`
    // without a presence check.
    expect(inventoryOf([])).toEqual({ plane: 0, cylinder: 0, cone: 0, sphere: 0, torus: 0, other: 0 });
  });
});

describe("recognizePrimitive — sphere and torus", () => {
  it("recognizes a lone spherical face", () => {
    const p = recognizePrimitive([
      { faceId: "face-0", surfaceType: "sphere", params: { kind: "sphere", center: [1, 2, 3], radius: 5 } },
    ]);
    expect(p).toEqual({ kind: "sphere", center: [1, 2, 3], radius: 5 });
  });

  it("recognizes a lone toroidal face, keeping major and minor distinct", () => {
    const p = recognizePrimitive([
      {
        faceId: "face-0",
        surfaceType: "torus",
        params: { kind: "torus", axisLocation: [0, 0, 4], axisDirection: [1, 0, 0], majorRadius: 10, minorRadius: 2 },
      },
    ]);
    expect(p).toMatchObject({ kind: "torus", majorRadius: 10, minorRadius: 2, center: [0, 0, 4] });
  });

  it("does not recognize a sphere that has extra faces", () => {
    const faces: FaceEntry[] = [
      { faceId: "face-0", surfaceType: "sphere", params: { kind: "sphere", center: [0, 0, 0], radius: 5 } },
      plane("face-1", [0, 0, 0], [0, 0, 1]),
    ];
    // A cut hemisphere is not a sphere primitive — reporting one would be a guess.
    expect(recognizePrimitive(faces)).toBeNull();
  });
});

describe("recognizePrimitive — cylinder", () => {
  it("derives the height from the gap between the two caps", () => {
    const p = recognizePrimitive(cylinderFaces(3, 10));
    expect(p).toMatchObject({ kind: "cylinder", radius: 3, height: 10 });
    expect((p as { base: Vec3 }).base).toEqual([0, 0, 0]);
  });

  it("puts the base at the LOWER cap regardless of face order", () => {
    // Caps at z=4 and z=9 — the base must be z=4, not the first one listed.
    const faces: FaceEntry[] = [
      {
        faceId: "face-0",
        surfaceType: "cylinder",
        params: { kind: "cylinder", radius: 2, axisLocation: [0, 0, 0], axisDirection: [0, 0, 1] },
      },
      plane("face-1", [0, 0, 9], [0, 0, 1]),
      plane("face-2", [0, 0, 4], [0, 0, -1]),
    ];
    const p = recognizePrimitive(faces) as { base: Vec3; height: number };
    expect(p.base[2]).toBeCloseTo(4, 12);
    expect(p.height).toBeCloseTo(5, 12);
  });

  it("refuses when a cap is not perpendicular to the axis", () => {
    const faces = cylinderFaces(3, 10);
    faces[2] = plane("face-2", [0, 0, 10], [0, 1, 1]); // tilted cap
    expect(recognizePrimitive(faces)).toBeNull();
  });

  it("refuses a cylinder with three caps rather than guessing", () => {
    const faces = [...cylinderFaces(3, 10), plane("face-3", [0, 0, 5], [0, 0, 1])];
    expect(recognizePrimitive(faces)).toBeNull();
  });
});

describe("recognizePrimitive — cone", () => {
  const coneFace = (refRadius: number, semiAngleDeg: number): FaceEntry => ({
    faceId: "face-0",
    surfaceType: "cone",
    params: {
      kind: "cone",
      axisLocation: [0, 0, 0],
      axisDirection: [0, 0, 1],
      refRadius,
      apex: [0, 0, refRadius / Math.tan(Math.abs((semiAngleDeg * Math.PI) / 180))],
      semiAngleDeg,
    },
  });

  it("derives both radii of a truncated cone from its caps", () => {
    // refRadius 5 at z=0, narrowing at atan(3/4) => r=2 at z=4.
    const semi = -(Math.atan(3 / 4) * 180) / Math.PI;
    const faces: FaceEntry[] = [
      coneFace(5, semi),
      plane("face-1", [0, 0, 0], [0, 0, -1]),
      plane("face-2", [0, 0, 4], [0, 0, 1]),
    ];
    const p = recognizePrimitive(faces) as { radius1: number; radius2: number; height: number };
    expect(p.radius1).toBeCloseTo(5, 9);
    expect(p.radius2).toBeCloseTo(2, 9);
    expect(p.height).toBeCloseTo(4, 9);
  });

  it("accepts a sharp-tipped cone with a single cap", () => {
    const semi = -(Math.atan(5 / 10) * 180) / Math.PI;
    const faces: FaceEntry[] = [coneFace(5, semi), plane("face-1", [0, 0, 0], [0, 0, -1])];
    const p = recognizePrimitive(faces) as { radius1: number; radius2: number };
    expect(p).not.toBeNull();
    expect(p.radius1).toBeCloseTo(5, 6);
    expect(p.radius2).toBeCloseTo(0, 6);
  });
});

describe("recognizePrimitive — box", () => {
  it("recognizes an axis-aligned box and recovers its size and centre", () => {
    const p = recognizePrimitive(boxFaces(10, 4, 2)) as { size: Vec3; center: Vec3 };
    expect(p).not.toBeNull();
    expect([...p.size].sort((a, b) => a - b)).toEqual([2, 4, 10]);
    expect(p.center.map((c) => Math.abs(c) < 1e-12)).toEqual([true, true, true]);
  });

  it("recognizes a ROTATED box — it must not assume world-axis alignment", () => {
    const c = Math.SQRT1_2;
    const u: Vec3 = [c, c, 0];
    const v: Vec3 = [-c, c, 0];
    const w: Vec3 = [0, 0, 1];
    const faces: FaceEntry[] = [
      plane("face-0", [u[0] * 5, u[1] * 5, 0], u),
      plane("face-1", [-u[0] * 5, -u[1] * 5, 0], [-u[0], -u[1], -u[2]]),
      plane("face-2", [v[0] * 2, v[1] * 2, 0], v),
      plane("face-3", [-v[0] * 2, -v[1] * 2, 0], [-v[0], -v[1], -v[2]]),
      plane("face-4", [0, 0, 1], w),
      plane("face-5", [0, 0, -1], [0, 0, -1]),
    ];
    const p = recognizePrimitive(faces) as { size: Vec3 };
    expect(p).not.toBeNull();
    expect([...p.size].sort((a, b) => a - b)).toEqual([2, 4, 10]);
  });

  it("refuses five planar faces rather than calling them a box", () => {
    expect(recognizePrimitive(boxFaces(2, 2, 2).slice(0, 5))).toBeNull();
  });

  it("refuses six planes that are not three perpendicular pairs", () => {
    const faces = boxFaces(2, 2, 2);
    // Replace one pair member with a skew normal — no longer a box.
    faces[5] = plane("face-5", [0, 0, -1], [0.6, 0, -0.8]);
    expect(recognizePrimitive(faces)).toBeNull();
  });

  it("refuses a box with a filleted edge — the extra face makes it not that primitive", () => {
    // This is the honest answer: a filleted box IS NOT a box primitive. The
    // report still publishes the inventory, and the caller sees 6 planes + 1
    // cylinder.
    const faces: FaceEntry[] = [
      ...boxFaces(10, 10, 10),
      {
        faceId: "face-6",
        surfaceType: "cylinder",
        params: { kind: "cylinder", radius: 1, axisLocation: [4, 4, 0], axisDirection: [0, 0, 1] },
      },
    ];
    expect(recognizePrimitive(faces)).toBeNull();
  });
});

describe("recognizePrimitive — no candidate", () => {
  it("returns null for a free-form solid, without throwing", () => {
    const faces: FaceEntry[] = [
      { faceId: "face-0", surfaceType: "other", params: null },
      { faceId: "face-1", surfaceType: "other", params: null },
    ];
    expect(recognizePrimitive(faces)).toBeNull();
  });

  it("returns null for an empty face list", () => {
    expect(recognizePrimitive([])).toBeNull();
  });

  it("returns null when a face is classified but carries no parameters", () => {
    // surfaceType without surfaceParams (a parameter read that degraded).
    const faces: FaceEntry[] = [{ faceId: "face-0", surfaceType: "sphere", params: null }];
    expect(recognizePrimitive(faces)).toBeNull();
  });
});
