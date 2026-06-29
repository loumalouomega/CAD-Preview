import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { faceNormalToDirection } from "./orientationCube";

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
