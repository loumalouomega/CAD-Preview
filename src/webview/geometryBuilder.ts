import * as THREE from "three";
import type { EncodedMesh } from "../protocol";

/** Decode a base64 string back to a Float32Array. */
function decodeF32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** Decode a base64 string back to a Uint32Array. */
function decodeU32(b64: string): Uint32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Uint32Array(bytes.buffer);
}

/**
 * Builds a single merged `THREE.Mesh` from an array of per-face encoded meshes.
 * Normals are computed from geometry (smooth per vertex).
 */
export function buildMeshFromEncoded(encodedMeshes: EncodedMesh[]): THREE.Mesh {
  const allPositions: Float32Array[] = [];
  const allIndices: Uint32Array[] = [];
  let vertexOffset = 0;

  for (const em of encodedMeshes) {
    const positions = decodeF32(em.positions);
    const indices = decodeU32(em.indices);

    allPositions.push(positions);
    // Offset indices so they remain valid after merging all face buffers.
    const offsetIndices = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i++) {
      offsetIndices[i] = indices[i] + vertexOffset;
    }
    allIndices.push(offsetIndices);
    vertexOffset += positions.length / 3;
  }

  // Concatenate into a single typed array.
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

  const material = new THREE.MeshStandardMaterial({
    color: 0xc0c4cc,
    metalness: 0.1,
    roughness: 0.7,
    side: THREE.DoubleSide,
    flatShading: false,
  });

  return new THREE.Mesh(geometry, material);
}
