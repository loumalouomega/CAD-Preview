import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { selectionGroupsFor, facesWithNormalLike, edgesParallelTo } from "./selectionGroups";

function faceMesh(positions: number[], indices: number[], entityId: string): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  const m = new THREE.Mesh(g);
  m.userData.entityType = "surface";
  m.userData.entityId = entityId;
  m.userData.groupId = "solid-0";
  return m;
}

/** Unit square in the XY plane, normal +Z, area 1. */
const squareUp = (id: string) => faceMesh([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 0, 2, 3], id);
/** Same square wound the other way — normal −Z, area 1. */
const squareDown = (id: string) => faceMesh([0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0], [0, 1, 2, 0, 2, 3], id);
/** 2×2 square in the XY plane, normal +Z, area 4. */
const bigSquareUp = (id: string) => faceMesh([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0], [0, 1, 2, 0, 2, 3], id);

function edgeLine(points: number[], entityId: string): THREE.Line {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  const l = new THREE.Line(g);
  l.userData.entityType = "line";
  l.userData.entityId = entityId;
  return l;
}

const ids = (list: { entityId: string }[]) => list.map((e) => e.entityId).sort();
const byId = (groups: { id: string; entities: unknown[] }[], id: string) => groups.find((g) => g.id === id);

describe("facesWithNormalLike", () => {
  it("is sign-SENSITIVE — an opposite-facing face is not 'the same facing'", () => {
    // Unlike the registry's sign-insensitive axis filters: the far side of a
    // box points the other way and is emphatically not the same face group.
    const targets = [squareUp("face-0"), squareDown("face-1"), bigSquareUp("face-2")];
    const same = facesWithNormalLike(targets, new THREE.Vector3(0, 0, 1));
    expect(ids(same)).toEqual(["face-0", "face-2"]);
  });

  it("respects the angular tolerance at its boundary", () => {
    const tilted = faceMesh(
      (() => {
        const a = (10 * Math.PI) / 180;
        const c = Math.cos(a);
        const s = Math.sin(a);
        return [0, 0, 0, c, 0, -s, c, 1, -s, 0, 1, 0];
      })(),
      [0, 1, 2, 0, 2, 3],
      "face-9"
    );
    const targets = [squareUp("face-0"), tilted];
    const up = new THREE.Vector3(0, 0, 1);
    expect(ids(facesWithNormalLike(targets, up, 5))).toEqual(["face-0"]);
    expect(ids(facesWithNormalLike(targets, up, 11))).toEqual(["face-0", "face-9"]);
  });
});

describe("edgesParallelTo", () => {
  it("is sign-INSENSITIVE — an edge drawn end-to-start is still parallel", () => {
    const targets = [
      edgeLine([0, 0, 0, 1, 0, 0], "edge-0"),
      edgeLine([5, 0, 0, 4, 0, 0], "edge-1"), // same axis, reversed
      edgeLine([0, 0, 0, 0, 1, 0], "edge-2"), // perpendicular
    ];
    expect(ids(edgesParallelTo(targets, new THREE.Vector3(1, 0, 0)))).toEqual(["edge-0", "edge-1"]);
  });
});

describe("selectionGroupsFor", () => {
  it("uses the clicked face's OWN area as the threshold", () => {
    // The whole point: the entity supplies the argument the filter form would
    // otherwise make the user type.
    const targets = [squareUp("face-0"), bigSquareUp("face-1"), squareUp("face-2")];
    const groups = selectionGroupsFor(targets, "surface", "face-0");

    // area >= 1 matches all three; area <= 1 matches the two unit squares.
    expect(ids(byId(groups, "areaGte")!.entities as { entityId: string }[])).toEqual(["face-0", "face-1", "face-2"]);
    expect(ids(byId(groups, "areaLte")!.entities as { entityId: string }[])).toEqual(["face-0", "face-2"]);
  });

  it("uses the clicked EDGE's own length as the threshold", () => {
    const targets = [
      edgeLine([0, 0, 0, 1, 0, 0], "edge-0"), // length 1
      edgeLine([0, 0, 0, 5, 0, 0], "edge-1"), // length 5
      edgeLine([0, 0, 0, 1, 0, 0], "edge-2"), // length 1
    ];
    const groups = selectionGroupsFor(targets, "line", "edge-0");
    expect(ids(byId(groups, "lengthLte")!.entities as { entityId: string }[])).toEqual(["edge-0", "edge-2"]);
    expect(ids(byId(groups, "lengthGte")!.entities as { entityId: string }[])).toEqual([
      "edge-0", "edge-1", "edge-2",
    ]);
  });

  it("drops a group that would select only the clicked entity", () => {
    // A row reading "(1)" offers nothing the click has not already done.
    const targets = [squareUp("face-0"), squareDown("face-1")];
    const groups = selectionGroupsFor(targets, "surface", "face-0");
    expect(groups.find((g) => g.id === "sameNormal")).toBeUndefined();
  });

  it("offers nothing for volume and point modes, matching the filter form's own gate", () => {
    const targets = [squareUp("face-0"), bigSquareUp("face-1")];
    expect(selectionGroupsFor(targets, "volume", "face-0")).toEqual([]);
    expect(selectionGroupsFor(targets, "point", "face-0")).toEqual([]);
  });

  it("returns nothing when the clicked id is not among the targets", () => {
    expect(selectionGroupsFor([squareUp("face-0")], "surface", "face-404")).toEqual([]);
  });

  it("always includes the clicked entity in every group it offers", () => {
    // A group that excluded the thing you right-clicked would be incoherent.
    const targets = [squareUp("face-0"), bigSquareUp("face-1"), squareUp("face-2")];
    for (const g of selectionGroupsFor(targets, "surface", "face-0")) {
      expect(ids(g.entities), g.id).toContain("face-0");
    }
  });
});
