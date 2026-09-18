import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  DEFAULT_DIRECTION_TOLERANCE_DEG,
  applyFaceFilter,
  applyLineFilter,
  applyVolumeFilter,
  applyPointFilter,
  groupVolumes,
  pointPosition,
  edgeDirection,
  edgeLength,
  faceArea,
  faceIsPlanar,
  faceNormal,
} from "./selectFilters";

function faceMesh(
  positions: number[],
  indices: number[],
  entityId: string,
  groupId = "solid-0"
): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  const m = new THREE.Mesh(g);
  m.userData.entityType = "surface";
  m.userData.entityId = entityId;
  m.userData.groupId = groupId;
  return m;
}

function squareFace(entityId: string): THREE.Mesh {
  // unit square in XY plane, normal +Z, area 1
  return faceMesh([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 0, 2, 3], entityId);
}

function largeSquareFace(entityId: string): THREE.Mesh {
  // 2x2 square, area 4
  return faceMesh([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0], [0, 1, 2, 0, 2, 3], entityId);
}

/** Tilted square rotated 10° around Y — normal is cos10°*Z + sin10°*X. */
function tiltedFace(entityId: string): THREE.Mesh {
  const a = 10 * (Math.PI / 180);
  const c = Math.cos(a);
  const s = Math.sin(a);
  // unit square corners (0,0,0)-(1,0,0)-(1,1,0)-(0,1,0) rotated around Y: x' = x*c + z*s, z' = -x*s + z*c
  // Since z=0 initially: (x, y) -> (x*c, y, -x*s)
  const pos = [0, 0, 0, c, 0, -s, c, 1, -s, 0, 1, 0];
  return faceMesh(pos, [0, 1, 2, 0, 2, 3], entityId);
}

/** Bent strip: two unit squares meeting at 90° along shared edge — non-planar. */
function bentFace(entityId: string): THREE.Mesh {
  // First square XY plane, second square YZ plane sharing edge at y=0? Simpler: two quads perpendicular.
  // Vertices: square A (0,0,0)-(1,0,0)-(1,1,0)-(0,1,0), square B (0,1,0)-(1,1,0)-(1,1,1)-(0,1,1)? Actually that shares edge (0,1)-(1,1)? Hmm need separate tris across bend.
  // Just make two triangles with normals +Z and +Y.
  const pos = [
    0, 0, 0, 1, 0, 0, 1, 1, 0, // tri0 normal +Z
    0, 1, 0, 1, 1, 0, 0, 1, 1, // tri1? Let's make tri1 vertices (0,1,0),(1,1,0),(0,1,1) — normal roughly +Y? cross of (1,0,0) x (0,0,1) = (0,-1,0)? Hmm
  ];
  // For a non-planar face we need triangle normals far apart.
  // Use 4 vertices forming a folded shape with two separate square halves.
  // Simpler: reuse two squares stitched: squareA verts 0..3, squareB verts 4..7 sharing an edge logically but normals differ.
  // Build as 4 vertices: define a mesh with 6 verts (two tris groups not welding needed; we can just create two independent tris each with area 0.5)
  // Instead construct with indices that make two triangles with clearly different normals:
  // tri0: (0,0,0)-(1,0,0)-(0,1,0) normal +Z
  // tri1: (0,0,0)-(0,1,0)-(0,0,1) normal +X? cross (0,1,0)x(0,0,1)= (1,0,0)
  const pos2 = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1];
  const idx2 = [0, 1, 2, 3, 4, 5];
  return faceMesh(pos2, idx2, entityId);
}

/** Single-quad curved strip approximating a 90° cylindrical patch: faceted area = sqrt2 ≈1.414 < analytic π/2≈1.5708. */
function curvedStripFace(entityId: string): THREE.Mesh {
  // chord between (1,0) and (0,1) extruded height 1
  const pos = [1, 0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 1];
  return faceMesh(pos, [0, 1, 2, 0, 2, 3], entityId);
}

function lineEntity(positions: number[], entityId: string, smooth = false): THREE.Line {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const l = new THREE.Line(g);
  l.userData.entityType = "line";
  l.userData.entityId = entityId;
  if (smooth) l.userData.smooth = true;
  return l;
}

