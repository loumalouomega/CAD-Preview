import * as THREE from "three";
import { triangleMassProperties, type MeshMassProperties } from "../triangleMassProperties";
export type { MeshMassProperties } from "../triangleMassProperties";

/** World-transform adapter over the shared headless triangle integration. */
export function computeMeshMassProperties(meshes: THREE.Mesh[]): MeshMassProperties {
  const soup: number[] = [];
  const point = new THREE.Vector3();
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const position = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : position.count;
    for (let i = 0; i < count; i++) {
      point.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
      soup.push(point.x, point.y, point.z);
    }
  }
  return triangleMassProperties(soup);
}
