/** selectRegion result shape. Run: npm run probe -- scripts/probe/examples/meshio-1800-select.ts --run */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";
console.log = console.error.bind(console);
const out = (o: unknown): void => { console.error(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? Number(v) : ArrayBuffer.isView(v) ? Array.from(v as any) : v))); };
async function main(): Promise<void> {
  const m: any = await getMeshio();
  m.FS.writeFile("/c.stl", fs.readFileSync("examples/STL/cube.stl"));
  const cube = m.readMesh("/c.stl", "stl");
  const r = m.selectRegion(cube, "top", { plane: [0, 0, 5, 0, 0, 1] });
  out({ regions: r.mesh.regions, cell_data: r.mesh.cell_data, cdc: r.mesh.cell_data_components, propertySets: r.mesh.propertySets, field_data: r.mesh.field_data });
  const p = m.selectRegion(cube, "pts", { kind: "point", box: [-6, -6, -6, 6, 6, -4] });
  out({ regions: p.mesh.regions, point_data: p.mesh.point_data });
  const t = m.thickness(cube, {});
  out({ cell_data: Object.keys(t.mesh.cell_data ?? {}), dist: t.mesh.cell_data?.["thickness:distance"], hit: t.mesh.cell_data?.["thickness:hit_cell"] });
  const ix = m.findIntersections(cube, { other: m.readMesh("/c.stl", "stl") });
  out({ cd: Object.keys(ix.mesh.cell_data ?? {}), pairs: Array.from(ix.pairs).slice(0, 6), n: ix.numPairs, clean: ix.clean, w: ix.warnings });
}
main().then(() => process.exit(0));
