import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { faceNormalToDirection, snapDirectionFromHit } from "./orientationCube";

describe("snapDirectionFromHit", () => {
  it("face centres give the 6 axis views", () => {
    expect(snapDirectionFromHit(new THREE.Vector3(0.5, 0.05, -0.1)).toArray()).toEqual([1, 0, 0]);
    expect(snapDirectionFromHit(new THREE.Vector3(0.1, -0.5, 0.0)).toArray()).toEqual([0, -1, 0]);
  });
  it("edge strips give the 12 edge views, normalised", () => {
    const d = snapDirectionFromHit(new THREE.Vector3(0.5, 0.45, 0.0));
    expect(d.x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(d.y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(d.z).toBe(0);
  });
  it("corners give the 8 corner views", () => {
    const d = snapDirectionFromHit(new THREE.Vector3(-0.48, 0.5, 0.46));
    for (const [got, want] of [[d.x, -1], [d.y, 1], [d.z, 1]]) expect(got).toBeCloseTo(want / Math.sqrt(3), 12);
  });
  it("covers exactly 26 distinct directions over a surface sweep", () => {
    const seen = new Set<string>();
    const steps = [-0.5, -0.4, 0, 0.4, 0.5];
    for (const a of steps) for (const b of steps) for (const axis of [0, 1, 2]) for (const s of [-0.5, 0.5]) {
      const p = [a, b, 0]; const v = [p[0], p[1], s]; const q = new THREE.Vector3(...[0, 1, 2].map((i) => v[(i + axis) % 3]));
      seen.add(snapDirectionFromHit(q).toArray().map((x) => x.toFixed(6)).join());
    }
    expect(seen.size).toBe(26);
  });
});

describe("faceNormalToDirection", () => {
  const cases: Array<[THREE.Vector3, [number, number, number]]> = [
    [new THREE.Vector3(1, 0, 0), [1, 0, 0]],
    [new THREE.Vector3(-1, 0, 0), [-1, 0, 0]],
    [new THREE.Vector3(0, 1, 0), [0, 1, 0]],
    [new THREE.Vector3(0, -1, 0), [0, -1, 0]],
    [new THREE.Vector3(0, 0, 1), [0, 0, 1]],
    [new THREE.Vector3(0, 0, -1), [0, 0, -1]],
  ];

  it.each(cases)("maps %o to the dominant axis", (normal, expected) => {
    const dir = faceNormalToDirection(normal);
    expect([dir.x, dir.y, dir.z]).toEqual(expected);
  });

  it("snaps a slightly-off normal to the nearest axis", () => {
    const dir = faceNormalToDirection(new THREE.Vector3(0.05, 0.98, -0.1));
    expect([dir.x, dir.y, dir.z]).toEqual([0, 1, 0]);
  });
});
