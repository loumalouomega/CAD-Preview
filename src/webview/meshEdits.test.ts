import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { applyEditsMesh, transformMatrixForOp } from "./meshEdits";
import type { EditOp } from "../editOps";

function point(m: THREE.Matrix4, x: number, y: number, z: number): [number, number, number] {
  const v = new THREE.Vector3(x, y, z).applyMatrix4(m);
  return [round(v.x), round(v.y), round(v.z)];
}
const round = (n: number) => Math.round(n * 1e6) / 1e6;

describe("transformMatrixForOp", () => {
  it("translate moves a point by the vector", () => {
    const m = transformMatrixForOp({ op: "translate", targets: ["node-0"], vec: [1, 2, 3] })!;
    expect(point(m, 0, 0, 0)).toEqual([1, 2, 3]);
  });

  it("rotate 90° about Z through origin maps +X to +Y", () => {
    const m = transformMatrixForOp({
      op: "rotate", targets: ["node-0"], axisPoint: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 90,
    })!;
    expect(point(m, 1, 0, 0)).toEqual([0, 1, 0]);
  });

  it("rotate about a non-origin point conjugates correctly", () => {
    const m = transformMatrixForOp({
      op: "rotate", targets: ["node-0"], axisPoint: [1, 0, 0], axisDir: [0, 0, 1], angleDeg: 90,
    })!;
    // The axis point itself is fixed.
    expect(point(m, 1, 0, 0)).toEqual([1, 0, 0]);
  });

  it("scale about center keeps the center fixed and scales offsets", () => {
    const m = transformMatrixForOp({
      op: "scale", targets: ["node-0"], center: [2, 0, 0], factors: [3, 1, 1],
    })!;
    expect(point(m, 2, 0, 0)).toEqual([2, 0, 0]);
    expect(point(m, 3, 0, 0)).toEqual([5, 0, 0]); // offset 1 → 3
  });

  it("mirror across the YZ plane (normal +X) negates X", () => {
    const m = transformMatrixForOp({
      op: "mirror", targets: ["node-0"], planePoint: [0, 0, 0], planeNormal: [1, 0, 0],
    })!;
    expect(point(m, 5, 2, 1)).toEqual([-5, 2, 1]);
  });

  it("returns null for non-transform ops", () => {
    expect(transformMatrixForOp({ op: "explode", factor: 1 })).toBeNull();
  });
});

describe("applyEditsMesh", () => {
  function taggedMesh(): THREE.Object3D {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    root.add(mesh);
    let i = 0;
    root.traverse((o) => { o.userData.groupId = `node-${i++}`; });
    return root;
  }

  it("translates only the targeted node", () => {
    const root = taggedMesh();
    const mesh = root.children[0];
    const ops: EditOp[] = [{ op: "translate", targets: ["node-1"], vec: [10, 0, 0] }];
    applyEditsMesh(root, ops);
    mesh.updateMatrixWorld(true);
    expect(round(mesh.getWorldPosition(new THREE.Vector3()).x)).toBe(10);
  });

  it("skips B-rep-only ops on meshes without throwing", () => {
    const root = taggedMesh();
    expect(() => applyEditsMesh(root, [{ op: "fillet", edges: ["edge-0"], radius: 1 }])).not.toThrow();
  });
});

describe("applyEditsMesh booleans (three-bvh-csg)", () => {
  function twoBoxes(): THREE.Object3D {
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)); // centred at origin
    const b = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    b.position.set(1, 1, 1);
    root.add(a, b);
    let i = 0;
    root.traverse((o) => { o.userData.groupId = `node-${i++}`; });
    return root;
  }

  it("unite replaces both operands with a single result mesh", () => {
    const root = twoBoxes();
    applyEditsMesh(root, [{ op: "boolean", kind: "union", a: ["node-1"], b: ["node-2"] }]);
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    expect(meshes).toHaveLength(1);
    expect(meshes[0].userData.groupId).toBe("node-1");
    expect(meshes[0].geometry.getAttribute("position").count).toBeGreaterThan(0);
  });

  it("skips a boolean whose operands do not resolve", () => {
    const root = twoBoxes();
    applyEditsMesh(root, [{ op: "boolean", kind: "subtract", a: ["node-9"], b: ["node-2"] }]);
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    expect(meshes).toHaveLength(2); // unchanged
  });
});

describe("applyEditsMesh explode", () => {
  function twoSeparatedBoxes(): THREE.Object3D {
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)); a.position.set(-5, 0, 0);
    const b = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)); b.position.set(5, 0, 0);
    root.add(a, b);
    let i = 0; root.traverse((o) => { o.userData.groupId = `node-${i++}`; });
    return root;
  }

  it("spreads bodies radially from the model centre by factor", () => {
    const root = twoSeparatedBoxes();
    const [a, b] = root.children;
    applyEditsMesh(root, [{ op: "explode", factor: 1 }]);
    root.updateMatrixWorld(true);
    // Centre is x=0; factor 1 doubles each offset: -5 → -10, +5 → +10.
    expect(Math.round(a.getWorldPosition(new THREE.Vector3()).x)).toBe(-10);
    expect(Math.round(b.getWorldPosition(new THREE.Vector3()).x)).toBe(10);
  });
});
