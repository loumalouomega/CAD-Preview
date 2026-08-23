import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { applyEditsMesh, transformMatrixForOp } from "./meshEdits";
import type { EditOp, OpOutcome } from "../editOps";

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

describe("applyEditsMesh align", () => {
  function boxAt(x: number, y: number, z: number): THREE.Object3D {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)); // extents ±1 before placement
    mesh.position.set(x, y, z);
    root.add(mesh);
    let i = 0;
    root.traverse((o) => { o.userData.groupId = `node-${i++}`; });
    return root;
  }

  it("aligns the min extent along z to the target coordinate", () => {
    const root = boxAt(0, 0, 5); // box spans z: 4..6
    applyEditsMesh(root, [{ op: "align", targets: ["node-1"], axis: "z", extent: "min", to: 0 }]);
    const box = new THREE.Box3().setFromObject(root.children[0]);
    expect(round(box.min.z)).toBe(0);
    expect(round(box.max.z)).toBe(2);
  });

  it("aligns the center extent along x, leaving y/z untouched", () => {
    const root = boxAt(3, 7, 9);
    applyEditsMesh(root, [{ op: "align", targets: ["node-1"], axis: "x", extent: "center", to: 0 }]);
    const box = new THREE.Box3().setFromObject(root.children[0]);
    const center = box.getCenter(new THREE.Vector3());
    expect(round(center.x)).toBe(0);
    expect(round(center.y)).toBe(7);
    expect(round(center.z)).toBe(9);
  });

  it("is a no-op for an unresolved target", () => {
    const root = boxAt(0, 0, 5);
    expect(() =>
      applyEditsMesh(root, [{ op: "align", targets: ["node-9"], axis: "z", extent: "min", to: 0 }])
    ).not.toThrow();
    const box = new THREE.Box3().setFromObject(root.children[0]);
    expect(round(box.min.z)).toBe(4);
  });
});