describe("selectFilters face helpers", () => {
  it("faceArea is exact for planar faces", () => {
    expect(faceArea(squareFace("face-0"))).toBeCloseTo(1, 5);
    expect(faceArea(largeSquareFace("face-1"))).toBeCloseTo(4, 5);
  });

  it("faceNormal is +Z for an XY square", () => {
    const n = faceNormal(squareFace("face-0"))!;
    expect(n.x).toBeCloseTo(0, 5);
    expect(n.y).toBeCloseTo(0, 5);
    expect(n.z).toBeCloseTo(1, 5);
  });

  it("curved faceted area is strictly under its analytic cylindrical value", () => {
    const curved = curvedStripFace("face-curved");
    const computed = faceArea(curved);
    const analytic = (Math.PI / 2) * 1 * 1; // r*h*theta
    expect(computed).toBeGreaterThan(0);
    expect(computed).toBeLessThan(analytic);
    // faceted chord area sqrt2
    expect(computed).toBeCloseTo(Math.SQRT2, 5);
  });

  it("faceIsPlanar true for flat, false for bent", () => {
    expect(faceIsPlanar(squareFace("a"))).toBe(true);
    expect(faceIsPlanar(bentFace("b"))).toBe(false);
  });

  it("tilted face respects direction tolerance", () => {
    const f = tiltedFace("face-tilt");
    // dot between tilted normal and +Z is cos10° ≈0.985
    const tol5 = DEFAULT_DIRECTION_TOLERANCE_DEG; // 5°
    // 10° exceeds 5°, so normal+Z filter within 5° should NOT match
    expect(applyFaceFilter([f], "normalPz", 0, tol5)).toEqual([]);
    // but at 11° tolerance it does
    expect(applyFaceFilter([f], "normalPz", 0, 11).length).toBe(1);
    // normalPx filter (tilt is toward +X slightly, cos80° ≈0.17, dot with +X = sin10°≈0.17, not within 5°)
    expect(applyFaceFilter([f], "normalPx", 0, tol5)).toEqual([]);
  });
});

describe("selectFilters applyFaceFilter predicates", () => {
  it("normal direction predicates", () => {
    const fz = squareFace("face-z"); // +Z
    const negZ: THREE.Mesh = (() => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
      // wound opposite (CW) → normal -Z
      g.setIndex([0, 2, 1, 0, 3, 2]);
      const m = new THREE.Mesh(g);
      m.userData.entityType = "surface";
      m.userData.entityId = "face-nz";
      m.userData.groupId = "solid-0";
      return m;
    })();
    expect(applyFaceFilter([fz], "normalPz", 0).map((e) => e.entityId)).toEqual(["face-z"]);
    expect(applyFaceFilter([negZ], "normalPz", 0)).toEqual([]);
    expect(applyFaceFilter([fz, negZ], "normalNz", 0).map((e) => e.entityId)).toEqual(["face-nz"]);
  });

  it("planar predicate", () => {
    const flat = squareFace("face-flat");
    const bent = bentFace("face-bent");
    expect(applyFaceFilter([flat, bent], "planar", 0).map((e) => e.entityId)).toEqual(["face-flat"]);
  });

  it("area thresholds", () => {
    const small = squareFace("face-small");
    const large = largeSquareFace("face-large");
    expect(applyFaceFilter([small, large], "areaGte", 2).map((e) => e.entityId)).toEqual(["face-large"]);
    expect(applyFaceFilter([small, large], "areaLte", 2).map((e) => e.entityId)).toEqual(["face-small"]);
  });

  it("largestN / smallestN ordering", () => {
    const a = squareFace("face-a"); // 1
    const b = largeSquareFace("face-b"); // 4
    const c = squareFace("face-c"); // 1 (tie)
    c.userData.entityId = "face-c";
    expect(applyFaceFilter([a, b, c], "largestN", 1).map((e) => e.entityId)).toEqual(["face-b"]);
    expect(applyFaceFilter([a, b, c], "smallestN", 2).length).toBe(2);
    // stable sort not required by spec — just count for ties
    expect(applyFaceFilter([a, b, c], "largestN", 10).length).toBe(3);
  });

  it("degenerate / non-surface targets are ignored", () => {
    const line = lineEntity([0, 0, 0, 1, 0, 0], "edge-0");
    const empty = new THREE.Mesh(new THREE.BufferGeometry());
    empty.userData.entityType = "surface";
    empty.userData.entityId = "face-empty";
    expect(applyFaceFilter([line as unknown as THREE.Mesh], "planar", 0)).toEqual([]);
    expect(applyFaceFilter([empty], "areaGte", 0.1)).toEqual([]); // degenerate area 0 < threshold
  });
});

