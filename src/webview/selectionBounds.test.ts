import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { unionSelectionBounds, padBoxToMinSize, MIN_SELECTION_FRAC } from "./selectionBounds";

/** Two unit boxes 10 apart: solid-0 around the origin, solid-1 at x=10. */
function buildModel(): THREE.Group {
  const root = new THREE.Group();
  for (const [solid, x] of [["solid-0", 0], ["solid-1", 10]] as const) {
    const g = new THREE.Group();
    g.userData.groupId = solid;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    mesh.position.set(x, 0, 0);
    mesh.userData = { entityType: "surface", entityId: solid === "solid-0" ? "face-0" : "face-1", groupId: solid };
    g.add(mesh);
    const edgeGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0, 0), new THREE.Vector3(x + 2, 0, 0)]);
    const line = new THREE.Line(edgeGeo);
    line.userData = { entityType: "line", entityId: solid === "solid-0" ? "edge-0" : "edge-1", groupId: solid };
    g.add(line);
    root.add(g);
  }
  const sprite = new THREE.Sprite();
  sprite.position.set(0, 5, 0);
  sprite.userData = { entityType: "point", entityId: "point-0", groupId: "solid-0" };
  root.add(sprite);
  return root;
}

describe("unionSelectionBounds", () => {
  it("unions one face to exactly its own box", () => {
    const box = unionSelectionBounds(buildModel(), [{ entityType: "surface", entityId: "face-0" }]);
    expect(box).not.toBeNull();
    expect(box!.min.toArray()).toEqual([-1, -1, -1]);
    expect(box!.max.toArray()).toEqual([1, 1, 1]);
  });

  it("a volume selection covers every object of that solid (faces, edges, points)", () => {
    const box = unionSelectionBounds(buildModel(), [{ entityType: "volume", entityId: "solid-0" }]);
    expect(box).not.toBeNull();
    // face-0 spans y ±1, but point-0's sprite quad (1×1 at y=5) reaches 5.5 —
    // the volume union covers faces, edges AND points of that solid.
    expect(box!.max.y).toBe(5.5);
    expect(box!.min.x).toBe(-1);
  });

  it("unions several solids across the gap between them", () => {
    const box = unionSelectionBounds(buildModel(), [
      { entityType: "volume", entityId: "solid-0" },
      { entityType: "volume", entityId: "solid-1" },
    ]);
    expect(box).not.toBeNull();
    expect(box!.min.x).toBe(-1);
    // solid-1's mesh spans 9..11 but its edge runs 10..12 — the union covers both.
    expect(box!.max.x).toBe(12);
  });

  it("an edge selection frames the edge's own extent", () => {
    const box = unionSelectionBounds(buildModel(), [{ entityType: "line", entityId: "edge-1" }]);
    expect(box).not.toBeNull();
    expect(box!.min.x).toBe(10);
    expect(box!.max.x).toBe(12);
  });

  it("returns null for an empty selection", () => {
    expect(unionSelectionBounds(buildModel(), [])).toBeNull();
  });

  it("returns null for stale ids that match nothing", () => {
    expect(unionSelectionBounds(buildModel(), [{ entityType: "surface", entityId: "face-404" }])).toBeNull();
  });

  it("excludes hidden subtrees — a fully-hidden selection reads as hidden, not empty-geometry", () => {
    const root = buildModel();
    root.traverse((o) => {
      if (o.userData.groupId === "solid-1") o.visible = false;
    });
    // solid-1's own group is hidden, but the traverseVisible prune happens at
    // the group level — face-1 resolves to nothing visible.
    expect(unionSelectionBounds(root, [{ entityType: "surface", entityId: "face-1" }])).toBeNull();
    // The visible solid still resolves.
    expect(unionSelectionBounds(root, [{ entityType: "surface", entityId: "face-0" }])).not.toBeNull();
  });

  it("a mixed visible+hidden selection frames only the visible part", () => {
    const root = buildModel();
    root.traverse((o) => {
      if (o.userData.entityId === "face-1") o.visible = false;
    });
    const box = unionSelectionBounds(root, [
      { entityType: "surface", entityId: "face-0" },
      { entityType: "surface", entityId: "face-1" },
    ]);
    expect(box).not.toBeNull();
    expect(box!.max.x).toBe(1);
  });
});

describe("padBoxToMinSize", () => {
  it("leaves an already-large box untouched", () => {
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 10, 10));
    padBoxToMinSize(box, 100);
    expect(box.min.toArray()).toEqual([0, 0, 0]);
    expect(box.max.toArray()).toEqual([10, 10, 10]);
  });

  it("expands a degenerate point box to the model-relative floor", () => {
    const box = new THREE.Box3(new THREE.Vector3(4, 4, 4), new THREE.Vector3(4, 4, 4));
    padBoxToMinSize(box, 100);
    const size = box.getSize(new THREE.Vector3());
    expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(100 * MIN_SELECTION_FRAC, 9);
    // Still centred on the point.
    const center = box.getCenter(new THREE.Vector3());
    expect(center.toArray()).toEqual([4, 4, 4]);
  });

  it("is a no-op for a non-positive model diagonal", () => {
    const box = new THREE.Box3(new THREE.Vector3(4, 4, 4), new THREE.Vector3(4, 4, 4));
    padBoxToMinSize(box, 0);
    expect(box.getSize(new THREE.Vector3()).toArray()).toEqual([0, 0, 0]);
  });
});
