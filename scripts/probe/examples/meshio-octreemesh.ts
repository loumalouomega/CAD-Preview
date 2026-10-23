/** meshio++ 17.13.0 `octreeMesh` probe (new engine candidate).
 * Run: npm run probe -- scripts/probe/examples/meshio-octreemesh.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that the gate passed.
 *
 * Skins: examples/STL/cube.stl (volume 1000) and block.stp tessellated
 * (volume 60). For output tet / hex / castellated: record the cell classes,
 * node order check (signed volume in Gmsh's reference order), enclosed volume
 * (sum of per-cell volumes), report facts and time.
 */
import * as fs from "fs";
import * as path from "path";
import { getMeshio } from "../../../src/meshioService";
import { brepSkinStlBytes } from "../../../src/octreeService";

console.log = console.error.bind(console);
type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const trip = (o: V, a: V, b: V, c: V): number => {
  const u = sub(a, o), v = sub(b, o), w = sub(c, o);
  return (u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0])) / 6;
};
// Gmsh hex 0..7 = bottom ring 0123, top ring 4567; split into 6 tets about diagonal 0-6.
const HEX_TETS = [[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]];

function summarize(r: any): Record<string, unknown> {
  const pts = r.mesh.points as ArrayLike<number>;
  const P = (i: number): V => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
  const byType: Record<string, number> = {};
  let vol = 0, neg = 0;
  for (const b of r.mesh.cells as Array<{ type: string; data: ArrayLike<number | bigint> }>) {
    const n = b.type === "tetra" ? 4 : b.type === "hexahedron" ? 8 : b.type === "pyramid" ? 5 : 0;
    if (!n) { byType[b.type] = (byType[b.type] ?? 0) + 1; continue; }
    const cnt = Math.floor(b.data.length / n);
    byType[b.type] = (byType[b.type] ?? 0) + cnt;
    for (let c = 0; c < cnt; c++) {
      const id = (j: number): number => Number(b.data[c * n + j]);
      let v = 0;
      if (b.type === "tetra") v = trip(P(id(3)), P(id(0)), P(id(1)), P(id(2)));
      else if (b.type === "hexahedron") for (const t of HEX_TETS) v += trip(P(id(t[3])), P(id(t[0])), P(id(t[1])), P(id(t[2])));
      else v = trip(P(id(4)), P(id(0)), P(id(1)), P(id(2))) + trip(P(id(4)), P(id(0)), P(id(2)), P(id(3)));
      vol += v;
      if (v <= 0) neg++;
    }
  }
  const { mesh, ...facts } = r;
  return { byType, signedVolume: vol, nonPositiveCells: neg, ...facts };
}

async function main(): Promise<void> {
  const m = await getMeshio();
  const root = path.resolve(__dirname, "../../..");
  const skins: Array<[string, Uint8Array]> = [
    ["cube.stl", fs.readFileSync(path.join(root, "examples/STL/cube.stl"))],
  ];
  try {
    skins.push(["block.stp", await brepSkinStlBytes(root, fs.readFileSync(path.join(root, "examples/STP/block.stp")))]);
  } catch (e) {
    console.error(JSON.stringify({ skinError: String(e) }));
  }
  for (const [name, bytes] of skins) {
    m.FS.writeFile("/os.stl", bytes);
    const skin = m.readMesh("/os.stl", "stl");
    for (const output of ["tet", "hex", "castellated"]) {
      for (const maxSize of [0, 2]) {
        const t0 = Date.now();
        try {
          const r = m.octreeMesh(skin, { output, ...(maxSize ? { maxSize, minSize: maxSize / 4 } : {}) });
          const s = summarize(r) as any;
          delete s.timings; delete s.leavesPerLevel;
          console.error(JSON.stringify({ name, output, maxSize, ms: Date.now() - t0, ...s }));
        } catch (e) {
          console.error(JSON.stringify({ name, output, maxSize, error: String(e) }));
        }
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