describe("selectFilters edge helpers", () => {
  it("edgeLength sums polyline segments", () => {
    const l = lineEntity([0, 0, 0, 1, 0, 0, 1, 1, 0], "edge-0");
    expect(edgeLength(l)).toBeCloseTo(2, 5);
  });

  it("edgeDirection sign-insensitive for along predicates", () => {
    const fwd = lineEntity([0, 0, 0, 1, 0, 0], "edge-fwd");
    const rev = lineEntity([1, 0, 0, 0, 0, 0], "edge-rev");
    expect(edgeDirection(fwd)!.dot(new THREE.Vector3(1, 0, 0))).toBeCloseTo(1, 5);
    expect(edgeDirection(rev)!.dot(new THREE.Vector3(1, 0, 0))).toBeCloseTo(-1, 5);
    // alongX is sign-insensitive: both match
    expect(applyLineFilter([fwd], "alongX", 0, false).length).toBe(1);
    expect(applyLineFilter([rev], "alongX", 0, false).length).toBe(1);
    const yLine = lineEntity([0, 0, 0, 0, 1, 0], "edge-y");
    expect(applyLineFilter([yLine], "alongX", 0, false)).toEqual([]);
  });

  it("length thresholds and N predicates", () => {
    const short = lineEntity([0, 0, 0, 1, 0, 0], "edge-short");
    const long = lineEntity([0, 0, 0, 5, 0, 0], "edge-long");
    expect(applyLineFilter([short, long], "lengthGte", 3, false).map((e) => e.entityId)).toEqual(["edge-long"]);
    expect(applyLineFilter([short, long], "lengthLte", 3, false).map((e) => e.entityId)).toEqual(["edge-short"]);
    expect(applyLineFilter([short, long], "longestN", 1, false).map((e) => e.entityId)).toEqual(["edge-long"]);
    expect(applyLineFilter([short, long], "shortestN", 1, false).map((e) => e.entityId)).toEqual(["edge-short"]);
  });

  it("excludeSmooth drops smooth lines before any other test", () => {
    const smooth = lineEntity([0, 0, 0, 1, 0, 0], "edge-smooth", true);
    const sharp = lineEntity([0, 0, 0, 1, 0, 0], "edge-sharp");
    expect(applyLineFilter([smooth, sharp], "lengthGte", 0, true).map((e) => e.entityId)).toEqual(["edge-sharp"]);
    expect(applyLineFilter([smooth, sharp], "lengthGte", 0, false).map((e) => e.entityId).sort()).toEqual([
      "edge-sharp",
      "edge-smooth",
    ]);
  });

  it("degenerate edge returns null direction", () => {
    const deg = lineEntity([0, 0, 0, 0, 0, 0], "edge-deg");
    expect(edgeDirection(deg)).toBeNull();
    expect(applyLineFilter([deg], "alongX", 0, false)).toEqual([]);
  });
});

