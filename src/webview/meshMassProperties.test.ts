import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { computeMeshMassProperties } from "./meshMassProperties";

function closeTo(actual: number, expected: number, eps = 1e-6): void {
  expect(Math.abs(actual - expected)).toBeLessThan(eps);
}

function closeVec(actual: [number, number, number], expected: [number, number, number], eps = 1e-6): void {
  for (let i = 0; i < 3; i++) closeTo(actual[i], expected[i], eps);
}

describe("computeMeshMassProperties", () => {
  it("computes volume/area/centroid for a unit cube at the origin", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const { volume, area, volumeCentroid, areaCentroid } = computeMeshMassProperties([mesh]);
    closeTo(volume, 1);
    closeTo(area, 6);
    closeVec(volumeCentroid, [0, 0, 0]);
    closeVec(areaCentroid, [0, 0, 0]);
  });

  it("applies the mesh's world transform (translation)", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(2, 3, 4);
    const { volume, area, volumeCentroid } = computeMeshMassProperties([mesh]);
    closeTo(volume, 1);
    closeTo(area, 6);
    closeVec(volumeCentroid, [2, 3, 4]);
  });

  it("applies rotation (volume/area are transform-invariant, centroid moves)", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(5, 0, 0);
    mesh.rotation.set(0, Math.PI / 4, 0);
    const { volume, area, volumeCentroid } = computeMeshMassProperties([mesh]);
    closeTo(volume, 1);
    closeTo(area, 6);
    closeVec(volumeCentroid, [5, 0, 0]);
  });

  it("computes a non-cube box's volume/area exactly", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1));
    const { volume, area } = computeMeshMassProperties([mesh]);
    closeTo(volume, 2);
    closeTo(area, 2 * (2 * 1 + 1 * 1 + 1 * 2));
  });

  it("sums multiple meshes together (e.g. every facet of one volume pick)", () => {
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    a.position.set(-5, 0, 0);
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    b.position.set(5, 0, 0);
    const { volume, area, volumeCentroid } = computeMeshMassProperties([a, b]);
    closeTo(volume, 2);
    closeTo(area, 12);
    closeVec(volumeCentroid, [0, 0, 0]);
  });

  it("returns zero volume for an empty mesh list", () => {
    const { volume, area } = computeMeshMassProperties([]);
    expect(volume).toBe(0);
    expect(area).toBe(0);
  });
});
