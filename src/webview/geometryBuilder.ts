import * as THREE from "three";
import type { EncodedMesh, EncodedEdge, EncodedPoint, MeshElementGroup } from "../protocol";

function decodeF32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function decodeU32(b64: string): Uint32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Uint32Array(bytes.buffer);
}

/** Base surface colour for unassigned faces. */
export const DEFAULT_FACE_COLOR = 0xc0c4cc;
/** Base colour for unassigned edges. */
export const DEFAULT_EDGE_COLOR = 0x303338;
/** Base colour for unassigned points. */
export const DEFAULT_POINT_COLOR = 0xffcc00;

/**
 * A single filled-circle dot, drawn once onto a canvas and shared by every
 * point sprite (asset-free / CSP-safe, same canvas-drawing technique
 * `orientationCube.ts` uses for its face labels). Only `SpriteMaterial.color`
 * differs per instance — mirrors {@link makeFaceMaterial}'s shared-geometry/
 * texture, per-instance-colour split. Lazily built and memoized on first use
 * (not at module load) so importing this module never requires a DOM/canvas —
 * `viewer.test.ts` and friends import this module without jsdom.
 */
let _dotTexture: THREE.CanvasTexture | null = null;
function dotTexture(): THREE.CanvasTexture {
  if (!_dotTexture) {
    const s = 64;
    const canvas = document.createElement("canvas");
    canvas.width = s;
    canvas.height = s;
    const ctx = canvas.getContext("2d")!;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2 - 2, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    _dotTexture = new THREE.CanvasTexture(canvas);
    _dotTexture.anisotropy = 4;
  }
  return _dotTexture;
}

/** A fresh material per face so faces can be coloured independently. */
export function makeFaceMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: DEFAULT_FACE_COLOR,
    metalness: 0.1,
    roughness: 0.7,
    side: THREE.DoubleSide,
    flatShading: false,
  });
}

function buildFaceMesh(em: EncodedMesh): THREE.Mesh {
  const positions = decodeF32(em.positions);
  const indices = decodeU32(em.indices);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, makeFaceMaterial());
  // `groupId` keeps the existing per-solid `highlightGroup` working; the entity
  // fields drive picking and per-part colouring.
  mesh.userData.groupId = em.groupId;
  mesh.userData.entityType = "surface";
  mesh.userData.entityId = em.faceId;
  return mesh;
}

function buildEdgeLine(ee: EncodedEdge): THREE.Line {
  const positions = decodeF32(ee.positions);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({ color: DEFAULT_EDGE_COLOR });
  const line = new THREE.Line(geometry, material);
  line.userData.entityType = "line";
  line.userData.entityId = ee.edgeId;
  return line;
}

/**
 * A `THREE.Sprite` marker for one vertex — NOT `THREE.Points`/`PointsMaterial`,
 * which packs every point into one `BufferGeometry` and raycasts to an index
 * rather than a distinct `Object3D`, breaking the "one entity, one tagged
 * object" invariant `picking.ts`/`viewer.ts` rely on for every other entity
 * kind. A Sprite is individually pickable/colourable at near-zero geometry
 * cost and stays camera-facing regardless of view angle. The initial scale is
 * a placeholder — `Viewer.frame()` rescales every point sprite proportional to
 * the model's bounding radius once it's known, the same way `pickThreshold` is
 * computed there for edge picking.
 */
function buildPointSprite(ep: EncodedPoint): THREE.Sprite {
  const position = decodeF32(ep.position); // length 3: x, y, z
  const material = new THREE.SpriteMaterial({ map: dotTexture(), color: DEFAULT_POINT_COLOR });
  const sprite = new THREE.Sprite(material);
  sprite.position.set(position[0], position[1], position[2]);
  sprite.scale.setScalar(0.02);
  sprite.userData.entityType = "point";
  sprite.userData.entityId = ep.pointId;
  return sprite;
}

/** Default overlay colour for triangles not claimed by any part — distinct hue
 * from DEFAULT_FACE_COLOR so an overlay is visually distinguishable. */
const DEFAULT_MESH_COLOR = 0x4ea1ff;

