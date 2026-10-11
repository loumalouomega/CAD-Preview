import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { segmentCoplanarFacets, buildMeshFacetGroup, triangleMaterialIndex, FACET_ANGLE_TOLERANCE, MAX_FACETS } from "./meshFacets";
import { applyNativeColor, isNativeColor, markNativeColor } from "./nativeColor";

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

describe("native colours through the facet split", () => {
  const native = (hex: number, vertexColors = false) => {
    const m = new THREE.MeshStandardMaterial({ color: hex, vertexColors });
    markNativeColor(m);
    return m;
  };

  /** A non-indexed unit cube with a `color` attribute: one colour per face. */
  function colouredCube(): THREE.Mesh {
    const geo = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    const n = geo.getAttribute("position").count;
    const colors = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) {
      const face = Math.floor(v / 6); // 2 triangles x 3 corners per face
      colors[v * 3] = face / 5;
      colors[v * 3 + 1] = 1 - face / 5;
      colors[v * 3 + 2] = 0.5;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return new THREE.Mesh(geo, native(0xffffff, true));
  }

  it("copies the colour attribute into every facet and keeps a vertex-coloured material", () => {
    const out = buildMeshFacetGroup(colouredCube(), "node-0");
    expect(out.children).toHaveLength(6);
    const seen = new Set<string>();
    for (const c of out.children as THREE.Mesh[]) {
      const col = c.geometry.getAttribute("color");
      expect(col).toBeDefined();
      expect(col.count).toBe(c.geometry.getAttribute("position").count);
      const mat = c.material as THREE.MeshStandardMaterial;
      expect(mat.vertexColors).toBe(true);
      expect(isNativeColor(mat)).toBe(true);
      seen.add([col.getX(0), col.getY(0), col.getZ(0)].map((v) => v.toFixed(2)).join(","));
    }
    expect(seen.size).toBe(6); // each facet kept its own colour
  });

  it("each facet owns its material: a Part colour on one does not repaint the rest", () => {
    const out = buildMeshFacetGroup(colouredCube(), "node-0");
    const [a, b] = out.children as THREE.Mesh[];
    expect(a.material).not.toBe(b.material);
    applyNativeColor(a.material as THREE.MeshStandardMaterial, 0xff0000);
    expect((a.material as THREE.MeshStandardMaterial).vertexColors).toBe(false);
    expect((b.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
  });

  it("copies uv into the facets", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), native(0xffffff));
    const out = buildMeshFacetGroup(mesh, "node-0");
    for (const c of out.children as THREE.Mesh[]) {
      expect(c.geometry.getAttribute("uv")).toBeDefined();
    }
  });

  it("a plain mesh still gets fresh palette materials and no extra attributes", () => {
    const out = buildMeshFacetGroup(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).toNonIndexed()), "node-0");
    for (const c of out.children as THREE.Mesh[]) {
      expect(isNativeColor(c.material as THREE.Material)).toBe(false);
      expect(c.geometry.getAttribute("color")).toBeUndefined();
    }
  });

  it("a kept-whole vertex-coloured mesh keeps its material and attribute", () => {
    const geo = new THREE.PlaneGeometry(1, 1).toNonIndexed();
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(geo.getAttribute("position").count * 3).fill(0.5), 3));
    const mesh = new THREE.Mesh(geo, native(0xffffff, true));
    expect(buildMeshFacetGroup(mesh, "node-0")).toBe(mesh);
    expect((mesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
  });
});