describe("selectFilters volume predicates", () => {
  /** Box mesh tagged as one face of `groupId`, centred at (cx, 0, 0). */
  function boxFace(size: number, cx: number, entityId: string, groupId: string): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size));
    m.position.set(cx, 0, 0);
    m.userData.entityType = "surface";
    m.userData.entityId = entityId;
    m.userData.groupId = groupId;
    return m;
  }

  it("size thresholds use the bbox diagonal", () => {
    const small = boxFace(2, 0, "face-s", "solid-s"); // diagonal 2√3 ≈ 3.46
    const large = boxFace(4, 20, "face-l", "solid-l"); // diagonal 4√3 ≈ 6.93
    expect(applyVolumeFilter([small, large], "sizeGte", 5).map((e) => e.entityId)).toEqual(["solid-l"]);
    expect(applyVolumeFilter([small, large], "sizeLte", 5).map((e) => e.entityId)).toEqual(["solid-s"]);
    // exact-boundary equality matches (the 1e-9 tolerance, not strict >)
    expect(applyVolumeFilter([small], "sizeGte", 2 * Math.sqrt(3)).map((e) => e.entityId)).toEqual(["solid-s"]);
  });

  it("center thresholds read the bbox center per axis and sign", () => {
    const left = boxFace(2, -10, "face-l", "solid-l");
    const right = boxFace(2, 10, "face-r", "solid-r");
    expect(applyVolumeFilter([left, right], "centerXp", 0).map((e) => e.entityId)).toEqual(["solid-r"]);
    expect(applyVolumeFilter([left, right], "centerXn", 0).map((e) => e.entityId)).toEqual(["solid-l"]);
    expect(applyVolumeFilter([left, right], "centerYp", 1)).toEqual([]);
    expect(applyVolumeFilter([left, right], "centerYn", 0).map((e) => e.entityId).sort()).toEqual(["solid-l", "solid-r"]);
  });

  it("largestN / smallestN rank by bbox volume", () => {
    const small = boxFace(2, 0, "face-s", "solid-s"); // volume 8
    const large = boxFace(4, 20, "face-l", "solid-l"); // volume 64
    expect(applyVolumeFilter([small, large], "largestN", 1).map((e) => e.entityId)).toEqual(["solid-l"]);
    expect(applyVolumeFilter([small, large], "smallestN", 1).map((e) => e.entityId)).toEqual(["solid-s"]);
  });

  it("ranks by bbox volume, not diagonal", () => {
    // Long-thin 10×1×1 (diagonal ≈ 10.1, volume 10) vs compact 3×3×3
    // (diagonal ≈ 5.2, volume 27): the two orders disagree, so this pins
    // the named metric — a diagonal ranking would return thin first.
    const thin = new THREE.Mesh(new THREE.BoxGeometry(10, 1, 1));
    thin.userData.entityType = "surface";
    thin.userData.entityId = "face-thin";
    thin.userData.groupId = "solid-thin";
    const compact = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3));
    compact.position.set(30, 0, 0);
    compact.userData.entityType = "surface";
    compact.userData.entityId = "face-compact";
    compact.userData.groupId = "solid-compact";
    expect(applyVolumeFilter([thin, compact], "largestN", 1).map((e) => e.entityId)).toEqual(["solid-compact"]);
    expect(applyVolumeFilter([thin, compact], "smallestN", 1).map((e) => e.entityId)).toEqual(["solid-thin"]);
  });

  it("ranking ties break by groupId — deterministic regardless of traversal order", () => {
    const a = boxFace(2, 0, "face-a", "solid-b");
    const b = boxFace(2, 20, "face-b", "solid-a");
    expect(applyVolumeFilter([a, b], "largestN", 1).map((e) => e.entityId)).toEqual(["solid-a"]);
    expect(applyVolumeFilter([b, a], "largestN", 1).map((e) => e.entityId)).toEqual(["solid-a"]);
  });

  it("facets sharing a groupId deduplicate to one volume", () => {
    const f1 = boxFace(2, 0, "face-0", "solid-0");
    const f2 = boxFace(2, 0, "face-1", "solid-0");
    const f3 = boxFace(2, 0, "face-2", "solid-0");
    expect(groupVolumes([f1, f2, f3])).toHaveLength(1);
    expect(applyVolumeFilter([f1, f2, f3], "largestN", 5).map((e) => e.entityId)).toEqual(["solid-0"]);
  });

  it("mesh-style node groups rank independently", () => {
    const a = boxFace(2, 0, "face-0", "node-0");
    const b = boxFace(4, 20, "face-1", "node-1");
    expect(applyVolumeFilter([a, b], "largestN", 1).map((e) => e.entityId)).toEqual(["node-1"]);
    expect(applyVolumeFilter([a, b], "sizeLte", 5).map((e) => e.entityId)).toEqual(["node-0"]);
  });

  it("degenerate and non-surface targets are dropped, never thrown", () => {
    const empty = new THREE.Mesh(new THREE.BufferGeometry());
    empty.userData.entityType = "surface";
    empty.userData.entityId = "face-empty";
    empty.userData.groupId = "solid-empty";
    const nanBox = boxFace(2, 0, "face-nan", "solid-nan");
    nanBox.position.set(NaN, 0, 0);
    const line = new THREE.Line(new THREE.BufferGeometry());
    line.userData.entityType = "line";
    line.userData.entityId = "edge-0";
    line.userData.groupId = "solid-line";
    expect(groupVolumes([empty, nanBox])).toEqual([]);
    expect(applyVolumeFilter([empty, nanBox, line], "sizeGte", 0)).toEqual([]);
  });
});