/**
 * Builds a display group for a generated FE (finite-element) surface mesh — the
 * GMSH-produced triangulation shown as an overlay via `Viewer.setMeshOverlay`,
 * distinct from the model's own B-rep/native faces. Contains a shaded
 * `THREE.Mesh` plus a `THREE.LineSegments` wireframe over the same geometry, both
 * tagged `userData.entityType = "mesh"` — deliberately NOT `"surface"`/`"line"`,
 * so the existing parts/selection code (which keys off
 * `"surface"|"line"|"point"|"volume"`) never picks or colours it.
 *
 * `elementGroups` partitions the triangle buffer into per-part colour ranges
 * (from `gmshService.ts`'s physical-group-derived grouping); each becomes a
 * `geometry.addGroup` range + its own `MeshBasicMaterial`, so the shaded mesh
 * renders multi-material. An empty `elementGroups` (no parts resolved) falls
 * back to a single default-blue range covering the whole buffer — identical
 * to the pre-parts behavior. The wireframe is unaffected by grouping (its
 * `WireframeGeometry` is pure line topology, no per-triangle colour) and stays
 * a single `LineBasicMaterial`, same as before.
 */
export function buildFEMesh(positionsB64: string, indicesB64: string, elementGroups: MeshElementGroup[]): THREE.Group {
  const positions = decodeF32(positionsB64);
  const indices = decodeU32(indicesB64);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  const groups = elementGroups.length > 0 ? elementGroups : [{ name: null, color: null, indexStart: 0, indexCount: indices.length }];
  const materials = groups.map(
    (g) =>
      new THREE.MeshBasicMaterial({
        color: g.color ?? DEFAULT_MESH_COLOR,
        side: THREE.DoubleSide,
        // Unlit on purpose: a tet-mesh boundary is thousands of small, irregularly
        // oriented triangles (unlike a smooth NURBS-tessellated B-rep face), so a
        // lit material (MeshStandardMaterial) shades each one differently under the
        // scene's directional/hemisphere lights — triangles facing away from the
        // light go dark/near-black, which reads as scattered holes even though the
        // geometry is a complete, watertight surface. A flat unlit color removes
        // that per-facet brightness variation entirely.
        //
        // The wireframe below is built from this exact geometry, so its lines are
        // perfectly coincident with these triangles' surface — without pushing the
        // filled polygons back in depth, the GPU's per-pixel depth test can't
        // reliably resolve which one wins, producing a z-fighting speckle on top of
        // the shading issue above.
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      })
  );
  groups.forEach((g, i) => geometry.addGroup(g.indexStart, g.indexCount, i));

  const mesh = new THREE.Mesh(geometry, materials);
  mesh.userData.entityType = "mesh";

  const wireGeometry = new THREE.WireframeGeometry(geometry);
  const wireMaterial = new THREE.LineBasicMaterial({ color: 0x1a3d66 });
  const wireframe = new THREE.LineSegments(wireGeometry, wireMaterial);
  wireframe.userData.entityType = "mesh";

  const group = new THREE.Group();
  group.name = "feMesh";
  group.add(mesh);
  group.add(wireframe);
  return group;
}

/**
 * Builds the model `THREE.Group` from per-face encoded meshes, per-edge
 * polylines, and per-vertex points. Layout:
 *   root
 *     ├─ solid group (userData.groupId = solidId)
 *     │    └─ face mesh (entityType "surface", entityId faceId, groupId solidId)
 *     ├─ "edges" group
 *     │    └─ edge line (entityType "line", entityId edgeId)
 *     └─ "points" group
 *          └─ point sprite (entityType "point", entityId pointId)
 * Each face/edge/point is its own object with its own material, so it can be
 * picked and coloured independently.
 */
export function buildGroupFromEncoded(
  encodedMeshes: EncodedMesh[],
  encodedEdges: EncodedEdge[] = [],
  encodedPoints: EncodedPoint[] = []
): THREE.Group {
  const byGroup = new Map<string, EncodedMesh[]>();
  for (const em of encodedMeshes) {
    const gid = em.groupId ?? "default";
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid)!.push(em);
  }

  const root = new THREE.Group();
  for (const [solidId, meshes] of byGroup) {
    const solidGroup = new THREE.Group();
    solidGroup.userData.groupId = solidId;
    for (const em of meshes) solidGroup.add(buildFaceMesh(em));
    root.add(solidGroup);
  }

  if (encodedEdges.length > 0) {
    const edgesGroup = new THREE.Group();
    edgesGroup.name = "edges";
    for (const ee of encodedEdges) edgesGroup.add(buildEdgeLine(ee));
    root.add(edgesGroup);
  }

  if (encodedPoints.length > 0) {
    const pointsGroup = new THREE.Group();
    pointsGroup.name = "points";
    for (const ep of encodedPoints) pointsGroup.add(buildPointSprite(ep));
    root.add(pointsGroup);
  }

  return root;
}
