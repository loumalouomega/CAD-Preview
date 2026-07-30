import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { planeForAxis } from "./clipping";

const box = new THREE.Box3(new THREE.Vector3(-2, -4, -6), new THREE.Vector3(2, 4, 6));

describe("planeForAxis", () => {
  it("passes through the box centre at offset 0", () => {
    const plane = planeForAxis("x", 0, box);
    expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 0))).toBeCloseTo(0, 6);
  });

  it("lands on the max face at offset 1, and the min face at offset -1", () => {
    const px = planeForAxis("x", 1, box);
    expect(plane_distanceAt(px, [2, 0, 0])).toBeCloseTo(0, 6);
    const nx = planeForAxis("x", -1, box);
    expect(plane_distanceAt(nx, [-2, 0, 0])).toBeCloseTo(0, 6);
  });

  it("clamps offsets outside [-1, 1] to the box faces", () => {
    const over = planeForAxis("y", 5, box);
    expect(plane_distanceAt(over, [0, 4, 0])).toBeCloseTo(0, 6);
    const under = planeForAxis("y", -5, box);
    expect(plane_distanceAt(under, [0, -4, 0])).toBeCloseTo(0, 6);
  });

  it("the normal points in the positive axis direction, one axis at a time", () => {
    expect(planeForAxis("x", 0, box).normal.toArray()).toEqual([1, 0, 0]);
    expect(planeForAxis("y", 0, box).normal.toArray()).toEqual([0, 1, 0]);
    expect(planeForAxis("z", 0, box).normal.toArray()).toEqual([0, 0, 1]);
  });

  it("keeps the positive-axis side (distance >= 0) at the box's min face", () => {
    // offset -1 -> plane at min face; the box's max-axis point should be kept (positive distance)
    const plane = planeForAxis("x", -1, box);
    expect(plane.distanceToPoint(new THREE.Vector3(2, 0, 0))).toBeGreaterThan(0);
  });
});

function plane_distanceAt(plane: THREE.Plane, point: [number, number, number]): number {
  return plane.distanceToPoint(new THREE.Vector3(...point));
}
