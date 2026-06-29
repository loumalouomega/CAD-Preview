import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { meshFromGeometry } from "./viewer";

function triangleGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geometry;
}

describe("meshFromGeometry", () => {
  it("computes vertex normals when the geometry has none", () => {
    const geometry = triangleGeometry();
    expect(geometry.getAttribute("normal")).toBeUndefined();

    const mesh = meshFromGeometry(geometry);

    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.geometry.getAttribute("normal")).toBeDefined();
    expect(mesh.material).toBeInstanceOf(THREE.MeshStandardMaterial);
  });

  it("preserves existing normals", () => {
    const geometry = triangleGeometry();
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));

    const mesh = meshFromGeometry(geometry);

    expect(mesh.geometry.getAttribute("normal").array).toEqual(normals);
  });
});
