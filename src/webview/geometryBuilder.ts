import * as THREE from "three";
import type { EncodedMesh, EncodedEdge, EncodedPoint, MeshElementGroup } from "../protocol";
import { valueToColor } from "./colorMap";
import { paletteColor } from "./palette";

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

/**
 * Base colours for unassigned entities — now theme-reactive, resolved from
 * `palette.ts` on each call rather than being frozen constants.
 *
 * These are functions, not constants, precisely because a constant is captured
 * at module load and can never track a theme change. Both re-apply paths that
 * matter (`Viewer.setEntityColors`, `Viewer.renderSelection`) call them fresh,
 * so re-running `main.ts`'s `refreshColors()` after a theme change re-themes
 * the whole model — and, because those call sites only reach the default in
 * the `?? default` branch, a per-Part colour swatch is structurally immune to
 * being re-tinted. See `palette.ts`.
 */
export const defaultFaceColor = (): number => paletteColor("face");
export const defaultEdgeColor = (): number => paletteColor("edge");
export const defaultPointColor = (): number => paletteColor("point");

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
    color: defaultFaceColor(),
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
  // Stashed so `Viewer.setDisplayMode()`'s Flat mode (a genuine material-class
  // swap to an unlit `MeshBasicMaterial`, cached lazily in `userData.flatMaterial`
  // on first use) always has a reliable reference back to the original shaded
  // material to swap back to — `mesh.material` itself may already BE the flat
  // material by the time a later mode switch runs.
  mesh.userData.standardMaterial = mesh.material;
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
  const material = new THREE.LineBasicMaterial({ color: defaultEdgeColor() });
  const line = new THREE.Line(geometry, material);
  line.userData.entityType = "line";
  line.userData.entityId = ee.edgeId;
  // Roadmap "Display-edge classification, as a flag", closed — a tangent
  // patch-seam continuation, not a real feature edge. `Viewer.setSmoothEdgesVisible()`
  // reads this to implement the "Hide smooth edges" toggle; never filtered
  // out here or host-side (that would renumber `edge-N`).
  line.userData.smooth = ee.smooth;
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
  const material = new THREE.SpriteMaterial({ map: dotTexture(), color: defaultPointColor() });
  const sprite = new THREE.Sprite(material);
  sprite.position.set(position[0], position[1], position[2]);
  sprite.scale.setScalar(0.02);
  sprite.userData.entityType = "point";
  sprite.userData.entityId = ep.pointId;
  return sprite;
}

/** Default overlay colour for triangles not claimed by any part — distinct hue
 * from the default face colour so an overlay is visually distinguishable. */
const defaultMeshColor = (): number => paletteColor("mesh");

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
 * to the pre-parts behavior. The wireframe is unaffected by grouping (it's a
 * single `LineBasicMaterial`, no per-element colour).
 *
 * `edges` is the host-supplied **true element-edge** line buffer (quad
 * perimeters for hexes/quads, triangle edges for tets/tris). The wireframe is
 * built from it — NOT from a `THREE.WireframeGeometry` of the triangulated fill,
 * which would draw the diagonal splitting every quad and make a hex mesh look
 * identical to a tet mesh.
 */
export function buildFEMesh(
  positionsB64: string,
  indicesB64: string,
  edgesB64: string,
  elementGroups: MeshElementGroup[]
): THREE.Group {
  const positions = decodeF32(positionsB64);
  const indices = decodeU32(indicesB64);
  const edges = decodeU32(edgesB64);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  const groups = elementGroups.length > 0 ? elementGroups : [{ name: null, color: null, indexStart: 0, indexCount: indices.length }];
  const materials = groups.map((g) => {
    const material = new THREE.MeshBasicMaterial({
        color: g.color ?? defaultMeshColor(),
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
      });
    // `Viewer.applyTheme()` repaints only materials still at the default; a
    // real per-part colour (`g.color`) is user data and must survive a theme
    // change, exactly as a Part's face swatch does.
    material.userData.themedDefault = g.color == null;
    return material;
  });
  groups.forEach((g, i) => geometry.addGroup(g.indexStart, g.indexCount, i));

  const mesh = new THREE.Mesh(geometry, materials);
  mesh.userData.entityType = "mesh";

  // Wireframe from the true element edges (shared `positions`, own line index),
  // so hexes draw as quads and tets as triangles — no triangulation diagonals.
  const wireGeometry = new THREE.BufferGeometry();
  wireGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  wireGeometry.setIndex(new THREE.BufferAttribute(edges, 1));
  const wireMaterial = new THREE.LineBasicMaterial({ color: paletteColor("meshWire") });
  const wireframe = new THREE.LineSegments(wireGeometry, wireMaterial);
  wireframe.userData.entityType = "mesh";

  const group = new THREE.Group();
  group.name = "feMesh";
  group.add(mesh);
  group.add(wireframe);
  return group;
}

