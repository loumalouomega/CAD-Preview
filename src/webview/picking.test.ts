import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { resolvePick, collectTargets } from "./picking";

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
});
