/** Roadmap 2.24 probe: node order of meshio++ `octree` hex/pyramid/tet cells vs Gmsh's.
 * Run: npm run probe -- scripts/probe/examples/meshio-octree-orientation.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that the gate passed.
 *
 * Gmsh's reference cells (positive Jacobian): hex8 corners 0..3 are the
 * base ring (0 -> 1 along +x, 0 -> 3 along +y) and 4..7 the top ring above
 * it; pyramid5 has the same base ring and the apex as node 4; tet4 has
 * (p1-p0) x (p2-p0) . (p3-p0) > 0. The signed triple products below count
 * how many octree cells of each class meet that convention, and how many
 * are mirrored (all-negative) or non-convex-looking (mixed corner signs).
 */
import * as fs from "fs";
import { getOcct, readShape } from "../../../src/occtService";
import { tessellateByGroup } from "../../../src/meshExtract";
import { TESSELLATION_PRESETS } from "../../../src/tessellationQuality";
import { weldTriangleSoup, weldedMeshToStlBytes } from "../../../src/meshComponents";
import { getMeshio } from "../../../src/meshioService";

console.log = console.error.bind(console);
type Del = { delete(): void };
type V = [number, number, number];

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const triple = (o: V, a: V, b: V, c: V): number => dot(cross(sub(a, o), sub(b, o)), sub(c, o));

async function skinFrom(m: any, stepPath: string): Promise<any> {
  const oc: any = await getOcct(process.cwd());
  const cleanup: Del[] = [];
  try {
    oc.FS.writeFile("/s.stp", fs.readFileSync(stepPath));
    const shape = readShape(oc, "/s.stp", "step", cleanup);
    const soup: number[] = [];
    for (const g of tessellateByGroup(oc, shape, TESSELLATION_PRESETS.fine)) {
      for (const f of g.faces) {
        const p = f.buffers.positions, ix = f.buffers.indices;
        for (let t = 0; t < ix.length; t++) soup.push(p[ix[t] * 3], p[ix[t] * 3 + 1], p[ix[t] * 3 + 2]);
      }
    }
    m.FS.writeFile("/skin.stl", weldedMeshToStlBytes(weldTriangleSoup(new Float32Array(soup))));
    const skin = m.readMesh("/skin.stl", "stl");
    m.FS.unlink("/skin.stl");
    return skin;
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) { try { cleanup[i].delete(); } catch { /* ignore */ } }
  }
}

async function main(): Promise<void> {
  const m: any = await getMeshio();
  const out: Record<string, unknown> = {};
  for (const [name, path, level] of [["block", "examples/STP/block.stp", 4], ["bull", "examples/STP/bull.stp", 3]] as Array<[string, string, number]>) {
    const row: Record<string, unknown> = {};
    try {
      const skin = await skinFrom(m, path);
      const r = m.octree(skin, null, 0, level, null, undefined, undefined, 3, undefined,
        "face", "inside", undefined, undefined, undefined, undefined, undefined, "templates", true);
      const pts = r.mesh.points as ArrayLike<number>;
      const P = (i: number): V => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
      for (const b of r.mesh.cells as Array<{ type: string; data: ArrayLike<number> }>) {
        const k = b.type === "hexahedron" ? 8 : b.type === "pyramid" ? 5 : b.type === "tetra" ? 4 : 0;
        let positive = 0, negative = 0, mixed = 0, count = 0;
        if (k) {
          for (let c = 0; c + k <= b.data.length; c += k) {
            const n = Array.from({ length: k }, (_, j) => P(Number(b.data[c + j])));
            let signs: number[];
            if (b.type === "tetra") signs = [triple(n[0], n[1], n[2], n[3])];
            else if (b.type === "pyramid") signs = [triple(n[0], n[1], n[3], n[4])];
            else {
              // Every hex corner against its three edge neighbours, in Gmsh's ring order.
              const nb: Array<[number, number, number, number]> = [
                [0, 1, 3, 4], [1, 2, 0, 5], [2, 3, 1, 6], [3, 0, 2, 7],
                [4, 7, 5, 0], [5, 4, 6, 1], [6, 5, 7, 2], [7, 6, 4, 3],
              ];
              signs = nb.map(([o, a, bb, cc]) => triple(n[o], n[a], n[bb], n[cc]));
            }
            count++;
            if (signs.every((s) => s > 0)) positive++;
            else if (signs.every((s) => s < 0)) negative++;
            else mixed++;
          }
        }
        row[b.type] = { count, positive, negative, mixed };
      }
      row.numSnapped = r.numSnapped;
      row.numRefused = r.numRefused;
    } catch (e) {
      row.error = String((e as Error)?.message ?? e).slice(0, 300);
    }
    out[name] = row;
  }
  console.error(JSON.stringify(out, null, 2));
}

main().then(() => process.exit(0), () => process.exit(0));
