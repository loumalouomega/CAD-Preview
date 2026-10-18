/** Roadmap probe "Hausdorff-bounded surface coarsening for the heal ceiling": the SHIPPED path.
 * Run: npm run probe -- scripts/probe/examples/heal-coarsen-product.ts --run   (diagnostics: JSON on stderr)
 *
 * coarsenStlBoundary (mmgs, hausd bisected to a triangle target) then the unchanged checkMeshHealth, on
 *   - large-sphere-100k.stl   (smooth, analytic volume 4/3*pi*10^3)
 *   - cube.stl refined x4     (sharp edges: ridges must survive; analytic volume 1000)
 *   - bull.stp tessellated    (a real CAD part with fillets; reference = the raw mesh volume)
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { coarsenStlBoundary } from "../../../src/mmgCoarsen";
import { checkMeshHealth } from "../../../src/meshHeal";
import { loadBRep } from "../../../src/occtService";
import { getMeshio } from "../../../src/meshioService";
import { kernelVersions } from "../../../src/kernelVersions";
import { TESSELLATION_PRESETS } from "../../../src/tessellationQuality";

console.log = console.error.bind(console);
console.info = console.error.bind(console);
console.warn = console.error.bind(console);

const EXT = process.cwd();
const TARGET = Number(process.env.HEAL_TARGET ?? 1000);

async function bullStl(): Promise<Uint8Array> {
  const r = await loadBRep(EXT, readFileSync("examples/STP/bull.stp"), "step", [], TESSELLATION_PRESETS.fine);
  const positions: number[] = [];
  const indices: number[] = [];
  for (const g of r.groups) for (const f of g.faces) {
    const base = positions.length / 3;
    for (const p of f.buffers.positions) positions.push(p);
    for (const i of f.buffers.indices) indices.push(base + i);
  }
  const soup = new Float32Array(indices.length * 3);
  indices.forEach((vi, k) => { soup[k * 3] = positions[vi * 3]; soup[k * 3 + 1] = positions[vi * 3 + 1]; soup[k * 3 + 2] = positions[vi * 3 + 2]; });
  // weldTriangleSoup is applied inside coarsenStlBoundary; hand it an STL soup.
  return stlFromSoup(soup);
}

function stlFromSoup(soup: Float32Array): Uint8Array {
  const n = soup.length / 9;
  const buf = Buffer.alloc(84 + n * 50);
  buf.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50;
    for (let k = 0; k < 9; k++) buf.writeFloatLE(soup[t * 9 + k], o + 12 + k * 4);
  }
  return buf;
}

async function refinedCube(levels: number): Promise<Uint8Array> {
  const m = await getMeshio();
  m.FS.writeFile("/rc-in.stl", readFileSync("examples/STL/cube.stl"));
  try {
    const mesh = m.readMesh("/rc-in.stl", "stl");
    const r: any = m.refine(mesh, levels);
    const rm = r.mesh ?? r;
    const tri = { ...rm, cells: (rm.cells as any[]).filter((b) => b.type === "triangle"), cell_data: {}, regions: [] };
    m.writeMesh("/rc-out.stl", tri);
    return m.FS.readFile("/rc-out.stl");
  } finally {
    for (const p of ["/rc-in.stl", "/rc-out.stl"]) { try { m.FS.unlink(p); } catch { /* ignore */ } }
  }
}

async function volumeOf(stl: Uint8Array): Promise<{ tris: number; vol: number }> {
  const r = await checkMeshHealth(EXT, stl, "stl").catch((e: Error) => ({ error: e.message }) as any);
  return r;
}

async function one(label: string, stl: Uint8Array, analytic: number | null): Promise<void> {
  const row: Record<string, unknown> = { label, target: TARGET };
  try {
    const t0 = performance.now();
    const c = await coarsenStlBoundary(EXT, stl, TARGET);
    row.coarsenMs = Math.round(performance.now() - t0);
    Object.assign(row, { from: c.fromTriangles, to: c.toTriangles, hausd: c.hausd, hausdFraction: c.hausdFraction, iterations: c.iterations });
    const t1 = performance.now();
    const rep = await checkMeshHealth(EXT, c.bytes, "stl");
    row.healMs = Math.round(performance.now() - t1);
    const comp = rep.components.reduce((a, b) => (b.triangleCount > a.triangleCount ? b : a), rep.components[0]);
    Object.assign(row, {
      components: rep.componentCount, free: comp.freeEdgeCount, nonManifold: comp.nonManifoldEdgeCount, inconsistent: comp.inconsistentPairCount,
      tol: comp.requiredTolerance, rawVolume: comp.rawVolume, healedVolume: comp.healedVolume,
      healedVsAnalyticPct: analytic && comp.healedVolume != null ? ((comp.healedVolume - analytic) / analytic) * 100 : null,
    });
    row.pass = comp.healedVolume != null && comp.nonManifoldEdgeCount === 0 && (analytic == null || Math.abs(comp.healedVolume - analytic) / analytic <= 0.02);
  } catch (e) {
    row.error = String((e as Error)?.message ?? e).slice(0, 300);
    row.pass = false;
  }
  console.error(JSON.stringify(row));
}

async function main(): Promise<void> {
  console.error(JSON.stringify({ versions: kernelVersions() }));
  await one("sphere-100k", readFileSync("examples/STL/large-sphere-100k.stl"), (4 / 3) * Math.PI * 1000);
  await one("cube refined x4", await refinedCube(4), 1000);
  const bull = await bullStl();
  const bullRaw = await volumeOf(bull);
  const bc = (bullRaw as any).components?.[0];
  console.error(JSON.stringify({ label: "bull raw", error: (bullRaw as any).error, triangles: bc?.triangleCount, free: bc?.freeEdgeCount, rawVolume: bc?.rawVolume, healedVolume: bc?.healedVolume }));
  await one("bull fine", bull, null);
}

main().catch((e) => { console.error(e); process.exit(1); });
