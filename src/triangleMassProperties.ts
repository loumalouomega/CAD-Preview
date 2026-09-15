import { weldTriangleSoup } from "./meshComponents";
import { analyzeMeshTopology } from "./meshTopology";
import type { Vec3 } from "./editOps";

export interface MeshMassProperties {
  volume: number;
  area: number;
  volumeCentroid: Vec3;
  areaCentroid: Vec3;
  /** No boundary edges after position welding; not a validity verdict. */
  watertight: boolean;
}

/** Signed tetrahedra and surface centroids over world-space triangle soup.
 * Volume is meaningful only for a closed, consistently oriented boundary.
 * Empty geometry retains the webview's zero-property convention. */
export function triangleMassProperties(soup: ArrayLike<number>): MeshMassProperties {
  let volumeSum = 0, area = 0;
  const vc: Vec3 = [0, 0, 0], ac: Vec3 = [0, 0, 0];
  for (let i = 0; i + 8 < soup.length; i += 9) {
    const a = [soup[i], soup[i+1], soup[i+2]];
    const b = [soup[i+3], soup[i+4], soup[i+5]];
    const c = [soup[i+6], soup[i+7], soup[i+8]];
    if (![...a, ...b, ...c].every(Number.isFinite)) throw new Error("Mesh contains non-finite coordinates");
    const v = (a[0]*(b[1]*c[2]-b[2]*c[1]) + a[1]*(b[2]*c[0]-b[0]*c[2]) + a[2]*(b[0]*c[1]-b[1]*c[0])) / 6;
    const ab = b.map((n, k) => n-a[k]), ad = c.map((n, k) => n-a[k]);
    const ar = Math.hypot(ab[1]*ad[2]-ab[2]*ad[1], ab[2]*ad[0]-ab[0]*ad[2], ab[0]*ad[1]-ab[1]*ad[0]) / 2;
    volumeSum += v;
    area += ar;
    for (let k = 0; k < 3; k++) {
      vc[k] += v * (a[k]+b[k]+c[k]) / 4;
      ac[k] += ar * (a[k]+b[k]+c[k]) / 3;
    }
  }
  const areaCentroid = ac.map(n => area > 0 ? n / area : 0) as Vec3;
  const volumeCentroid = Math.abs(volumeSum) > 1e-12 ? vc.map(n => n / volumeSum) as Vec3 : areaCentroid;
  const mesh = weldTriangleSoup(Float32Array.from(soup));
  const triangles = Array.from({length: mesh.indices.length / 3}, (_, i) => i);
  const watertight = analyzeMeshTopology(mesh.positions, mesh.indices, triangles).freeEdgeCount === 0;
  return { volume: Math.abs(volumeSum), area, volumeCentroid, areaCentroid, watertight };
}
