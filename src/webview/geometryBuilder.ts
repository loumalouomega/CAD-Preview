import * as THREE from "three";
import type { EncodedMesh } from "../protocol";

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

function makeMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xc0c4cc,
    metalness: 0.1,
    roughness: 0.7,
    side: THREE.DoubleSide,
    flatShading: false,
  });
}

function mergeAndBuild(meshes: EncodedMesh[]): THREE.Mesh {
  const allPositions: Float32Array[] = [];
  const allIndices: Uint32Array[] = [];
  let vertexOffset = 0;

  for (const em of meshes) {
    const positions = decodeF32(em.positions);
    const indices = decodeU32(em.indices);
    allPositions.push(positions);
    const offsetIndices = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i++) offsetIndices[i] = indices[i] + vertexOffset;
    allIndices.push(offsetIndices);
    vertexOffset += positions.length / 3;
  }

  const totalVerts = allPositions.reduce((s, a) => s + a.length, 0);
  const totalIdx = allIndices.reduce((s, a) => s + a.length, 0);
  const mergedPos = new Float32Array(totalVerts);
  const mergedIdx = new Uint32Array(totalIdx);

  let pOff = 0;
  for (const p of allPositions) { mergedPos.set(p, pOff); pOff += p.length; }
  let iOff = 0;
  for (const idx of allIndices) { mergedIdx.set(idx, iOff); iOff += idx.length; }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mergedPos, 3));
  geometry.setIndex(new THREE.BufferAttribute(mergedIdx, 1));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, makeMaterial());
}

/**
 * Builds a `THREE.Group` from per-face encoded meshes, grouping by `groupId`.
 * Each solid becomes a separate `THREE.Mesh` child so it can be highlighted
 * independently. `mesh.userData.groupId` stores the solid id.
 */
export function buildGroupFromEncoded(encodedMeshes: EncodedMesh[]): THREE.Group {
  const byGroup = new Map<string, EncodedMesh[]>();
  for (const em of encodedMeshes) {
    const gid = em.groupId ?? "default";
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid)!.push(em);
  }

  const group = new THREE.Group();
  for (const [groupId, meshes] of byGroup) {
    const mesh = mergeAndBuild(meshes);
    mesh.userData.groupId = groupId;
    group.add(mesh);
  }
  return group;
}
