import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { CadFormat } from "../fileRouter";
import { meshFromGeometry } from "./viewer";

/**
 * Loads a mesh-format file from a webview URL into an `Object3D`.
 * Additional formats (OBJ/PLY/glTF) are added in a later milestone.
 */
export async function loadMeshFromUrl(url: string, format: CadFormat): Promise<THREE.Object3D> {
  switch (format) {
    case "stl": {
      const geometry = await new STLLoader().loadAsync(url);
      return meshFromGeometry(geometry);
    }
    default:
      throw new Error(`Mesh loader for "${format}" is not implemented yet.`);
  }
}
