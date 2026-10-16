// Regenerates the printability fixtures in examples/STL/printability/ (binary STL):
//   slab-1mm.stl      a 20 x 20 x 1 mm slab — the thinnest wall is exactly 1 mm
//   cube-on-edge.stl  the 10 mm cube turned 45 degrees about X so it stands on an
//                     edge: two 10 x 10 faces each 45 degrees from the plate
//
//   node scripts/printability-fixtures/make-fixtures.mjs
//
// Nothing is hand-edited; change this script and regenerate.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "examples", "STL", "printability");

const V = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const IDX = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];

function stl(points) {
  const n = IDX.length / 3;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write("CAD-Preview printability fixture", 0, "ascii");
  buf.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => points[IDX[t * 3 + k]]);
    const u = b.map((x, i) => x - a[i]), v = c.map((x, i) => x - a[i]);
    const nr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...nr) || 1;
    const o = 84 + t * 50;
    nr.forEach((x, i) => buf.writeFloatLE(x / len, o + i * 4));
    [a, b, c].forEach((p, k) => p.forEach((x, i) => buf.writeFloatLE(x, o + 12 + k * 12 + i * 4)));
  }
  return buf;
}

const scale = (sx, sy, sz) => V.map((p) => [p[0] * sx, p[1] * sy, p[2] * sz]);
const rotX = (pts, deg, cy, cz) => {
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  return pts.map(([x, y, z]) => [x, cy + (y - cy) * c - (z - cz) * s, cz + (y - cy) * s + (z - cz) * c]);
};
// Stand the turned cube on its lowest edge (min z = 0).
const turned = rotX(scale(10, 10, 10), 45, 5, 5);
const minZ = Math.min(...turned.map((p) => p[2]));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "slab-1mm.stl"), stl(scale(20, 20, 1)));
fs.writeFileSync(path.join(OUT, "cube-on-edge.stl"), stl(turned.map(([x, y, z]) => [x, y, z - minZ])));
console.log("wrote examples/STL/printability/slab-1mm.stl, cube-on-edge.stl");