describe("applyEditsMesh patterns", () => {
  function singleBox(): THREE.Object3D {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    root.add(mesh);
    let i = 0;
    root.traverse((o) => { o.userData.groupId = `node-${i++}`; });
    return root;
  }

  function centers(root: THREE.Object3D): [number, number, number][] {
    const out: [number, number, number][] = [];
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const box = new THREE.Box3().setFromObject(o);
        const c = box.getCenter(new THREE.Vector3());
        out.push([round(c.x) || 0, round(c.y) || 0, round(c.z) || 0]); // `|| 0` folds -0 to 0
      }
    });
    return out;
  }

  it("patternLinear produces `count` total instances, evenly spaced, original untouched", () => {
    const root = singleBox();
    applyEditsMesh(root, [{ op: "patternLinear", targets: ["node-1"], direction: [1, 0, 0], spacing: 5, count: 4 }]);
    const cs = centers(root).sort((a, b) => a[0] - b[0]);
    expect(cs).toEqual([[0, 0, 0], [5, 0, 0], [10, 0, 0], [15, 0, 0]]);
  });

  it("patternLinear tags copies with unique pattern-{K} ids, never reusing the original's node id", () => {
    const root = singleBox();
    applyEditsMesh(root, [{ op: "patternLinear", targets: ["node-1"], direction: [1, 0, 0], spacing: 1, count: 3 }]);
    const ids: string[] = [];
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) ids.push(o.userData.groupId as string); });
    expect(ids).toEqual(["node-1", "pattern-0", "pattern-1"]);
  });

  it("patternCircular produces `count` total instances evenly spaced around the axis", () => {
    const root = singleBox();
    const boxDistance = 4;
    root.children[0].position.set(boxDistance, 0, 0);
    applyEditsMesh(root, [
      { op: "patternCircular", targets: ["node-1"], axisPoint: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 90, count: 4 },
    ]);
    const cs = centers(root);
    expect(cs).toHaveLength(4);
    // Every copy stays the same distance from the rotation axis.
    for (const [x, y] of cs) expect(round(Math.hypot(x, y))).toBe(boxDistance);
    // 90° apart each: (4,0) -> (0,4) -> (-4,0) -> (0,-4).
    expect(cs).toContainEqual([boxDistance, 0, 0]);
    expect(cs).toContainEqual([0, boxDistance, 0]);
    expect(cs).toContainEqual([-boxDistance, 0, 0]);
    expect(cs).toContainEqual([0, -boxDistance, 0]);
  });

  it("is a no-op for an unresolved target", () => {
    const root = singleBox();
    expect(() =>
      applyEditsMesh(root, [{ op: "patternLinear", targets: ["node-9"], direction: [1, 0, 0], spacing: 1, count: 3 }])
    ).not.toThrow();
    expect(centers(root)).toHaveLength(1);
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

describe("applyEditsMesh primitives", () => {
  function emptyRoot(): THREE.Object3D {
    return new THREE.Group();
  }

  function firstPrim(root: THREE.Object3D): THREE.Mesh {
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    expect(meshes).toHaveLength(1);
    return meshes[0];
  }

  it("addBox places a box centred at `center` with the given size", () => {
    const root = emptyRoot();
    applyEditsMesh(root, [{ op: "addBox", center: [1, 2, 3], size: [2, 4, 6] }]);
    const mesh = firstPrim(root);
    expect(mesh.userData.groupId).toBe("prim-0");
    const box = new THREE.Box3().setFromObject(mesh);
    expect([box.min.x, box.min.y, box.min.z].map(round)).toEqual([0, 0, 0]);
    expect([box.max.x, box.max.y, box.max.z].map(round)).toEqual([2, 4, 6]);
  });

  it("addSphere places a sphere centred at `center` with the given radius", () => {
    const root = emptyRoot();
    applyEditsMesh(root, [{ op: "addSphere", center: [0, 0, 0], radius: 5 }]);
    const box = new THREE.Box3().setFromObject(firstPrim(root));
    expect(box.min.x).toBeCloseTo(-5, 1);
    expect(box.max.x).toBeCloseTo(5, 1);
  });

  it("addCylinder along the canonical +Y axis: base at `center`, extends `height` up", () => {
    const root = emptyRoot();
    applyEditsMesh(root, [{ op: "addCylinder", center: [0, 0, 0], axis: [0, 1, 0], radius: 2, height: 10 }]);
    const box = new THREE.Box3().setFromObject(firstPrim(root));
    expect(box.min.y).toBeCloseTo(0, 1);
    expect(box.max.y).toBeCloseTo(10, 1);
    expect(box.min.x).toBeCloseTo(-2, 1);
    expect(box.max.x).toBeCloseTo(2, 1);
  });

  it("addCylinder along a non-canonical axis (+X): the single highest-risk placement case", () => {
    const root = emptyRoot();
    applyEditsMesh(root, [{ op: "addCylinder", center: [0, 0, 0], axis: [1, 0, 0], radius: 2, height: 10 }]);
    const box = new THREE.Box3().setFromObject(firstPrim(root));
    // Base at x=0, extending to x=10 — NOT vertically centred on x=0 (that would
    // indicate the base→centre translation was skipped or applied pre-rotation).
    expect(box.min.x).toBeCloseTo(0, 1);
    expect(box.max.x).toBeCloseTo(10, 1);
    expect(box.min.y).toBeCloseTo(-2, 1);
    expect(box.max.y).toBeCloseTo(2, 1);
    expect(box.min.z).toBeCloseTo(-2, 1);
    expect(box.max.z).toBeCloseTo(2, 1);
  });

  it("addCone: base radius1 at `center`, top radius2 at `center + axis*height`", () => {
    const root = emptyRoot();
    applyEditsMesh(root, [{ op: "addCone", center: [0, 0, 0], axis: [0, 0, 1], radius1: 5, radius2: 0, height: 10 }]);
    const box = new THREE.Box3().setFromObject(firstPrim(root));
    expect(box.min.z).toBeCloseTo(0, 1);
    expect(box.max.z).toBeCloseTo(10, 1);
    expect(box.min.x).toBeCloseTo(-5, 1); // base radius, not the (zero) top radius
    expect(box.max.x).toBeCloseTo(5, 1);
  });

  it("addTorus: ring centred at `center`, normal along a tilted `axis`", () => {
    const root = emptyRoot();
    applyEditsMesh(root, [{ op: "addTorus", center: [0, 0, 0], axis: [1, 0, 0], majorRadius: 5, minorRadius: 1 }]);
    const box = new THREE.Box3().setFromObject(firstPrim(root));
    // Ring normal along +X ⇒ thin along X (± minorRadius), wide in Y/Z (± majorRadius+minorRadius).
    expect(box.min.x).toBeCloseTo(-1, 1);
    expect(box.max.x).toBeCloseTo(1, 1);
    expect(box.min.y).toBeCloseTo(-6, 1);
    expect(box.max.y).toBeCloseTo(6, 1);
  });

  it("addPrism: N-sided cross-section, base at `center`, extruded along `axis`", () => {
    const root = emptyRoot();
    applyEditsMesh(root, [{ op: "addPrism", center: [0, 0, 0], axis: [0, 0, 1], radius: 5, sides: 6, height: 10 }]);
    const mesh = firstPrim(root);
    expect((mesh.geometry as THREE.CylinderGeometry).parameters.radialSegments).toBe(6);
    const box = new THREE.Box3().setFromObject(mesh);
    expect(box.min.z).toBeCloseTo(0, 1);
    expect(box.max.z).toBeCloseTo(10, 1);
  });

  it("assigns sequential prim-N ids by op-list position, stable across repeated replay", () => {
    const ops: EditOp[] = [
      { op: "addBox", center: [0, 0, 0], size: [1, 1, 1] },
      { op: "addSphere", center: [5, 0, 0], radius: 1 },
    ];
    const ids1 = idsOf(applyEditsMesh(emptyRoot(), ops));
    const ids2 = idsOf(applyEditsMesh(emptyRoot(), ops)); // fresh root, same list
    expect(ids1).toEqual(["prim-0", "prim-1"]);
    expect(ids2).toEqual(ids1);
  });

  it("a later op in the same fold pass can reference a primitive created earlier in the list", () => {
    const root = emptyRoot();
    const ops: EditOp[] = [
      { op: "addBox", center: [0, 0, 0], size: [2, 2, 2] },
      { op: "translate", targets: ["prim-0"], vec: [10, 0, 0] },
    ];
    applyEditsMesh(root, ops);
    const box = new THREE.Box3().setFromObject(firstPrim(root));
    // Box centred at (0,0,0) size 2 → [-1,1]; translated +10 → [9,11].
    expect(box.min.x).toBeCloseTo(9, 1);
    expect(box.max.x).toBeCloseTo(11, 1);
  });

  function idsOf(root: THREE.Object3D): string[] {
    const ids: string[] = [];
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) ids.push(o.userData.groupId as string); });
    return ids;
  }
});

