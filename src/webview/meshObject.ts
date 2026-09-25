/**
 * Builds the three.js object a mesh-format source (STL/OBJ/PLY/glTF) is
 * displayed and edited as, from its raw bytes — shared by the webview's
 * loader (`meshLoaders.ts`) and the kernel worker's headless mesh-edit bake
 * (`meshEditBake.ts`).
 *
 * Sharing it is what keeps edit-op targets meaningful headlessly. Mesh ops
 * name `node-N` ids that `tagMeshEntities` assigns in traversal order of the
 * LOADER'S output (an OBJ is a Group of child meshes, a glTF a full node
 * hierarchy). A host-side welded parse would collapse that hierarchy and
 * silently retarget every op, so the host runs these same loaders instead.
 *
 * DOM-free at import and at call time for STL/OBJ/PLY. glTF strips
 * materials/textures/images/samplers first (the texture path is the only one
 * that needs `Image`/`createImageBitmap`); a material creates no scene node,
 * so the id order is unaffected. `GLTFLoader` also constructs a
 * `ProgressEvent`, polyfilled inside `parseGltfObject` when absent.
 */

import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { defaultFaceColor } from "./geometryBuilder";
import type { GltfExternalBuffers } from "../gltfParser";

/** Builds a standard-material mesh for a raw geometry, computing normals if absent. */
export function meshFromGeometry(geometry: THREE.BufferGeometry): THREE.Mesh {
  if (!geometry.getAttribute("normal")) {
    geometry.computeVertexNormals();
  }
  const material = new THREE.MeshStandardMaterial({
    color: defaultFaceColor(),
    metalness: 0.1,
    roughness: 0.7,
    side: THREE.DoubleSide,
    flatShading: false,
  });
  return new THREE.Mesh(geometry, material);
}

/** Apply a default material to OBJ meshes that arrive without one. */
export function applyDefaultMaterial(group: THREE.Object3D): void {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xc0c4cc,
    metalness: 0.1,
    roughness: 0.7,
    side: THREE.DoubleSide,
  });
  group.traverse((child) => {
    if (child instanceof THREE.Mesh && !child.material) {
      child.material = mat;
    }
  });
}

/**
 * Tags a loaded model with STABLE ids (traversal order, not uuid) so part
 * assignments and edit-op targets round-trip across reopen — and match
 * between the webview and the headless bake. Each object's id becomes its
 * `groupId`; a mesh's id is its volume id, carried onto the facet group built
 * by `splitMeshesIntoFacets`.
 */
export function tagMeshEntities(obj: THREE.Object3D): void {
  let i = 0;
  obj.traverse((o) => {
    o.userData.groupId = `node-${i++}`;
  });
}

/** Parses STL/OBJ/PLY bytes exactly as the webview's loader does. */
export function parseMeshObject(bytes: ArrayBuffer | Uint8Array, format: "stl" | "obj" | "ply"): THREE.Object3D {
  const buf = toArrayBuffer(bytes);
  switch (format) {
    case "stl":
      return meshFromGeometry(new STLLoader().parse(buf));
    case "obj": {
      const group = new OBJLoader().parse(new TextDecoder().decode(buf));
      applyDefaultMaterial(group);
      return group;
    }
    case "ply": {
      const geometry = new PLYLoader().parse(buf);
      geometry.computeVertexNormals();
      return meshFromGeometry(geometry);
    }
  }
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/**
 * Parses a `.gltf`/`.glb` into its scene with materials stripped and every
 * buffer inlined as a `data:` URI (the GLB's BIN chunk and any resolved
 * external `.bin`), so no network or DOM access is needed. Rejects when the
 * loader does (e.g. a required Draco/meshopt extension, or an external buffer
 * that was not supplied).
 */
export async function parseGltfObject(bytes: Uint8Array, external?: GltfExternalBuffers): Promise<THREE.Object3D> {
  // GLTFLoader constructs a ProgressEvent (a DOM API). A no-op in the
  // webview, where it exists; the Node stand-in for the headless bake.
  (globalThis as { ProgressEvent?: unknown }).ProgressEvent ??= class ProgressEvent {
    constructor(public type: string, _init?: unknown) {}
  };
  const { json, bin } = splitGltfContainer(bytes);
  const doc = JSON.parse(json) as Record<string, unknown>;
  delete doc.materials;
  delete doc.textures;
  delete doc.images;
  delete doc.samplers;
  for (const mesh of (doc.meshes as { primitives?: Record<string, unknown>[] }[] | undefined) ?? []) {
    for (const prim of mesh.primitives ?? []) delete prim.material;
  }
  const buffers = (doc.buffers as { uri?: string; byteLength?: number }[] | undefined) ?? [];
  buffers.forEach((buffer, i) => {
    let data: Uint8Array | undefined;
    if (buffer.uri === undefined) {
      if (i === 0 && bin) data = bin;
    } else if (!buffer.uri.startsWith("data:")) {
      data = lookupExternal(external, buffer.uri);
      if (!data) throw new Error(`glTF external buffer "${buffer.uri}" was not supplied.`);
    }
    if (data) buffer.uri = `data:application/octet-stream;base64,${bytesToBase64(data)}`;
  });
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    new GLTFLoader().parse(JSON.stringify(doc), "", (g) => resolve(g as { scene: THREE.Group }), (err) => reject(err));
  });
  return gltf.scene;
}

function splitGltfContainer(bytes: Uint8Array): { json: string; bin?: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || view.getUint32(0, true) !== GLB_MAGIC) {
    return { json: new TextDecoder().decode(bytes) };
  }
  let json = "";
  let bin: Uint8Array | undefined;
  let at = 12;
  const end = Math.min(view.getUint32(8, true), bytes.byteLength);
  while (at + 8 <= end) {
    const len = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    const chunk = bytes.subarray(at + 8, at + 8 + len);
    if (type === CHUNK_JSON) json = new TextDecoder().decode(chunk);
    else if (type === CHUNK_BIN && !bin) bin = chunk;
    at += 8 + len;
  }
  return { json, bin };
}

function lookupExternal(external: GltfExternalBuffers | undefined, uri: string): Uint8Array | undefined {
  // Keyed by the raw URI string, as `resolveExternalBuffers` stores it.
  return external?.[uri];
}

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  // A Node Buffer may be a view into a shared pool — copy out its own bytes.
  // NOT `bytes.slice()`: on a Buffer that is a view (subarray semantics), so
  // `.buffer` would be the whole pool and STLLoader reads a garbage header.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
