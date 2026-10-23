/** meshio++ 17.13 probe: which writers accept `meshCadSurface`'s triangle + line mesh (with cad:face / cad:edge cell data)?
 * Run: npm run probe -- scripts/probe/examples/meshio-meshcad-write.ts --run */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";
console.log = console.error.bind(console);
const out = (o: unknown): void => { console.error(JSON.stringify(o)); };
async function main(): Promise<void> {
  const m = await getMeshio();
  m.FS.writeFile("/mc.stp", fs.readFileSync("examples/STP/block.stp"));
  const info = (m.readMeshSelective("/mc.stp", { format: "step", info: true }) as any).info;
  for (const edges of [true, false]) {
    const r: any = m.meshCadSurface(info, { targetSize: 1, edges });
    out({ edges, blocks: r.mesh.cells.map((b: any) => [b.type, b.data.length]), cell_data: Object.keys(r.mesh.cell_data ?? {}), cell_sets: Object.keys(r.mesh.cell_sets ?? {}).slice(0, 4) });
    for (const [fmt, ext] of [["stl", "stl"], ["obj", "obj"], ["ply", "ply"], ["vtk", "vtk"], ["vtu", "vtu"], ["gmsh", "msh"]] as const) {
      const p = `/w.${ext}`;
      try {
        m.writeMesh(p, r.mesh, fmt);
        const bytes = m.FS.readFile(p);
        const back = m.readMesh(p, fmt);
        out({ edges, fmt, bytes: bytes.length, readBackBlocks: back.cells.map((b: any) => [b.type, b.data.length]) });
        m.FS.unlink(p);
      } catch (e) { out({ edges, fmt, error: String((e as Error).message).slice(0, 200) }); }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
