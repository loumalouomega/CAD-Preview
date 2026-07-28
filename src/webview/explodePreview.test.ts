import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { captureExplodeBase, applyExplodePreview, resetExplodePreview } from "./explodePreview";

function taggedGroup(groupId: string, position: [number, number, number]): THREE.Group {
  const g = new THREE.Group();
  g.userData.groupId = groupId;
  g.position.set(...position);
  // Box3.setFromObject needs actual geometry to produce a non-empty box.
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  g.add(mesh);
  return g;
}

describe("explodePreview", () => {
  it("captures each tagged group's centre-relative offset and pristine position", () => {
    const root = new THREE.Group();
    const a = taggedGroup("solid-0", [-5, 0, 0]);
    const b = taggedGroup("solid-1", [5, 0, 0]);
    root.add(a, b);

    const bases = captureExplodeBase(root);
    expect(bases).toHaveLength(2);
    expect(bases[0].basePosition.toArray()).toEqual([-5, 0, 0]);
    expect(bases[1].basePosition.toArray()).toEqual([5, 0, 0]);
    // model centre is 0,0,0 — each group's own centre equals its offset from model centre
    expect(bases[0].offsetFromCentre.x).toBeCloseTo(-5, 5);
    expect(bases[1].offsetFromCentre.x).toBeCloseTo(5, 5);
  });

  it("excludes children with no groupId (e.g. a B-rep root's edges/points groups)", () => {
    const root = new THREE.Group();
    const solid = taggedGroup("solid-0", [0, 0, 0]);
    const edges = new THREE.Group(); // no userData.groupId
    edges.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    root.add(solid, edges);

    const bases = captureExplodeBase(root);
    expect(bases.map((b) => b.object)).toEqual([solid]);
  });

  it("does not compound across repeated applyExplodePreview calls with different factors", () => {
    const root = new THREE.Group();
    const a = taggedGroup("solid-0", [10, 0, 0]);
    root.add(a);
    const bases = captureExplodeBase(root);

    applyExplodePreview(bases, 1);
    const posAt1 = a.position.x;
    applyExplodePreview(bases, 2);
    const posAt2 = a.position.x;
    applyExplodePreview(bases, 0.5);
    const posAt05 = a.position.x;

    // Each call is computed from the cached base, not the previous frame's result.
    expect(posAt2).toBeCloseTo(posAt1 * 2 - 10, 5); // offset doubles, base stays 10
    expect(posAt05).not.toBeCloseTo(posAt1 + posAt2, 5); // would be wildly off if compounding
    expect(a.position.x).toBeCloseTo(10 + bases[0].offsetFromCentre.x * 0.5, 5);
  });

  it("resetExplodePreview restores exact original positions", () => {
    const root = new THREE.Group();
    // Two children off-centre from each other so the model centre != either
    // child's own centre — otherwise offsetFromCentre is trivially zero.
    const a = taggedGroup("solid-0", [3, 1, -2]);
    const b = taggedGroup("solid-1", [-3, -1, 2]);
    root.add(a, b);
    const bases = captureExplodeBase(root);

    applyExplodePreview(bases, 5);
    expect(a.position.toArray()).not.toEqual([3, 1, -2]);
    resetExplodePreview(bases);
    expect(a.position.toArray()).toEqual([3, 1, -2]);
    expect(b.position.toArray()).toEqual([-3, -1, 2]);
  });

  it("returns an empty array for an empty root", () => {
    const root = new THREE.Group();
    expect(captureExplodeBase(root)).toEqual([]);
  });
});
