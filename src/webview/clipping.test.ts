import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { planeForAxis, capCenterAndSize } from "./clipping";

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

describe("capCenterAndSize", () => {
  it("centres on the box centre, projected onto the plane, for a plane through the box centre", () => {
    const plane = planeForAxis("x", 0, box);
    const { center } = capCenterAndSize(plane, box);
    expect(center.toArray()).toEqual([0, 0, 0]); // box centre is already on this plane
  });

  it("projects the box centre onto an off-centre plane along the plane's own normal", () => {
    const plane = planeForAxis("x", 1, box); // x = 2 plane
    const { center } = capCenterAndSize(plane, box);
    // x snaps onto the plane; y/z stay at the box centre's own coordinates
    expect(center.x).toBeCloseTo(2, 6);
    expect(center.y).toBeCloseTo(0, 6);
    expect(center.z).toBeCloseTo(0, 6);
    expect(plane.distanceToPoint(center)).toBeCloseTo(0, 6); // genuinely on the plane
  });

  it("is unaffected by the box being far from the world origin", () => {
    const farBox = box.clone().translate(new THREE.Vector3(1000, -1000, 500));
    const plane = planeForAxis("x", 1, farBox);
    const { center } = capCenterAndSize(plane, farBox);
    // Would be nowhere near the model if centred on the plane's closest point to
    // the origin instead of the box's own centre — assert it tracks the box.
    const farCenter = farBox.getCenter(new THREE.Vector3());
    expect(center.distanceTo(farCenter)).toBeLessThan(farBox.getSize(new THREE.Vector3()).length());
  });

  it("sizes to the box's full 3D diagonal", () => {
    const plane = planeForAxis("z", 0, box);
    const { size } = capCenterAndSize(plane, box);
    expect(size).toBeCloseTo(box.getSize(new THREE.Vector3()).length(), 6);
  });
});
