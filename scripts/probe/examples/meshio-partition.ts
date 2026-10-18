/** Roadmap probe "KaHIP partitioning for Kratos MPI export" (meshio++ side). NOT a product API.
 * Run: npm run probe -- scripts/probe/examples/meshio-partition.ts --run   (diagnostics: JSON on stderr)
 *
 * bull.stp -> Gmsh tets -> MSH 4.1 -> meshio++ `partition` for n in {2,4,8}:
 *   method 'sfc'  : balance (max/mean), cells covered exactly once, interface-node count (the baseline a graph
 *                   partitioner must beat), ghostLayers=1 halo;
 *   method 'kahip': must throw today (the build never compiles KaHIP) -- the exact message is recorded.
 */
import * as fs from "fs";
import { getGmsh } from "../../../src/gmshService";
import { getMeshio } from "../../../src/meshioService";
import { kernelVersions } from "../../../src/kernelVersions";

console.log = console.error.bind(console);
const out = (o: unknown): void => { console.error(JSON.stringify(o)); };

async function main(): Promise<void> {
  out({ versions: kernelVersions() });
  const gmsh: any = await getGmsh(process.cwd());
  gmsh.clear(); gmsh.model.add("m");
  gmsh.FS.writeFile("/model.step", fs.readFileSync("examples/STP/bull.stp"));
  gmsh.model.occ.importShapes("/model.step");
  gmsh.model.occ.synchronize();
  for (const k of ["General.NumThreads", "Mesh.MaxNumThreads1D", "Mesh.MaxNumThreads2D", "Mesh.MaxNumThreads3D"]) gmsh.option.setNumber(k, 1);
  gmsh.option.setNumber("Mesh.Algorithm3D", 1);
  gmsh.option.setNumber("Mesh.SaveAll", 1);
  const bb = gmsh.model.getBoundingBox(-1, -1) as any;
  gmsh.option.setNumber("Mesh.MeshSizeMax", Math.hypot(bb.xmax - bb.xmin, bb.ymax - bb.ymin, bb.zmax - bb.zmin) / 20);
  gmsh.option.setNumber("Mesh.MeshSizeMin", 0);
  gmsh.model.mesh.generate(3);
  gmsh.option.setNumber("Mesh.MshFileVersion", 4.1);
  gmsh.write("/p.msh");
  const msh = gmsh.FS.readFile("/p.msh") as Uint8Array;
  gmsh.FS.unlink("/p.msh");

  const m = await getMeshio();
  m.FS.writeFile("/p.msh", msh);
  const mesh = m.readMesh("/p.msh", "gmsh");
  m.FS.unlink("/p.msh");
  const tetBlocks = (mesh.cells as any[]).map((b, i) => ({ b, i })).filter((x) => x.b.type === "tetra");
  const totalTets = tetBlocks.reduce((n, x) => n + x.b.data.length / 4, 0);
  out({ blocks: (mesh.cells as any[]).map((b) => [b.type, b.data.length]), totalTets });

  for (const n of [2, 4, 8]) {
    const row: Record<string, unknown> = { n };
    try {
      const labels = m.partitionLabels(mesh, n, "sfc") as number[][];
      const counts = new Array(n).fill(0);
      const nodeParts = new Map<number, Set<number>>();
      tetBlocks.forEach(({ b, i }) => {
        const L = labels[i];
        for (let c = 0; c < L.length; c++) {
          counts[L[c]]++;
          for (let k = 0; k < 4; k++) {
            const node = Number(b.data[c * 4 + k]);
            (nodeParts.get(node) ?? nodeParts.set(node, new Set()).get(node)!).add(L[c]);
          }
        }
      });
      const interfaceNodes = [...nodeParts.values()].filter((s) => s.size > 1).length;
      const mean = counts.reduce((a: number, b: number) => a + b, 0) / n;
      Object.assign(row, { sfcCounts: counts, sfcCovered: counts.reduce((a: number, b: number) => a + b, 0) === totalTets,
        sfcBalanceMaxOverMean: Math.max(...counts) / mean, sfcNodes: nodeParts.size, sfcInterfaceNodes: interfaceNodes,
        sfcInterfaceFraction: interfaceNodes / nodeParts.size });
      const pieces = m.partition(mesh, n, "sfc", undefined, undefined, undefined, true, 1) as any[];
      row.haloPieces = pieces.length;
      row.haloCellData = Object.keys(pieces[0].mesh.cell_data ?? {});
    } catch (e) { row.sfcError = String((e as Error).message).slice(0, 300); }
    for (const method of ["kahip", "auto"] as const) {
      try { const l = m.partitionLabels(mesh, n, method) as number[][]; row[method] = { ok: true, labels: l.length }; }
      catch (e) { row[method] = { ok: false, error: String((e as Error).message).slice(0, 300) }; }
    }
    out(row);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
