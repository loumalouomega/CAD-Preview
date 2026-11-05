/** Netgen sizing probe. Run: npm run probe -- scripts/probe/examples/meshio-1800-netgen.ts --run */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";
console.log = console.error.bind(console);
const out = (o: unknown): void => { console.error(JSON.stringify(o)); };
async function main(): Promise<void> {
  const m: any = await getMeshio();
  m.FS.writeFile("/c.stl", fs.readFileSync("examples/STL/cube.stl"));
  const cube = m.readMesh("/c.stl", "stl");
  for (const o of [{ maxSize: 0.5 }, { maxSize: 0.5, grading: 1 }, { maxVolume: 0.5 }, { maxSize: 1, optimizeSteps: 0 }, { maxSize: 1, optimizeSteps: 10 }]) {
    try { const r = m.tetrahedralize(cube, { backend: "netgen", ...o }); out({ o, tets: r.numTetrahedra, newPts: r.numNewPoints, dih: r.minDihedralDeg, w: r.warnings }); }
    catch (e) { out({ o, err: String((e as Error).message).slice(0, 200) }); }
  }
}
main().then(() => process.exit(0));
