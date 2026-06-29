import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CadFormat } from "../fileRouter";
import { meshFromGeometry } from "./viewer";

export async function loadMeshFromUrl(url: string, format: CadFormat): Promise<THREE.Object3D> {
  switch (format) {
    case "stl": {
      const geometry = await new STLLoader().loadAsync(url);
      return meshFromGeometry(geometry);
    }
    case "obj": {
      const group = await new OBJLoader().loadAsync(url);
      applyDefaultMaterial(group);
      return group;
    }
    case "ply": {
      const geometry = await new PLYLoader().loadAsync(url);
      geometry.computeVertexNormals();
      return meshFromGeometry(geometry);
    }
    case "gltf": {
      const gltf = await new GLTFLoader().loadAsync(url);
      return gltf.scene;
    }
    default:
      throw new Error(`Mesh loader for "${format}" is not implemented.`);
  }
}

/** Apply a default material to OBJ meshes that arrive without one. */
function applyDefaultMaterial(group: THREE.Group): void {
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
