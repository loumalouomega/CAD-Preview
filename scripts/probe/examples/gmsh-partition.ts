/** Roadmap probe "METIS partitioning for Kratos MPI export". NOT a product API.
 * Run: npm run probe -- scripts/probe/examples/gmsh-partition.ts --run   (diagnostics: JSON on stderr)
 *
 * bull.stp -> Gmsh tets -> gmsh.model.mesh.partition(n) for n in {2,4,8}:
 *   every element in exactly one partition? counts sum to the serial total? balance ratio (max/mean)?
 *   unpartition restores the serial counts? does a partitioned MSH 4.1 write survive a re-merge?
 * Exit 0 means the probe completed, not that the gate passed: read `gate`.
 */
import * as fs from "fs";
import { performance } from "node:perf_hooks";
import { getGmsh, resetGmsh } from "../../../src/gmshService";
import { kernelVersions } from "../../../src/kernelVersions";

console.log = console.error.bind(console);
type Dim = { dimTags: number[] };

function entities(gmsh: any, dim: number): number[] {
  const d = (gmsh.model.getEntities(dim) as Dim).dimTags;
  return Array.from({ length: d.length / 2 }, (_, i) => d[2 * i + 1]);
}

/** Tet element tags per 3-D entity, with the partitions each entity belongs to. */
function tally(gmsh: any): { total: number; perEntity: Array<{ tag: number; partitions: number[]; tets: number }>; ids: Set<number>; duplicates: number } {
  const perEntity: Array<{ tag: number; partitions: number[]; tets: number }> = [];
  const ids = new Set<number>();
  let duplicates = 0;
  let total = 0;
  for (const tag of entities(gmsh, 3)) {
    const els = gmsh.model.mesh.getElements(3, tag) as { elementTypes: number[]; elementTags: number[][] };
    let tets = 0;
    els.elementTypes.forEach((ty, k) => {
      if (ty !== 4) return;
      for (const id of els.elementTags[k]) { if (ids.has(id)) duplicates++; ids.add(id); tets++; }
    });
    total += tets;
    let partitions: number[] = [];
    try { partitions = (gmsh.model.getPartitions(3, tag) as { partitions: number[] }).partitions; } catch { /* unpartitioned model */ }
    perEntity.push({ tag, partitions, tets });
  }
  return { total, perEntity, ids, duplicates };
}

async function main(): Promise<void> {
  const out: Record<string, unknown> = { versions: kernelVersions() };
  const gmsh: any = await getGmsh(process.cwd());
  gmsh.clear(); gmsh.model.add("m");
  gmsh.FS.writeFile("/model.step", fs.readFileSync("examples/STP/bull.stp"));
  gmsh.model.occ.importShapes("/model.step");
  gmsh.model.occ.synchronize();
  for (const k of ["General.NumThreads", "Mesh.MaxNumThreads1D", "Mesh.MaxNumThreads2D", "Mesh.MaxNumThreads3D"]) gmsh.option.setNumber(k, 1);
  gmsh.option.setNumber("Mesh.Algorithm3D", 1);
  gmsh.option.setNumber("Mesh.SaveAll", 1);
  const bb = gmsh.model.getBoundingBox(-1, -1) as { xmin: number; ymin: number; zmin: number; xmax: number; ymax: number; zmax: number };
  const diag = Math.hypot(bb.xmax - bb.xmin, bb.ymax - bb.ymin, bb.zmax - bb.zmin);
  gmsh.option.setNumber("Mesh.MeshSizeMax", diag / 20);
  gmsh.option.setNumber("Mesh.MeshSizeMin", 0);
  let t0 = performance.now();
  gmsh.model.mesh.generate(3);
  const serial = tally(gmsh);
  out.serial = { ms: Math.round(performance.now() - t0), diag, tets: serial.total, volumes: serial.perEntity.length };
  console.error(JSON.stringify(out.serial));

  const rows: Record<string, unknown>[] = [];
  for (const n of [2, 4, 8]) {
    const row: Record<string, unknown> = { n };
    try {
      t0 = performance.now();
      gmsh.model.mesh.partition(n);
      row.partitionMs = Math.round(performance.now() - t0);
      row.numberOfPartitions = gmsh.model.getNumberOfPartitions();
      const t = tally(gmsh);
      const byPart = new Map<number, number>();
      let multi = 0, none = 0;
      for (const e of t.perEntity) {
        if (e.partitions.length > 1) multi += e.tets;
        if (e.partitions.length === 0) none += e.tets;
        for (const p of e.partitions.slice(0, 1)) byPart.set(p, (byPart.get(p) ?? 0) + e.tets);
      }
      const counts = [...byPart.values()];
      const mean = counts.reduce((a, b) => a + b, 0) / (counts.length || 1);
      Object.assign(row, {
        entities: t.perEntity.length, tets: t.total, duplicates: t.duplicates,
        sumEqualsSerial: t.total === serial.total, sameIds: t.ids.size === serial.ids.size && [...serial.ids].every((i) => t.ids.has(i)),
        elementsInMultiPartitionEntities: multi, elementsWithNoPartition: none,
        partitionsSeen: counts.length, counts, balanceMaxOverMean: counts.length ? Math.max(...counts) / mean : null,
      });
      try {
        gmsh.write("/part.msh");
        const bytes = gmsh.FS.readFile("/part.msh") as Uint8Array;
        row.mshBytes = bytes.length;
        row.mshHasPartitionedEntities = /\$PartitionedEntities/.test(Buffer.from(bytes).toString("latin1"));
        gmsh.FS.unlink("/part.msh");
      } catch (e) { row.mshWriteError = String((e as Error).message).slice(0, 200); }
      gmsh.model.mesh.unpartition();
      const u = tally(gmsh);
      row.afterUnpartition = { entities: u.perEntity.length, tets: u.total, matchesSerial: u.total === serial.total, partitions: gmsh.model.getNumberOfPartitions() };
    } catch (e) {
      row.error = String((e as Error)?.message ?? e).slice(0, 300);
      if (/abort|out of bounds|unreachable/i.test(String(row.error))) resetGmsh();
    }
    console.error(JSON.stringify(row));
    rows.push(row);
  }
  out.rows = rows;
  const ok = rows.every((r) => !r.error && r.sumEqualsSerial && r.duplicates === 0 && r.elementsWithNoPartition === 0);
  out.gate = { pass: ok, rule: "every element in exactly one partition, counts sum to the serial total" };
  console.error(JSON.stringify(out.gate));
}

main().catch((e) => { console.error(e); process.exit(1); });
