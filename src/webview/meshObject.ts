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
import type { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { defaultFaceColor } from "./geometryBuilder";
import { markNativeColor } from "./nativeColor";
import type { GltfExternalBuffers } from "../gltfParser";
import { inflateGltfDocument } from "../gltfInflate";

/**
 * Builds a standard-material mesh for a raw geometry, computing normals if
 * absent. A geometry that arrives with a `color` attribute (PLY vertex
 * colours) gets a vertex-coloured material, white so the file's colours show
 * unmodified, and is marked native (`nativeColor.ts`) so the Part-colour
 * pipeline neither overwrites nor multiplies it.
 */
export function meshFromGeometry(geometry: THREE.BufferGeometry): THREE.Mesh {
  if (!geometry.getAttribute("normal")) {
    geometry.computeVertexNormals();
  }
  const coloured = !!geometry.getAttribute("color");
  const material = new THREE.MeshStandardMaterial({
    color: coloured ? 0xffffff : defaultFaceColor(),
    vertexColors: coloured,
    metalness: 0.1,
    roughness: 0.7,
    side: THREE.DoubleSide,
    flatShading: false,
  });
  if (coloured) markNativeColor(material);
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

/**
 * Re-expresses the materials an `.mtl` produced (`MeshPhongMaterial`) as the
 * viewer's standard material, marked native: the diffuse colour (`Kd`) and
 * diffuse map (`map_Kd`) are kept; transparency (`d`/`Tr`), specular, bump and
 * other maps are deliberately dropped — the viewer composes opacity itself
 * (`baseOpacity`) and shades with its own lights. A material array stays an
 * array (one entry per `usemtl`) so `geometry.groups` keeps indexing it; the
 * facet split (`meshFacets.ts`) is what turns that into single-material meshes.
 * Meshes whose materials carry no `.mtl` information (the bare names OBJLoader
 * invents for each `usemtl`) are left as they are — only call this after
 * `OBJLoader.setMaterials`.
 */
export function convertObjMaterials(group: THREE.Object3D): void {
  const converted = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  const convert = (m: THREE.Material): THREE.Material => {
    const phong = m as THREE.MeshPhongMaterial;
    if (!phong.isMeshPhongMaterial) return m;
    let out = converted.get(m);
    if (!out) {
      out = new THREE.MeshStandardMaterial({
        color: phong.color.getHex(),
        map: phong.map ?? null,
        metalness: 0.1,
        roughness: 0.7,
        side: THREE.DoubleSide,
      });
      out.name = phong.name;
      markNativeColor(out);
      converted.set(m, out);
    }
    return out;
  };
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.material = Array.isArray(child.material) ? child.material.map(convert) : convert(child.material);
  });
}

/**
 * Re-expresses the materials a 3MF produced (`MeshPhongMaterial`, or
 * `MeshStandardMaterial` for a metallic `basematerials`) as the viewer's
 * standard material, marked native: the `displaycolor` (alpha dropped — the
 * viewer composes opacity itself), a `colorgroup`'s vertex colours and a
 * texture map are kept. The loader's own fallback for a triangle with no
 * `pid` (named `THREE.Loader.DEFAULT_MATERIAL_NAME`, plain white) is NOT a
 * file colour: it is cleared so `applyDefaultMaterial` gives it the palette
 * look and a Part colour is not shadowed by a stashed white.
 */
export function convertThreeMfMaterials(group: THREE.Object3D): void {
  const converted = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const src = child.material as THREE.Material;
    if (!src || src.name === THREE.Loader.DEFAULT_MATERIAL_NAME) {
      child.material = undefined as unknown as THREE.Material;
      return;
    }
    const phong = src as THREE.MeshPhongMaterial;
    if (!phong.isMeshPhongMaterial && !(src as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
    let out = converted.get(src);
    if (!out) {
      out = new THREE.MeshStandardMaterial({
        color: phong.color.getHex(),
        map: phong.map ?? null,
        vertexColors: phong.vertexColors,
        metalness: 0.1,
        roughness: 0.7,
        side: THREE.DoubleSide,
      });
      out.name = phong.name;
      markNativeColor(out);
      converted.set(src, out);
    }
    child.material = out;
  });
}

/**
 * Re-expresses the materials a Collada (`.dae`) produced (Phong / Lambert /
 * Basic, all with a flat `color`) as the viewer's standard material, marked
 * native so the file's colour shows and a Part colour still wins. Textures are
 * deliberately dropped (sibling image files are outside the webview's CSP
 * reach and the viewer is a geometry tool).
 *
 * Two loader artefacts are NOT file colours and are cleared so
 * `applyDefaultMaterial` gives them the palette look: the loader's magenta
 * fallback for an unresolved material binding (named
 * `THREE.Loader.DEFAULT_MATERIAL_NAME`), and the plain white, unnamed,
 * textureless `MeshPhongMaterial` it invents for a primitive with no material
 * at all. A file material that really is plain white and unnamed is
 * indistinguishable from the latter and is treated the same.
 */
