import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { segmentCoplanarFacets, buildMeshFacetGroup } from "./meshFacets";

function facetCount(facetOf: number[]): number {
  return facetOf.length ? Math.max(...facetOf) + 1 : 0;
}

describe("segmentCoplanarFacets", () => {
  it("groups the two coplanar triangles of a flat plane into one facet", () => {
    const geo = new THREE.PlaneGeometry(2, 2); // 2 triangles, coplanar
    const facetOf = segmentCoplanarFacets(geo);
    expect(facetOf.length).toBe(2);
    expect(facetCount(facetOf)).toBe(1);
  });

  it("splits a cube into 6 facets (one per face)", () => {
    const geo = new THREE.BoxGeometry(1, 1, 1); // 12 triangles, 6 faces
    const facetOf = segmentCoplanarFacets(geo);
    expect(facetOf.length).toBe(12);
    expect(facetCount(facetOf)).toBe(6);
  });

  it("works on non-indexed geometry (welds duplicated vertices)", () => {
    const geo = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    expect(geo.getIndex()).toBeNull();
    expect(facetCount(segmentCoplanarFacets(geo))).toBe(6);
  });

  it("assigns deterministic facet ids in triangle order", () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const a = segmentCoplanarFacets(geo);
    const b = segmentCoplanarFacets(geo);
    expect(a).toEqual(b);
    expect(a[0]).toBe(0); // first triangle seeds facet 0
  });

  it("respects the angle tolerance (a loose tolerance merges everything connected)", () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    // 91° tolerance lets the 90° cube edges merge → a single facet.
    expect(facetCount(segmentCoplanarFacets(geo, 91))).toBe(1);
  });
});

describe("buildMeshFacetGroup", () => {
  it("replaces a cube mesh with a group of 6 surface sub-meshes", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const out = buildMeshFacetGroup(mesh, "node-3");
    expect(out).not.toBe(mesh);
    expect(out).toBeInstanceOf(THREE.Group);
    expect(out.userData.groupId).toBe("node-3");
    const subs = out.children;
    expect(subs.length).toBe(6);
    for (const s of subs) {
      expect(s.userData.entityType).toBe("surface");
      expect(s.userData.groupId).toBe("node-3");
      expect(String(s.userData.entityId)).toMatch(/^node-3\/face-\d+$/);
    }
  });

  it("keeps a planar mesh whole as a single surface entity", () => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    const out = buildMeshFacetGroup(mesh, "node-0");
    expect(out).toBe(mesh); // not split
    expect(out.userData.entityType).toBe("surface");
    expect(out.userData.entityId).toBe("node-0/face-0");
  });
});
