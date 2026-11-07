/** meshio++ 19.0 probe: checkTetrahedra, octreeMesh volume-fix counters, and the
 * meshCadSurface modelTolerances/virtualFaces default flip.
 * Run: npm run probe -- scripts/probe/examples/meshio-1900.ts --run   (JSON on stderr)
 */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";

console.log = console.error.bind(console);
const out = (o: unknown): void => { console.error(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? Number(v) : v))); };

async function main(): Promise<void> {
  const m: any = await getMeshio();
  m.FS.writeFile("/mc.stp", fs.readFileSync("examples/STP/block.stp"));
  const info: any = (m.readMeshSelective("/mc.stp", { format: "step", info: true }) as any).info;
  const mc = (o: Record<string, unknown>) => m.meshCadSurface(info, { edges: false, targetSize: 1, ...o });
  const tri = (r: any) => r.numTriangles;
  out({ label: "meshcad:default", tri: tri(mc({})) });
  out({ label: "meshcad:explicit-false", tri: tri(mc({ virtualFaces: false, modelTolerances: false })) });
  out({ label: "meshcad:explicit-true", tri: tri(mc({ virtualFaces: true, modelTolerances: true })) });

  const skin = m.readMesh("/mc.stp", "step");
  void skin;
  const surf = mc({});
  const r: any = m.octreeMesh(surf.mesh, { output: "tet", maxSize: 2, minSize: 0.5 });
  out({ label: "octreeMesh", tets: r.numTetrahedra, inverted: r.numInverted, fix: { gaps: r.numGapsFilled, collapsed: r.numCollapsed, reordered: r.numReordered, overlaps: r.numOverlaps, untangled: r.numUntangled } });
  out({ label: "checkTetrahedra:clean", ...m.checkTetrahedra(r.mesh) });
  // Flip one tet's orientation by swapping two nodes, expect numInverted 1.
  const blk = (r.mesh.cells as any[]).find((b) => b.type === "tetra");
  const d = blk.data as any;
  const npc = blk.nodesPerCell ?? 4;
  const t = d[1]; d[1] = d[2]; d[2] = t;
  out({ label: "checkTetrahedra:flipped", npc, ...m.checkTetrahedra(r.mesh) });
}
main().catch((e) => { console.error("PROBE FAILED", e); process.exit(1); });