describe("multi-material meshes through the facet split", () => {
  /** A cube whose +X/+Y/+Z faces use material 0 and whose others use material 1. */
  function twoMaterialCube(nativeMats: boolean): THREE.Mesh {
    const geo = new THREE.BoxGeometry(1, 1, 1); // groups: one per face, in +x,-x,+y,-y,+z,-z order
    geo.clearGroups();
    // BoxGeometry emits 2 triangles (6 indices) per face in that order.
    [0, 1, 0, 1, 0, 1].forEach((mi, face) => geo.addGroup(face * 6, 6, mi));
    const mats = [new THREE.MeshStandardMaterial({ color: 0xcc2222 }), new THREE.MeshStandardMaterial({ color: 0x2222cc })];
    if (nativeMats) mats.forEach(markNativeColor);
    return new THREE.Mesh(geo, mats);
  }

  it("derives a per-triangle material index from the draw groups", () => {
    const idx = triangleMaterialIndex(twoMaterialCube(true).geometry, 2);
    expect(Array.from(idx)).toEqual([0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1]);
  });

  it("falls back to material 0 for triangles outside every group and out-of-range indices", () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.clearGroups();
    geo.addGroup(0, 6, 7); // index 7 does not exist in a 2-material list
    const idx = triangleMaterialIndex(geo, 2);
    expect(Array.from(idx).every((v) => v === 0)).toBe(true);
    expect(idx).toHaveLength(12);
  });

  it("a native array gives each facet the material of its triangles", () => {
    const mesh = twoMaterialCube(true);
    const out = buildMeshFacetGroup(mesh, "node-0");
    const hexes = (out.children as THREE.Mesh[]).map((c) => (c.material as THREE.MeshStandardMaterial).color.getHex());
    expect(out.children).toHaveLength(6);
    expect(hexes.filter((h) => h === new THREE.Color(0xcc2222).getHex())).toHaveLength(3);
    expect(hexes.filter((h) => h === new THREE.Color(0x2222cc).getHex())).toHaveLength(3);
    for (const c of out.children as THREE.Mesh[]) expect(Array.isArray(c.material)).toBe(false);
  });

  it("the coplanar +X face is split in two when its triangles use different materials (gating, not fallback)", () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.clearGroups();
    // face 0 (+X) = triangles 0 and 1: give them different materials; the rest material 0.
    geo.addGroup(0, 3, 0);
    geo.addGroup(3, 3, 1);
    geo.addGroup(6, 30, 0);
    const mats = [new THREE.MeshStandardMaterial({ color: 0xff0000 }), new THREE.MeshStandardMaterial({ color: 0x0000ff })];
    mats.forEach(markNativeColor);
    const out = buildMeshFacetGroup(new THREE.Mesh(geo, mats), "node-0");
    expect(out.children).toHaveLength(7); // 6 faces + the split one; ungated it would be 6
  });

  it("a single flat quad with one triangle per material becomes two surfaces", () => {
    // One flat quad = 2 coplanar triangles, one per material (kept-whole-by-material path).
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.clearGroups();
    geo.addGroup(0, 3, 0);
    geo.addGroup(3, 3, 1);
    const mats = [new THREE.MeshStandardMaterial({ color: 0xff0000 }), new THREE.MeshStandardMaterial({ color: 0x0000ff })];
    mats.forEach(markNativeColor);
    const out = buildMeshFacetGroup(new THREE.Mesh(geo, mats), "node-0");
    expect(out.children).toHaveLength(2);
  });

  it("a non-native array (no .mtl) collapses to one default material, as before", () => {
    const mesh = twoMaterialCube(false);
    const out = buildMeshFacetGroup(mesh, "node-0");
    expect(out.children).toHaveLength(6); // facet ids ignore the unresolved materials
    for (const c of out.children as THREE.Mesh[]) {
      expect(Array.isArray(c.material)).toBe(false);
      expect(isNativeColor(c.material as THREE.Material)).toBe(false);
    }
  });

  it("a non-native array on a kept-whole mesh no longer leaves an array material behind", () => {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.clearGroups();
    geo.addGroup(0, 6, 0);
    const mesh = new THREE.Mesh(geo, [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]);
    const out = buildMeshFacetGroup(mesh, "node-0");
    expect(out).toBe(mesh);
    expect(Array.isArray((out as THREE.Mesh).material)).toBe(false);
  });
});