describe("applyEditsMesh holes (three-bvh-csg)", () => {
  function boxRoot(size = 10): THREE.Object3D {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size));
    root.add(mesh);
    let i = 0;
    root.traverse((o) => { o.userData.groupId = `node-${i++}`; });
    return root;
  }

  function onlyMesh(root: THREE.Object3D): THREE.Mesh {
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    expect(meshes).toHaveLength(1);
    return meshes[0];
  }

  /** Signed-tetrahedra volume of a closed triangle mesh (world-space via matrixWorld). */
  function volumeOf(mesh: THREE.Mesh): number {
    mesh.updateWorldMatrix(true, false);
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const idx = geo.index;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    let v = 0;
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(mesh.matrixWorld);
      v += a.dot(b.clone().cross(c)) / 6;
    }
    return Math.abs(v);
  }

  it("addHole punches a through-hole (volume drops by ≈ π r² · depth)", () => {
    const root = boxRoot(10); // 10³ = 1000, centred at origin
    applyEditsMesh(root, [{
      op: "addHole", targets: ["node-1"], position: [0, 0, 5], axis: [0, 0, -1], radius: 2, depth: 10,
    }]);
    const result = onlyMesh(root);
    expect(result.userData.groupId).toBe("node-1"); // keeps the target's id
    const vol = volumeOf(result);
    // 1000 − (32-gon of r=2 area ≈ 12.49) × 10 ≈ 875
    expect(vol).toBeGreaterThan(860);
    expect(vol).toBeLessThan(890);
    // bbox untouched — the hole is internal
    const box = new THREE.Box3().setFromObject(result);
    expect(box.min.z).toBeCloseTo(-5, 1);
    expect(box.max.z).toBeCloseTo(5, 1);
  });

  it("addCounterboreHole on a tilted (−X) axis removes the extra mouth bore", () => {
    const root = boxRoot(10);
    applyEditsMesh(root, [{
      op: "addCounterboreHole", targets: ["node-1"], position: [5, 0, 0], axis: [-1, 0, 0],
      radius: 1, depth: 10, cbRadius: 2, cbDepth: 2,
    }]);
    const vol = volumeOf(onlyMesh(root));
    // 1000 − (r=1 32-gon ≈ 3.12)·10 − ((r=2 area ≈ 12.49) − 3.12)·2 ≈ 950
    expect(vol).toBeGreaterThan(940);
    expect(vol).toBeLessThan(960);
  });

  it("addCountersinkHole removes more material than the plain hole", () => {
    const plain = boxRoot(10);
    applyEditsMesh(plain, [{
      op: "addHole", targets: ["node-1"], position: [0, 0, 5], axis: [0, 0, -1], radius: 2, depth: 10,
    }]);
    const sunk = boxRoot(10);
    applyEditsMesh(sunk, [{
      op: "addCountersinkHole", targets: ["node-1"], position: [0, 0, 5], axis: [0, 0, -1],
      radius: 2, depth: 10, csRadius: 3, csAngleDeg: 90,
    }]);
    expect(volumeOf(onlyMesh(sunk))).toBeLessThan(volumeOf(onlyMesh(plain)));
  });

  it("holes never consume a prim-{K} id (dispatch-order regression)", () => {
    const root = boxRoot(10);
    applyEditsMesh(root, [
      { op: "addBox", center: [50, 0, 0], size: [1, 1, 1] },
      { op: "addHole", targets: ["node-1"], position: [0, 0, 5], axis: [0, 0, -1], radius: 2, depth: 10 },
      { op: "addSphere", center: [60, 0, 0], radius: 1 },
    ]);
    const ids: string[] = [];
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) ids.push(o.userData.groupId as string); });
    ids.sort();
    // box → prim-0, sphere → prim-1 (NOT prim-2), hole result keeps node-1
    expect(ids).toEqual(["node-1", "prim-0", "prim-1"]);
  });

  it("skips a hole whose target does not resolve", () => {
    const root = boxRoot(10);
    applyEditsMesh(root, [{
      op: "addHole", targets: ["node-99"], position: [0, 0, 5], axis: [0, 0, -1], radius: 2, depth: 10,
    }]);
    expect(volumeOf(onlyMesh(root))).toBeCloseTo(1000, 0); // unchanged
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

describe("applyEditsMesh outcome reporting", () => {
  function taggedMesh(): THREE.Object3D {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    root.add(mesh);
    let i = 0;
    root.traverse((o) => { o.userData.groupId = `node-${i++}`; });
    return root;
  }
  const collect = (root: THREE.Object3D, ops: EditOp[]): OpOutcome[] => {
    const outcomes: OpOutcome[] = [];
    applyEditsMesh(root, ops, outcomes);
    return outcomes;
  };

  it("a valid op reports applied: true", () => {
    const outcomes = collect(taggedMesh(), [{ op: "translate", targets: ["node-1"], vec: [1, 0, 0] }]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ index: 0, kind: "translate", applied: true });
  });

  it("a B-rep-only op reports not-applied with a diagnostic (never silent)", () => {
    const outcomes = collect(taggedMesh(), [{ op: "fillet", edges: ["edge-0"], radius: 1 }]);
    expect(outcomes[0].applied).toBe(false);
    expect(outcomes[0].diagnostic).toMatch(/B-rep only/);
  });

  it("an unresolved transform target reports not-applied with a hint", () => {
    const outcomes = collect(taggedMesh(), [{ op: "translate", targets: ["node-9"], vec: [1, 0, 0] }]);
    expect(outcomes[0].applied).toBe(false);
    expect(outcomes[0].diagnostic).toMatch(/node-9/);
    expect(outcomes[0].hint).toBeTruthy();
  });

  it("an unresolved boolean operand reports not-applied", () => {
    const root = taggedMesh();
    const outcomes = collect(root, [
      { op: "addBox", center: [5, 5, 5], size: [2, 2, 2] },
      { op: "boolean", kind: "union", a: ["node-9"], b: ["node-1"] },
    ]);
    expect(outcomes[0].applied).toBe(true);
    expect(outcomes[1].applied).toBe(false);
    expect(outcomes[1].diagnostic).toMatch(/operand|resolve/i);
  });

  it("an unresolved hole target reports not-applied", () => {
    const outcomes = collect(taggedMesh(), [{
      op: "addHole", targets: ["node-9"], position: [0, 0, 1], axis: [0, 0, -1], radius: 0.3, depth: 3,
    } as EditOp]);
    expect(outcomes[0].applied).toBe(false);
  });

  it("an align that moves nothing reports not-applied; a real move reports applied", () => {
    const alreadyThere = collect(taggedMesh(), [{ op: "align", targets: ["node-1"], axis: "y", extent: "min", to: -0.5 }]);
    expect(alreadyThere[0].applied).toBe(false); // box's min y is already -0.5
    const moved = collect(taggedMesh(), [{ op: "align", targets: ["node-1"], axis: "y", extent: "min", to: 10 }]);
    expect(moved[0].applied).toBe(true);
  });

  it("a pattern whose count is 1 adds no copies and reports not-applied", () => {
    const outcomes = collect(taggedMesh(), [{ op: "patternLinear", targets: ["node-1"], direction: [1, 0, 0], spacing: 5, count: 1 }]);
    expect(outcomes[0].applied).toBe(false);
    expect(outcomes[0].diagnostic).toMatch(/no copies/);
    expect(outcomes[0].hint).toMatch(/count/i);
  });

  it("outcomes carry stable indexes matching their op positions", () => {
    const ops: EditOp[] = [
      { op: "translate", targets: ["node-1"], vec: [1, 0, 0] },
      { op: "fillet", edges: ["edge-0"], radius: 1 },
      { op: "explode", factor: 0.5 },
    ];
    const outcomes = collect(taggedMesh(), ops);
    expect(outcomes.map((o) => [o.index, o.applied])).toEqual([[0, true], [1, false], [2, true]]);
  });
});
