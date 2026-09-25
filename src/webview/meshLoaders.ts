import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CadFormat } from "../fileRouter";
import { parseMeshObject } from "./meshObject";

/**
 * Loads a mesh-format source for display. STL/OBJ/PLY fetch the bytes and go
 * through `meshObject.ts`'s `parseMeshObject` — the SAME function the kernel
 * worker's headless mesh-edit bake uses, so the object hierarchy (and with it
 * every `node-N` edit-op target) is identical on both sides. glTF keeps
 * `loadAsync` for URL-relative resources; the scene graph is the loader's
 * either way.
 */
export async function loadMeshFromUrl(url: string, format: CadFormat): Promise<THREE.Object3D> {
  switch (format) {
    case "stl":
    case "obj":
    case "ply": {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
      return parseMeshObject(await res.arrayBuffer(), format);
    }
    case "gltf": {
      const gltf = await new GLTFLoader().loadAsync(url);
      return gltf.scene;
    }
    default:
      throw new Error(`Mesh loader for "${format}" is not implemented.`);
  }
}
