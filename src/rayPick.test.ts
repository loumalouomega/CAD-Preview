import { describe, expect, it } from "vitest";
import { rayPick, type PickGeometry, type Vec3 } from "./rayPick";

/**
 * A unit cube from (0,0,0) to (1,1,1) as six single-quad faces, each a separate
 * `face-N` under one solid — the same shape `tessellateByGroup` produces.
 */
function cube(): PickGeometry {
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => ({
    positions: new Float32Array([...a, ...b, ...c, ...d]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
  return {
    groups: [
      {
        id: "solid-0",
        faces: [
          { faceId: "face-0", buffers: quad([0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]) }, // +Z front
          { faceId: "face-1", buffers: quad([0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]) }, // -Z back
          { faceId: "face-2", buffers: quad([0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]) }, // +Y top
          { faceId: "face-3", buffers: quad([0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]) }, // -Y bottom
          { faceId: "face-4", buffers: quad([1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]) }, // +X right
          { faceId: "face-5", buffers: quad([0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]) }, // -X left
        ],
      },
    ],
    edges: [{ edgeId: "edge-0", positions: new Float32Array([0, 1, 1, 1, 1, 1]) }], // top-front edge
    points: [{ pointId: "point-0", position: [0, 0, 0] }],
  };
}

describe("rayPick — faces", () => {
  it("hits the nearest face and reports where", () => {
    // Straight down the -Z axis at the middle of the front face.
    const hit = rayPick(cube(), [0.5, 0.5, 5], [0, 0, -1]);
    expect(hit?.entityId).toBe("face-0");
    expect(hit?.entityType).toBe("surface");
    expect(hit?.point[2]).toBeCloseTo(1, 6);
    expect(hit?.distance).toBeCloseTo(4, 6);
  });

  it("reports the NEAREST face, not merely the first one tested", () => {
    // Fired from -Z, the back face is nearer than the front one.
    const hit = rayPick(cube(), [0.5, 0.5, -5], [0, 0, 1]);
    expect(hit?.entityId).toBe("face-1");
    expect(hit?.point[2]).toBeCloseTo(0, 6);
  });

  it("reports a unit normal at the hit", () => {
    const hit = rayPick(cube(), [0.5, 0.5, 5], [0, 0, -1]);
    expect(Math.hypot(...(hit!.normal as Vec3))).toBeCloseTo(1, 6);
    expect(Math.abs(hit!.normal![2])).toBeCloseTo(1, 6); // the front face faces ±Z
  });

  it("carries the owning solid for a surface hit", () => {
    expect(rayPick(cube(), [0.5, 0.5, 5], [0, 0, -1])?.groupId).toBe("solid-0");
  });

  it("resolves up to the solid in volume mode, like the interactive picker", () => {
    const hit = rayPick(cube(), [0.5, 0.5, 5], [0, 0, -1], { mode: "volume" });
    expect(hit?.entityType).toBe("volume");
    expect(hit?.entityId).toBe("solid-0");
  });

  it("misses cleanly when the ray passes by", () => {
    expect(rayPick(cube(), [5, 5, 5], [0, 0, -1])).toBeNull();
  });

  it("ignores geometry behind the origin", () => {
    // Starting past the cube and firing away from it.
    expect(rayPick(cube(), [0.5, 0.5, -5], [0, 0, -1])).toBeNull();
  });

  it("does not need a normalized direction, and reports distance in model units", () => {
    const hit = rayPick(cube(), [0.5, 0.5, 5], [0, 0, -100]);
    expect(hit?.distance).toBeCloseTo(4, 6);
  });

  it("returns null for a degenerate direction rather than NaN", () => {
    expect(rayPick(cube(), [0.5, 0.5, 5], [0, 0, 0])).toBeNull();
  });

  it("hits a face from behind — a CAD face is double-sided", () => {
    // Fired from inside the cube outward.
    const hit = rayPick(cube(), [0.5, 0.5, 0.5], [0, 0, 1]);
    expect(hit?.entityId).toBe("face-0");
  });
});

describe("rayPick — focus and hide", () => {
  it("hide skips a face, revealing whatever is behind it", () => {
    const hit = rayPick(cube(), [0.5, 0.5, 5], [0, 0, -1], { hide: ["face-0"] });
    expect(hit?.entityId).toBe("face-1"); // the far side of the cube
  });

  it("focus restricts to the listed ids", () => {
    const hit = rayPick(cube(), [0.5, 0.5, 5], [0, 0, -1], { focus: ["face-1"] });
    expect(hit?.entityId).toBe("face-1");
  });

  it("focusing a SOLID keeps its faces", () => {
    expect(rayPick(cube(), [0.5, 0.5, 5], [0, 0, -1], { focus: ["solid-0"] })?.entityId).toBe("face-0");
  });

  it("hiding a solid hides its faces", () => {
    expect(rayPick(cube(), [0.5, 0.5, 5], [0, 0, -1], { hide: ["solid-0"] })).toBeNull();
  });
});

describe("rayPick — edges and points", () => {
  it("needs a tolerance: a zero-width line cannot be hit exactly", () => {
    expect(rayPick(cube(), [0.5, 1, 5], [0, 0, -1], { mode: "line" })).toBeNull();
    expect(rayPick(cube(), [0.5, 1, 5], [0, 0, -1], { mode: "line", tolerance: 0.1 })?.entityId).toBe("edge-0");
  });

  it("misses an edge outside the tolerance", () => {
    // The top-front edge runs along y=1,z=1; pass well below it.
    expect(rayPick(cube(), [0.5, 0.5, 5], [0, 0, -1], { mode: "line", tolerance: 0.01 })).toBeNull();
  });

  it("hits a point within tolerance", () => {
    const hit = rayPick(cube(), [0, 0, 5], [0, 0, -1], { mode: "point", tolerance: 0.1 });
    expect(hit?.entityId).toBe("point-0");
    expect(hit?.point).toEqual([0, 0, 0]);
  });

  it("in `any` mode the nearest of face/edge/point wins", () => {
    // Aimed at the front face's middle: the face is much nearer than the point
    // at the far corner, so the face must win even with a generous tolerance.
    const hit = rayPick(cube(), [0.5, 0.5, 5], [0, 0, -1], { mode: "any", tolerance: 1 });
    expect(hit?.entityType).toBe("surface");
  });
});
