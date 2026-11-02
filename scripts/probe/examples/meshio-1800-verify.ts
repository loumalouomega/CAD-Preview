/** Live check of the 18.0 pins (the mcp:smoke assertions) and the new Mesh Ops. Exit 1 on any mismatch.
 * Run: npm run probe -- scripts/probe/examples/meshio-1800-verify.ts --run */
import * as fs from "fs";
import { analyzeSurfaceMesh, runMeshioOps, getMeshio } from "../../../src/meshioService";
console.log = console.error.bind(console);
let bad = 0;
const ok = (c: boolean, msg: string): void => { console.error(`${c ? "✓" : "✗"} ${msg}`); if (!c) bad++; };
async function main(): Promise<void> {
  const cube = new Uint8Array(fs.readFileSync("examples/STL/cube.stl"));
  const shifted = new TextEncoder().encode(fs.readFileSync("examples/STL/cube.stl", "utf8").replace(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g, (_m, x, y, z) => `vertex ${+x + 5} ${+y + 5} ${+z + 5}`));
  const t = await analyzeSurfaceMesh(cube, { kind: "thickness", threshold: 11 });
  ok(t.thickness!.numHit === 12 && t.thickness!.min === 10 && t.thickness!.numBelow === 12, "cube thickness 10 on 12 tris");
  const o = await analyzeSurfaceMesh(cube, { kind: "thickness", direction: "outward" });
  ok(o.thickness!.numHit === 0 && o.thickness!.min === null && o.thickness!.mean === null, "outward: no hit -> null stats");
  const s = await analyzeSurfaceMesh(cube, { kind: "intersections" });
  ok(s.intersections!.numPairs === 0 && s.intersections!.clean, "lone cube clean");
  const p = await analyzeSurfaceMesh(cube, { kind: "intersections", useOther: true, maxPairs: 2 }, shifted);
  ok(p.intersections!.numPairs === 18 && p.intersections!.numSegments === 6 && p.intersections!.truncated && p.intersections!.pairs.length === 4 && p.intersections!.segments.length === 36, `shifted pair 18/6/truncated (${JSON.stringify({ ...p.intersections, segments: p.intersections!.segments.length })})`);
  const top = await analyzeSurfaceMesh(cube, { kind: "select", name: "top", plane: [0, 0, 5, 0, 0, 1] });
  ok(top.selection!.numSelected === 2 && top.selection!.entries.length === 2, "plane selects 2 top tris");
  const pts = await analyzeSurfaceMesh(cube, { kind: "select", name: "b", selectKind: "point", box: [-6, -6, -6, 6, 6, -4] });
  ok(pts.selection!.numSelected === 4, "box selects 4 vertices");

  // new Mesh Ops over a Gmsh-style tet mesh built by tetrahedralize (netgen is fine for the 12-tet cube)
  const m: any = await getMeshio();
  m.FS.writeFile("/c.stl", cube);
  const tet = m.tetrahedralize(m.readMesh("/c.stl", "stl"), { backend: "octree", maxSize: 2 }).mesh;
  const vtk = (mesh: any): Uint8Array => { m.writeMesh("/v.vtu", mesh, "vtu"); return m.FS.readFile("/v.vtu"); };
  const src = vtk(tet);
  const run = async (spec: any) => runMeshioOps(src, "vtu", [spec], "vtu");
  const ov = await run({ op: "optimizeVolume", iterations: 3, objective: "energy" });
  ok(ov.steps[0].applied && /min dihedral/.test(ov.steps[0].detail), `optimizeVolume: ${ov.steps[0].detail}`);
  const ad = await run({ op: "adapt", hsiz: 2, hausd: 0.1 });
  ok(ad.steps[0].applied && /mmg/.test(ad.steps[0].detail), `adapt: ${ad.steps[0].detail}`);
  const tp = await run({ op: "tetToPoly" });
  ok(tp.steps[0].applied, `tetToPoly: ${tp.steps[0].detail}`);
  const noLs = await run({ op: "discretizeLevelset" });
  ok(!noLs.steps[0].applied, "discretizeLevelset without a level set is reported, not thrown");
}
main().then(() => process.exit(bad ? 1 : 0), (e) => { console.error("fatal", e?.message ?? e); process.exit(1); });