describe("selectFilters point predicates", () => {
  function pointAt(x: number, y: number, z: number, entityId: string): THREE.Sprite {
    const s = new THREE.Sprite();
    s.position.set(x, y, z);
    s.userData.entityType = "point";
    s.userData.entityId = entityId;
    return s;
  }

  const REF = new THREE.Vector3(0, 0, 0);

  it("plane proximity reads the matching coordinate only", () => {
    const near = pointAt(3, 4, 0.5, "point-near");
    const far = pointAt(0, 0, 5, "point-far");
    expect(applyPointFilter([near, far], "nearXY", 1, null).map((e) => e.entityId)).toEqual(["point-near"]);
    expect(applyPointFilter([near, far], "nearXZ", 1, null).map((e) => e.entityId)).toEqual(["point-far"]);
    // nearYZ reads |x|: near sits at x=3, far at x=0
    expect(applyPointFilter([near, far], "nearYZ", 1, null).map((e) => e.entityId)).toEqual(["point-far"]);
  });

  it("nearSelectionLte measures distance to the reference", () => {
    const close = pointAt(1, 0, 0, "point-close");
    const away = pointAt(10, 0, 0, "point-away");
    expect(applyPointFilter([close, away], "nearSelectionLte", 2, REF).map((e) => e.entityId)).toEqual(["point-close"]);
  });

  it("reference predicates with a null reference match nothing", () => {
    const p = pointAt(0, 0, 0, "point-0");
    expect(applyPointFilter([p], "nearSelectionLte", 100, null)).toEqual([]);
    expect(applyPointFilter([p], "inSelectionBox", 100, null)).toEqual([]);
  });

  it("inSelectionBox contains its boundary and rejects a non-positive size", () => {
    const inside = pointAt(1, 1, 1, "point-in");
    const onFace = pointAt(2, 0, 0, "point-face");
    const outside = pointAt(2.5, 0, 0, "point-out");
    expect(
      applyPointFilter([inside, onFace, outside], "inSelectionBox", 4, REF).map((e) => e.entityId).sort()
    ).toEqual(["point-face", "point-in"]);
    expect(applyPointFilter([inside], "inSelectionBox", 0, REF)).toEqual([]);
    expect(applyPointFilter([inside], "inSelectionBox", -3, REF)).toEqual([]);
  });

  it("positions are world-space and non-point targets are ignored", () => {
    const parent = new THREE.Group();
    parent.position.set(10, 0, 0);
    const child = pointAt(0, 0, 0, "point-moved");
    parent.add(child);
    expect(pointPosition(child)!.x).toBeCloseTo(10, 5);
    expect(applyPointFilter([child], "nearYZ", 1, null)).toEqual([]);
    expect(applyPointFilter([child], "nearYZ", 11, null).map((e) => e.entityId)).toEqual(["point-moved"]);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.userData.entityType = "surface";
    mesh.userData.entityId = "face-0";
    expect(applyPointFilter([mesh as unknown as THREE.Sprite], "nearXY", 100, null)).toEqual([]);
  });
});
