import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { segmentCoplanarFacets, buildMeshFacetGroup, FACET_ANGLE_TOLERANCE, MAX_FACETS } from "./meshFacets";

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

  it("omitting triangleRegion behaves identically to before (no regression)", () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    expect(segmentCoplanarFacets(geo, FACET_ANGLE_TOLERANCE, undefined)).toEqual(segmentCoplanarFacets(geo));
  });

  it("triangleRegion prevents two coplanar triangles from merging across a region boundary", () => {
    const geo = new THREE.BoxGeometry(1, 1, 1); // 12 triangles, 2 per face, box's first face = triangles 0,1
    const noRegion = segmentCoplanarFacets(geo);
    expect(facetCount(noRegion)).toBe(6);
    expect(noRegion[0]).toBe(noRegion[1]); // face 0's two triangles are normally one facet

    const triangleRegion = new Array(12).fill(-1);
    triangleRegion[0] = 0; // triangle 0 → region 0
    triangleRegion[1] = 1; // triangle 1 → region 1 (same plane, different region)
    const facetOf = segmentCoplanarFacets(geo, FACET_ANGLE_TOLERANCE, triangleRegion);
    expect(facetOf[0]).not.toBe(facetOf[1]); // split apart despite being coplanar
    expect(facetCount(facetOf)).toBe(7); // one extra facet vs. the unconstrained 6
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

  it("BVH: kept-whole planar mesh gets a boundsTree (indirect:true preserves index)", () => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    const out = buildMeshFacetGroup(mesh, "node-0");
    expect(out).toBe(mesh);
    const geo = (out as THREE.Mesh).geometry as THREE.BufferGeometry & { boundsTree?: unknown };
    expect(geo.boundsTree).toBeDefined();
    expect(geo.boundsTree).not.toBeNull();
  });

  it("BVH: large curved mesh that stays whole (facetCount <=1 or >MAX_FACETS) gets a boundsTree", () => {
    // A smooth sphere merges all triangles into one facet (facetCount===1 → kept
    // whole via the <=1 branch). The dense-scan case is still "kept whole".
    const geo = new THREE.SphereGeometry(1, 64, 64);
    const triCount = geo.getIndex()!.count / 3;
    expect(triCount).toBeGreaterThan(5000);
    const mesh = new THREE.Mesh(geo);
    const out = buildMeshFacetGroup(mesh, "node-5");
    expect(out).toBe(mesh);
    const outGeo = (out as THREE.Mesh).geometry as THREE.BufferGeometry & { boundsTree?: unknown };
    expect(outGeo.boundsTree).toBeDefined();
  });

  it("BVH: many-facet mesh (facetCount > MAX_FACETS) stays whole and gets a boundsTree", () => {
    // Build a geometry with 600 disjoint triangles (no shared vertices → no
    // adjacency, each triangle its own facet → facetCount == triCount > 512).
    const triCount = 600;
    const positions = new Float32Array(triCount * 9);
    for (let t = 0; t < triCount; t++) {
      const base = t * 10; // far apart so no vertex welding merges them
      const o = t * 9;
      positions[o + 0] = base; positions[o + 1] = 0; positions[o + 2] = 0;
      positions[o + 3] = base + 1; positions[o + 4] = 0; positions[o + 5] = 0;
      positions[o + 6] = base; positions[o + 7] = 1; positions[o + 8] = 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(geo);
    const out = buildMeshFacetGroup(mesh, "node-9");
    expect(out).toBe(mesh); // kept whole via >MAX_FACETS
    const outGeo = (out as THREE.Mesh).geometry as THREE.BufferGeometry & { boundsTree?: unknown };
    expect(outGeo.boundsTree).toBeDefined();
  });

  it("BVH: split cube does NOT put boundsTree on its facet sub-meshes", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const out = buildMeshFacetGroup(mesh, "node-3");
    expect(out).toBeInstanceOf(THREE.Group);
    for (const child of (out as THREE.Group).children) {
      const g = (child as THREE.Mesh).geometry as THREE.BufferGeometry & { boundsTree?: unknown };
      expect(g.boundsTree).toBeUndefined();
    }
  });

  it("BVH: accelerated raycast matches brute-force faceIndex (indirect:true)", () => {
    // Dense curved mesh kept whole — raycast via BVH vs brute-force fallback.
    const geo = new THREE.SphereGeometry(1, 32, 32);
    const mesh = new THREE.Mesh(geo);
    const out = buildMeshFacetGroup(mesh, "node-0") as THREE.Mesh;
    const outGeo = out.geometry as THREE.BufferGeometry & { boundsTree?: unknown };
    expect(outGeo.boundsTree).toBeDefined();

    // Camera-like raycaster looking at the sphere centre.
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(0, 0, 5),
      new THREE.Vector3(0, 0, -1).normalize(),
      0, 100
    );

    const bvhHits = raycaster.intersectObject(out, false);
    expect(bvhHits.length).toBeGreaterThan(0);
    const bvhFaceIndex = (bvhHits[0] as unknown as { faceIndex: number }).faceIndex;
    const bvhDistance = bvhHits[0].distance;

    // Brute-force fallback: temporarily remove boundsTree so
    // acceleratedRaycast falls back to THREE's original Mesh.raycast.
    const saved = outGeo.boundsTree;
    (outGeo as unknown as Record<string, unknown>).boundsTree = null;
    const bruteHits = raycaster.intersectObject(out, false);
    (outGeo as unknown as Record<string, unknown>).boundsTree = saved;

    expect(bruteHits.length).toBeGreaterThan(0);
    const bruteFaceIndex = (bruteHits[0] as unknown as { faceIndex: number }).faceIndex;
    expect(bvhFaceIndex).toBe(bruteFaceIndex);
    expect(bvhDistance).toBeCloseTo(bruteHits[0].distance, 5);
  });

  it("BVH: second call is idempotent (does not rebuild or detach boundsTree)", () => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    buildMeshFacetGroup(mesh, "node-0");
    const geo = mesh.geometry as THREE.BufferGeometry & { boundsTree?: unknown };
    const first = geo.boundsTree;
    expect(first).toBeDefined();
    // Calling again (same mesh, same volumeId) must not clear or replace the tree.
    buildMeshFacetGroup(mesh, "node-0");
    expect(geo.boundsTree).toBe(first);
  });
});
