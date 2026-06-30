import * as THREE from "three";
import type { EncodedMesh, EncodedEdge } from "../protocol";

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
 * Builds the model `THREE.Group` from per-face encoded meshes and per-edge
 * polylines. Layout:
 *   root
 *     ├─ solid group (userData.groupId = solidId)
 *     │    └─ face mesh (entityType "surface", entityId faceId, groupId solidId)
 *     └─ "edges" group
 *          └─ edge line (entityType "line", entityId edgeId)
 * Each face/edge is its own object with its own material, so it can be picked
 * and coloured independently.
 */
export function buildGroupFromEncoded(
  encodedMeshes: EncodedMesh[],
  encodedEdges: EncodedEdge[] = []
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

  return root;
}
