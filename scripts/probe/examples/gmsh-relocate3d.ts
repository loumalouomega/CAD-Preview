/** Roadmap "Gmsh optimize(\"Relocate3D\")" revival gate: does Relocate3D change a mesh on a newer Gmsh build?
 * Run: npm run probe -- scripts/probe/examples/gmsh-relocate3d.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that the gate passed.
 *
 * Gate: on bull.stp at the smoke-test size (diagonal / 15) the worst-element minSICN AND the mean both
 * increase on two runs. Recorded baseline (gmsh-wasm 0.3.0): minSICN 0.027591537627954913 bit-identical
 * before and after, mean +0.0017 — a no-op on what matters.
 */
import * as fs from "fs";
import { getGmsh } from "../../../src/gmshService";

console.log = console.error.bind(console);
type Gmsh = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function quality(gmsh: Gmsh): { min: number; mean: number; tets: number } {
  const els = gmsh.model.mesh.getElements(3) as { elementTags: number[][] };
  const tags = els.elementTags.flat();
  const q = (gmsh.model.mesh.getElementQualities(tags, "minSICN") as { elementsQuality: number[] }).elementsQuality;
  return { min: Math.min(...q), mean: q.reduce((a, b) => a + b, 0) / q.length, tets: tags.length };
}

async function run(gmsh: Gmsh, mode: string | null): Promise<Record<string, unknown>> {
  gmsh.clear();
  gmsh.model.add("m");
  gmsh.FS.writeFile("/model.step", fs.readFileSync("examples/STP/bull.stp"));
  gmsh.model.occ.importShapes("/model.step");
  gmsh.model.occ.synchronize();
  for (const k of ["General.NumThreads", "Mesh.MaxNumThreads1D", "Mesh.MaxNumThreads2D", "Mesh.MaxNumThreads3D"]) gmsh.option.setNumber(k, 1);
  gmsh.option.setNumber("Mesh.Algorithm3D", 1);
  gmsh.option.setNumber("Mesh.SaveAll", 1);
  gmsh.option.setNumber("Mesh.Optimize", 0);
  const bb = gmsh.model.getBoundingBox(-1, -1) as Record<string, number>;
  const diagonal = Math.hypot(bb.xmax - bb.xmin, bb.ymax - bb.ymin, bb.zmax - bb.zmin);
  gmsh.option.setNumber("Mesh.MeshSizeMin", 0);
  gmsh.option.setNumber("Mesh.MeshSizeMax", diagonal / 15);
  gmsh.model.mesh.generate(3);
  const before = quality(gmsh);
  if (mode === null) return { mode, before };
  gmsh.model.mesh.optimize(mode, true);
  return { mode, before, after: quality(gmsh) };
}

async function main(): Promise<void> {
  const gmsh = await getGmsh(process.cwd());
  const out: Record<string, unknown> = {
    packagedBy: gmsh.option.getString("General.BuildInfo").value.match(/Packaged by: [^;]+/)?.[0],
  };
  for (const [name, mode] of [["relocate3D_run1", "Relocate3D"], ["relocate3D_run2", "Relocate3D"], ["netgen_control", "Netgen"]] as const) {
    try { out[name] = await run(gmsh, mode); } catch (e) { out[name] = { error: String((e as Error)?.message ?? e).slice(0, 300) }; }
  }
  console.error(JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
