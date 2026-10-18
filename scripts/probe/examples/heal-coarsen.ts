/** Roadmap probe "Hausdorff-bounded surface coarsening for the heal ceiling" (re-run). NOT a product API.
 * Run: npm run probe -- scripts/probe/examples/heal-coarsen.ts --run   (diagnostics: JSON on stderr)
 *
 * Coarsens examples/STL/large-sphere-100k.stl (r=10 at the origin, analytic volume 4/3*pi*10^3) to
 * about 1 000 triangles with every candidate this build offers, then scores each through the
 * UNCHANGED checkMeshHealth: free / non-manifold edges, inconsistent pairs, healed volume, time.
 * Candidates: shipped decimate (control, must heal to volume 0), decimate placement variants,
 * meshio++ remesh (isotropic / quadric / anisotropic, boundary seeding both ways, extra repair
 * passes), and mmgs at several hausd/hmax pairs.
 *
 * Gate: pass = healed volume within 2 % of analytic AND zero non-manifold edges.
 * Exit 0 means the probe completed, not that a candidate passed: read `gate`.
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { getMeshio } from "../../../src/meshioService";
import { getMmg } from "../../../src/mmgService";
import { checkMeshHealth } from "../../../src/meshHeal";
import { parseStl } from "../../../src/stlParser";
import { weldTriangleSoup } from "../../../src/meshComponents";
import { kernelVersions } from "../../../src/kernelVersions";

console.log = console.error.bind(console);
console.info = console.error.bind(console);
console.warn = console.error.bind(console);

const ANALYTIC = (4 / 3) * Math.PI * 1000;
const FIXTURE = "examples/STL/large-sphere-100k.stl";
const TARGET = Number(process.env.HEAL_TARGET ?? 1000);

type Cell = { type: string; data: ArrayLike<number> };
const triCount = (cells: Cell[]): number => cells.reduce((n, b) => n + (b.type === "triangle" ? Math.floor(b.data.length / 3) : 0), 0);

/** Triangles-only copy of a meshio++ mesh, written to binary STL bytes. */
async function toStl(mesh: any): Promise<Uint8Array> {
  const m = await getMeshio();
  const tri = { ...mesh, cells: (mesh.cells as Cell[]).filter((b) => b.type === "triangle"), cell_data: {}, regions: [] };
  m.writeMesh("/hc-out.stl", tri);
  try { return m.FS.readFile("/hc-out.stl"); } finally { try { m.FS.unlink("/hc-out.stl"); } catch { /* ignore */ } }
}

async function score(label: string, produce: () => Promise<{ stl: Uint8Array; extra?: Record<string, unknown> }>): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = { label };
  try {
    let t0 = performance.now();
    const { stl, extra } = await produce();
    row.coarsenMs = Math.round(performance.now() - t0);
    Object.assign(row, extra ?? {});
    t0 = performance.now();
    const report = await checkMeshHealth(process.cwd(), stl, "stl");
    row.healMs = Math.round(performance.now() - t0);
    row.components = report.componentCount;
    const c = report.components.reduce((a, b) => (b.triangleCount > a.triangleCount ? b : a), report.components[0]);
    Object.assign(row, {
      triangles: c.triangleCount,
      freeEdges: c.freeEdgeCount,
      nonManifoldEdges: c.nonManifoldEdgeCount,
      degenerate: c.degenerateFaceCount,
      inconsistentPairs: c.inconsistentPairCount,
      rawVolume: c.rawVolume,
      requiredTolerance: c.requiredTolerance,
      healedVolume: c.healedVolume,
      healedVsAnalyticPct: c.healedVolume == null ? null : ((c.healedVolume - ANALYTIC) / ANALYTIC) * 100,
    });
    row.pass = c.healedVolume != null && Math.abs(c.healedVolume - ANALYTIC) / ANALYTIC <= 0.02 && c.nonManifoldEdgeCount === 0;
  } catch (e) {
    row.error = String((e as Error)?.message ?? e).slice(0, 300);
    row.pass = false;
  }
  console.error(JSON.stringify(row));
  return row;
}

async function readFixture(): Promise<any> {
  const m = await getMeshio();
  m.FS.writeFile("/hc-in.stl", readFileSync(FIXTURE));
  try { return m.readMesh("/hc-in.stl", "stl"); } finally { m.FS.unlink("/hc-in.stl"); }
}