/** Highlight colour for `buildWorstElementsHighlight` — a distinct, alarming
 * hue (unlike the default mesh colour, which is meant to blend in as "the mesh"). */
const worstElementColor = (): number => paletteColor("worstElement");

/**
 * Builds the "worst-quality elements" highlight overlay from
 * `MeshResult.worstElements`/`meshingResult.worstElements` — a small subset of
 * the mesh's own worst-quality elements, closing the roadmap gap where bad
 * tets are frequently *interior* and invisible in the boundary-only FE
 * overlay above. `indicesB64` is already the selected elements' own full
 * boundary (`gmshService.ts`'s `computeQualityAndWorstElements`, via
 * `boundaryTriangles`), indexing into the SAME decoded `positions` buffer
 * `buildFEMesh` uses — so no extra geometry work is needed here, only styling.
 *
 * The styling is the actual fix for "invisible when interior": mirrors
 * `Viewer`'s existing Hidden-Lines ghost-line technique
 * (`transparent: true, depthTest: false, depthWrite: false`) so the highlight
 * paints through occluding faces regardless of true 3D depth — no clip plane
 * or cutaway needed to see a bad element buried deep inside the model.
 * Returns `null` for an empty index buffer (nothing scored below threshold),
 * so `Viewer.setWorstElementsOverlay(null)` cleanly clears any prior overlay.
 */
export function buildWorstElementsHighlight(positionsB64: string, indicesB64: string): THREE.Object3D | null {
  const indices = decodeU32(indicesB64);
  if (indices.length === 0) return null;
  const positions = decodeF32(positionsB64);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    color: worstElementColor(),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  // Same "mesh", not "surface" — excluded from picking/parts-colouring, same
  // reasoning as buildFEMesh's shaded mesh/wireframe above.
  mesh.userData.entityType = "mesh";

  const group = new THREE.Group();
  group.name = "feMeshWorstElements";
  group.add(mesh);
  return group;
}

/**
 * Builds the "colour by scalar field" overlay (roadmap item, closed) — a
 * scene sibling of `model`, same "never mutate the original geometry"
 * pattern as `buildFEMesh`/`buildWorstElementsHighlight` above, rather than
 * recolouring the model's own per-facet split sub-meshes in place. That's a
 * deliberate choice, not the obvious one: `splitMeshesIntoFacets` regroups
 * triangles by coplanarity into NEW per-facet geometries whose vertex order
 * bears no relation to the original file's triangle order the host's
 * `readMeshioFieldValues` correlates against, so painting the field onto
 * those sub-meshes directly would need re-deriving the same triangle→facet
 * mapping this overlay sidesteps entirely by building straight from
 * `basePositions` — the caller's UNSPLIT `pristineMesh` geometry, i.e. the
 * exact same triangle-soup order the host's per-CORNER `values` already
 * line up with (see `protocol.ts`'s `colorFieldResult` doc comment).
 *
 * `basePositions` is passed as a live `Float32Array` (not base64) since it's
 * already sitting in the browser from the original STL load — only the
 * (much smaller, one-per-corner) scalar `values` need to travel over
 * postMessage. Unlit (`MeshBasicMaterial({vertexColors: true})`), matching
 * `buildFEMesh`'s reasoning for the same triangle-soup-shading-artifact
 * avoidance; `polygonOffset` is unnecessary here since this overlay always
 * replaces the model's own faces (`Viewer` hides them while it's shown),
 * unlike `buildFEMesh`'s coincident wireframe.
 */
export function buildColorFieldOverlay(basePositions: Float32Array, valuesB64: string, min: number, max: number): THREE.Object3D {
  const values = decodeF32(valuesB64);
  const colors = new Float32Array(basePositions.length);
  const count = Math.min(values.length, basePositions.length / 3);
  for (let i = 0; i < count; i++) {
    const [r, g, b] = valueToColor(values[i], min, max);
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(basePositions.slice(), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.entityType = "mesh"; // excluded from picking/parts-colouring, same as buildFEMesh's shaded mesh

  const group = new THREE.Group();
  group.name = "colorFieldOverlay";
  group.add(mesh);
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
