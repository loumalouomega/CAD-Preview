/** thickness with no hits. Run: npm run probe -- scripts/probe/examples/meshio-1800-miss.ts --run */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";
console.log = console.error.bind(console);
async function main(): Promise<void> {
  const m: any = await getMeshio();
  m.FS.writeFile("/c.stl", fs.readFileSync("examples/STL/cube.stl"));
  const r = m.thickness(m.readMesh("/c.stl", "stl"), { direction: "outward" });
  console.error(JSON.stringify({ hit: r.numHit, min: String(r.min), max: String(r.max), mean: String(r.mean), minCell: r.minCell }));
}
main().then(() => process.exit(0));