async function main(): Promise<void> {
  const out: Record<string, unknown> = { versions: kernelVersions(), target: TARGET, analyticVolume: ANALYTIC };
  console.error(JSON.stringify(out));
  const m = await getMeshio();
  const rows: Record<string, unknown>[] = [];
  const base = await readFixture();
  const inTris = triCount(base.cells);
  out.inputTriangles = inTris;

  // --- decimate (shipped backend and its knobs) ---
  const ratio = TARGET / inTris;
  const dec = async (label: string, opts: { placement?: string; preserveBoundary?: boolean; preserveFeatures?: boolean; maxError?: number; targetFaces?: number; byRatio?: boolean }) =>
    rows.push(await score(label, async () => {
      const mesh = await readFixture();
      const r = opts.byRatio === false
        ? m.decimate(mesh, undefined as any, opts.targetFaces ?? TARGET, undefined as any, opts.placement as any, opts.preserveBoundary, opts.preserveFeatures)
        : m.decimate(mesh, ratio, undefined as any, undefined as any, opts.placement as any, opts.preserveBoundary, opts.preserveFeatures);
      return { stl: await toStl(r.mesh), extra: { maxErrorApplied: r.maxErrorApplied, collapsesRejected: r.collapsesRejected } };
    }));
  await dec("decimate ratio (shipped control)", {});
  await dec("decimate placement=midpoint", { placement: "midpoint" });
  await dec("decimate placement=endpoint", { placement: "endpoint" });
  await dec("decimate targetFaces", { byRatio: false });
  await dec("decimate preserveFeatures=false", { preserveFeatures: false });
  // placement=endpoint was the first candidate to heal to a POSITIVE volume; characterise it.
  await dec("decimate endpoint preserveFeatures=false", { placement: "endpoint", preserveFeatures: false });
  await dec("decimate endpoint preserveBoundary=false", { placement: "endpoint", preserveBoundary: false });
  for (const target of [500, 750, 1500]) {
    await dec(`decimate endpoint targetFaces=${target}`, { placement: "endpoint", byRatio: false, targetFaces: target });
  }

  // --- meshio++ remesh: numClusters counts VERTICES (F ~ 2V), so V ~ TARGET/2 ---
  const clusters = Math.round(TARGET / 2);
  const rem = async (label: string, metric: string, preserveBoundary: boolean, repair: number, extra: Partial<Record<string, number>> = {}) =>
    rows.push(await score(label, async () => {
      const mesh = await readFixture();
      const r = m.remesh(mesh, clusters + (extra.dClusters ?? 0), -1, undefined as any, undefined as any, undefined as any, repair, metric as any, undefined as any, preserveBoundary);
      return { stl: await toStl(r.mesh), extra: { numClusters: r.numClusters, numIterations: r.numIterations, numIsolatedClusters: r.numIsolatedClusters, numNonManifoldVertices: r.numNonManifoldVertices } };
    }));
  await rem("remesh isotropic", "isotropic", true, undefined as any);
  await rem("remesh isotropic preserveBoundary=false", "isotropic", false, undefined as any);
  await rem("remesh isotropic repair=50", "isotropic", false, 50);
  await rem("remesh quadric", "quadric", false, undefined as any);
  await rem("remesh quadric repair=50", "quadric", false, 50);
  await rem("remesh anisotropic", "anisotropic", false, undefined as any);

  // --- mmgs (surface) ---
  const sphere = weldTriangleSoup(parseStl(readFileSync(FIXTURE)));
  const mmg = await getMmg(process.cwd());
  const mmgs = async (label: string, hausd: number, hmax?: number) =>
    rows.push(await score(label, async () => {
      const api = mmg.mmgs;
      const h = api.init();
      try {
        const tris = Int32Array.from(sphere.indices, (n) => n + 1);
        api.setMeshSize(h.mesh, sphere.positions.length / 3, tris.length / 3, 0);
        api.setVertices(h.mesh, Float64Array.from(sphere.positions), null);
        api.setTriangles(h.mesh, tris, new Int32Array(tris.length / 3).fill(1));
        api.setIparameter(h.mesh, h.met, api.IPARAM_verbose, -1);
        api.setDparameter(h.mesh, h.met, api.DPARAM_hausd, hausd);
        if (hmax !== undefined) api.setDparameter(h.mesh, h.met, api.DPARAM_hmax, hmax);
        const status = api.remesh(h.mesh, h.met);
        const size = api.getMeshSize(h.mesh);
        const v = api.getVertices(h.mesh, size.np).vertices;
        const t = api.getTriangles(h.mesh, size.nt).tria;
        let maxRadial = 0;
        for (let i = 0; i < v.length; i += 3) maxRadial = Math.max(maxRadial, Math.abs(Math.hypot(v[i], v[i + 1], v[i + 2]) - 10));
        const stl = await toStl({
          points: Float64Array.from(v),
          dim: 3,
          cells: [{ type: "triangle", nodesPerCell: 3, data: Int32Array.from(t, (n: number) => n - 1) }],
          point_data: {}, field_data: {}, cell_data: {},
        });
        return { stl, extra: { mmgStatus: status, maxVertexRadialError: maxRadial, hausd, hmax: hmax ?? null } };
      } finally { api.free(h); }
    }));
  await mmgs("mmgs hausd=0.01 (earlier candidate)", 0.01);
  await mmgs("mmgs hausd=0.01 hmax=1.7", 0.01, 1.7);
  await mmgs("mmgs hausd=0.003 hmax=1.7", 0.003, 1.7);
  await mmgs("mmgs hausd=0.05 hmax=1.7", 0.05, 1.7);
  // Sweep hausd (ABSOLUTE units, r=10 sphere) towards ~1 000 triangles; the earlier negative probe used
  // hausd=0.346 (1 % of the diagonal), which over-coarsens to 391 open triangles.
  for (const h of [0.08, 0.1, 0.12, 0.15, 0.2, 0.25]) await mmgs(`mmgs hausd=${h} hmax=1.7`, h, 1.7);
  for (const h of [0.1, 0.15, 0.2]) await mmgs(`mmgs hausd=${h}`, h);

  const passing = rows.filter((r) => r.pass).map((r) => r.label);
  out.rows = rows;
  out.gate = { pass: passing.length > 0, passing, rule: "healed volume within 2% of analytic AND zero non-manifold edges" };
  console.error(JSON.stringify(out.gate));
}

main().catch((e) => { console.error(e); process.exit(1); });
