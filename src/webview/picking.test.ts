import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { resolvePick, collectTargets, resolveMeasurePick, collectMeasureTargets } from "./picking";

describe("resolvePick", () => {
  const face = { entityType: "surface", entityId: "face-3", groupId: "solid-1" };
  const edge = { entityType: "line", entityId: "edge-7" };
  const point = { entityType: "point", entityId: "point-2" };

  it("resolves a face hit to the face in surface mode", () => {
    expect(resolvePick(face, "surface")).toEqual({ entityType: "surface", entityId: "face-3" });
  });

  it("resolves a face hit up to its solid in volume mode", () => {
    expect(resolvePick(face, "volume")).toEqual({ entityType: "volume", entityId: "solid-1" });
  });

  it("resolves an edge hit in line mode", () => {
    expect(resolvePick(edge, "line")).toEqual({ entityType: "line", entityId: "edge-7" });
  });

  it("ignores an edge hit when in surface/volume mode", () => {
    expect(resolvePick(edge, "surface")).toBeNull();
    expect(resolvePick(edge, "volume")).toBeNull();
  });

  it("ignores a face hit when in line mode", () => {
    expect(resolvePick(face, "line")).toBeNull();
  });

  it("returns null when required ids are missing", () => {
    expect(resolvePick({ entityType: "surface" }, "surface")).toBeNull();
    expect(resolvePick({ entityType: "surface", entityId: "face-0" }, "volume")).toBeNull();
  });

  it("resolves a point hit in point mode", () => {
    expect(resolvePick(point, "point")).toEqual({ entityType: "point", entityId: "point-2" });
  });

  it("ignores a point hit when not in point mode, and non-point hits in point mode", () => {
    expect(resolvePick(point, "surface")).toBeNull();
    expect(resolvePick(point, "line")).toBeNull();
    expect(resolvePick(point, "volume")).toBeNull();
    expect(resolvePick(face, "point")).toBeNull();
    expect(resolvePick(edge, "point")).toBeNull();
  });
});

describe("collectTargets", () => {
  function buildModel(): THREE.Group {
    const root = new THREE.Group();
    const solid = new THREE.Group();
    solid.userData.groupId = "solid-0";
    const m = new THREE.Mesh();
    m.userData = { entityType: "surface", entityId: "face-0", groupId: "solid-0" };
    solid.add(m);
    root.add(solid);
    const edges = new THREE.Group();
    const line = new THREE.Line();
    line.userData = { entityType: "line", entityId: "edge-0" };
    edges.add(line);
    root.add(edges);
    const points = new THREE.Group();
    const sprite = new THREE.Sprite();
    sprite.userData = { entityType: "point", entityId: "point-0" };
    points.add(sprite);
    root.add(points);
    return root;
  }

  it("collects only face meshes for surface/volume modes", () => {
    const root = buildModel();
    const surf = collectTargets(root, "surface");
    expect(surf.map((o) => o.userData.entityId)).toEqual(["face-0"]);
    expect(collectTargets(root, "volume").map((o) => o.userData.entityId)).toEqual(["face-0"]);
  });

  it("collects only edge lines for line mode", () => {
    const root = buildModel();
    expect(collectTargets(root, "line").map((o) => o.userData.entityId)).toEqual(["edge-0"]);
  });

  it("collects only point sprites for point mode", () => {
    const root = buildModel();
    expect(collectTargets(root, "point").map((o) => o.userData.entityId)).toEqual(["point-0"]);
  });

  describe("hidden geometry is NOT collected (traverseVisible is load-bearing)", () => {
    it("a hidden leaf (a Part eye-toggle's face) is pruned from the target set", () => {
      const root = buildModel();
      const face = root.getObjectByProperty("userData.entityId", "face-0") ?? deepFind(root, "face-0");
      face!.visible = false;
      expect(collectTargets(root, "surface")).toEqual([]);
      // Other kinds are unaffected.
      expect(collectTargets(root, "line").map((o) => o.userData.entityId)).toEqual(["edge-0"]);
    });

    it("an invisible ANCESTOR prunes its whole subtree (hidden Part hides faces+edges+points as a unit)", () => {
      const root = buildModel();
      const solid = root.children[0];
      solid.visible = false;
      expect(collectTargets(root, "surface")).toEqual([]);
    });

    it("an invisible root collects nothing at all", () => {
      const root = buildModel();
      root.visible = false;
      expect(collectTargets(root, "surface")).toEqual([]);
      expect(collectTargets(root, "line")).toEqual([]);
      expect(collectTargets(root, "point")).toEqual([]);
    });
  });
});

/** Finds an object by `userData.entityId` without relying on
 * `getObjectByProperty`'s dotted-path semantics. */
function deepFind(root: THREE.Object3D, entityId: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if ((o.userData as { entityId?: string }).entityId === entityId) found = o;
  });
  return found;
}

describe("resolveMeasurePick", () => {
  const face = { entityType: "surface", entityId: "face-3", groupId: "solid-1" };
  const edge = { entityType: "line", entityId: "edge-7" };
  const point = { entityType: "point", entityId: "point-2" };

  it("keeps a face hit as a surface (never resolves up to its solid)", () => {
    expect(resolveMeasurePick(face)).toEqual({ entityType: "surface", entityId: "face-3" });
  });

  it("resolves an edge hit to a line", () => {
    expect(resolveMeasurePick(edge)).toEqual({ entityType: "line", entityId: "edge-7" });
  });

  it("resolves a point hit to a point", () => {
    expect(resolveMeasurePick(point)).toEqual({ entityType: "point", entityId: "point-2" });
  });

  it("returns null when required ids are missing or entityType is unrecognized", () => {
    expect(resolveMeasurePick({ entityType: "surface" })).toBeNull();
    expect(resolveMeasurePick({ entityType: "mesh", entityId: "x" })).toBeNull();
    expect(resolveMeasurePick({})).toBeNull();
  });
});

describe("collectMeasureTargets", () => {
  function buildModel(): THREE.Group {
    const root = new THREE.Group();
    const solid = new THREE.Group();
    solid.userData.groupId = "solid-0";
    const m = new THREE.Mesh();
    m.userData = { entityType: "surface", entityId: "face-0", groupId: "solid-0" };
    solid.add(m);
    root.add(solid);
    const edges = new THREE.Group();
    const line = new THREE.Line();
    line.userData = { entityType: "line", entityId: "edge-0" };
    edges.add(line);
    root.add(edges);
    const points = new THREE.Group();
    const sprite = new THREE.Sprite();
    sprite.userData = { entityType: "point", entityId: "point-0" };
    points.add(sprite);
    root.add(points);
    const overlay = new THREE.Mesh();
    overlay.userData = { entityType: "mesh" }; // FE-mesh overlay — must be excluded
    root.add(overlay);
    return root;
  }

  it("collects every surface/line/point at once, excluding the FE-mesh overlay", () => {
    const root = buildModel();
    expect(collectMeasureTargets(root).map((o) => o.userData.entityId)).toEqual(["face-0", "edge-0", "point-0"]);
  });

  it("a hidden Part's entities stay unmeasurable (invisible ancestor prunes the subtree)", () => {
    const root = buildModel();
    root.children[0].visible = false; // the solid group holding face-0
    expect(collectMeasureTargets(root).map((o) => o.userData.entityId)).toEqual(["edge-0", "point-0"]);
  });

  it("a hidden leaf is skipped individually", () => {
    const root = buildModel();
    deepFind(root, "edge-0")!.visible = false;
    expect(collectMeasureTargets(root).map((o) => o.userData.entityId)).toEqual(["face-0", "point-0"]);
  });
});