export function convertColladaMaterials(group: THREE.Object3D): void {
  const converted = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  const convert = (src: THREE.Material | undefined): THREE.Material | undefined => {
    if (!src || src.name === THREE.Loader.DEFAULT_MATERIAL_NAME) return undefined;
    const c = (src as THREE.MeshPhongMaterial).color;
    if (!c || !(c as THREE.Color).isColor) return undefined;
    const m = src as THREE.MeshPhongMaterial;
    if (src.name === "" && !m.map && c.getHex() === 0xffffff) return undefined;
    let out = converted.get(src);
    if (!out) {
      out = new THREE.MeshStandardMaterial({
        color: c.getHex(),
        metalness: 0.1,
        roughness: 0.7,
        side: THREE.DoubleSide,
      });
      out.name = src.name;
      markNativeColor(out);
      converted.set(src, out);
    }
    return out;
  };
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mats = child.material;
    if (Array.isArray(mats)) {
      // A multi-material mesh keeps every slot (group material indices stay
      // valid): a cleared slot becomes the default look explicitly.
      const fallback = new THREE.MeshStandardMaterial({ color: 0xc0c4cc, metalness: 0.1, roughness: 0.7, side: THREE.DoubleSide });
      child.material = mats.map((m) => convert(m) ?? fallback);
    } else {
      child.material = convert(mats) as THREE.Material;
    }
  });
}

/**
 * Re-expresses the materials an AMF produced (`MeshPhongMaterial`, flat
 * shaded) as the viewer's standard material, marked native so the file's
 * colour shows and a Part colour still wins. Alpha is dropped (the viewer
 * composes opacity itself).
 *
 * The loader's fallback for a volume with no material is a clone of a material
 * named `THREE.Loader.DEFAULT_MATERIAL_NAME` coloured 0xaaaaff; that is NOT a
 * file colour and is cleared so `applyDefaultMaterial` gives it the palette
 * look. A mesh-level `<color>` reuses that same name with a different colour,
 * so the name alone cannot decide: only the fallback's exact colour is cleared.
 */
export function convertAmfMaterials(group: THREE.Object3D): void {
  const converted = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const src = child.material as THREE.Material | undefined;
    const phong = src as THREE.MeshPhongMaterial | undefined;
    if (!phong || !phong.isMeshPhongMaterial) {
      child.material = undefined as unknown as THREE.Material;
      return;
    }
    if (phong.name === THREE.Loader.DEFAULT_MATERIAL_NAME && phong.color.getHex() === 0xaaaaff) {
      child.material = undefined as unknown as THREE.Material;
      return;
    }
    let out = converted.get(phong);
    if (!out) {
      out = new THREE.MeshStandardMaterial({
        color: phong.color.getHex(),
        metalness: 0.1,
        roughness: 0.7,
        side: THREE.DoubleSide,
      });
      out.name = phong.name;
      markNativeColor(out);
      converted.set(phong, out);
    }
    child.material = out;
  });
}

/**
 * Parses OBJ text. With a loaded `.mtl` (`MTLLoader.parse(...)` result,
 * preloaded) the file's materials are applied natively; without one this is
 * exactly what the headless bake parses, so the object hierarchy — and every
 * `node-N` id — is identical either way (OBJLoader builds the same objects
 * whether or not it has materials).
 */
export function parseObjObject(text: string, materials?: MTLLoader.MaterialCreator): THREE.Object3D {
  const loader = new OBJLoader();
  if (materials) loader.setMaterials(materials);
  const group = loader.parse(text);
  if (materials) convertObjMaterials(group);
  else applyDefaultMaterial(group);
  return group;
}

/** Parses STL/OBJ/PLY bytes exactly as the webview's loader does. */
export function parseMeshObject(bytes: ArrayBuffer | Uint8Array, format: "stl" | "obj" | "ply"): THREE.Object3D {
  const buf = toArrayBuffer(bytes);
  switch (format) {
    case "stl":
      return meshFromGeometry(new STLLoader().parse(buf));
    case "obj":
      return parseObjObject(new TextDecoder().decode(buf));
    case "ply": {
      const geometry = new PLYLoader().parse(buf);
      geometry.computeVertexNormals();
      return meshFromGeometry(geometry);
    }
    default:
      throw new Error(`parseMeshObject: no loader for "${String(format)}"`);
  }
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/**
 * Parses a `.gltf`/`.glb` into its scene with materials stripped and every
 * buffer inlined as a `data:` URI (the GLB's BIN chunk and any resolved
 * external `.bin`), so no network or DOM access is needed. A Draco/meshopt
 * file is first inflated to plain glTF from the decoded entries in `external`.
 * Rejects when the loader does (e.g. a compression extension whose decoded
 * entries were not supplied, or an external buffer that was not supplied).
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
  // A Draco/meshopt file is rewritten into plain glTF from the entries the
  // kernel worker's decode step added to `external` (see `gltfInflate.ts`), so
  // GLTFLoader never meets a compression extension it has no decoder for.
  if (external) inflateGltfDocument(doc, external);
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
