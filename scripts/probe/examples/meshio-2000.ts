/** Live probe of the meshio++ 20.0.0 additions (scan / metrology / surface editing).
 * Run: npm run probe -- scripts/probe/examples/meshio-2000.ts --run */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";
console.log = console.error.bind(console);
const show = (label: string, v: unknown): void => console.error(label, JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : ArrayBuffer.isView(x) ? (x as any).length <= 16 ? Array.from(x as any, Number) : `${(x as any).constructor.name}[${(x as any).length}]` : x)).slice(0, 900));
const attempt = async (label: string, f: () => unknown): Promise<any> => {
  try { const r = await f(); show(`OK ${label}`, r); return r; } catch (e) { console.error(`FAIL ${label}:`, (e as Error)?.message ?? e); return undefined; }
};
const brief = (mm: any) => ({ pts: mm.points.length / mm.dim, cells: mm.cells.map((b: any) => [b.type, b.data.length / (b.nodesPerCell ?? 1)]), pd: Object.keys(mm.point_data ?? {}), cd: Object.keys(mm.cell_data ?? {}), regions: (mm.regions ?? []).length });
const r = (x: any) => (x?.mesh ? { ...x, mesh: brief(x.mesh) } : x);
async function main(): Promise<void> {
  const m: any = await getMeshio();
  m.FS.writeFile("/c.stl", new Uint8Array(fs.readFileSync("examples/STL/cube.stl")));
  const cube = m.readMesh("/c.stl", "stl");
  const fine = m.refine(cube, 2, false);
  const shift = (mm: any, d: number) => ({ ...mm, points: Float64Array.from(mm.points, (v: number, i: number) => (i % 3 === 2 ? v + d : v)) });
  show("cube", brief(cube));
  await attempt("deviation shifted-by-0.1 vs cube", () => { const x = m.deviation(shift(fine, 0.1), { reference: fine, bins: 4 }); return { ...r(x), histogramEdges: undefined, histogramCounts: undefined, mean: x.mean, rms: x.rms, max: x.max, min: x.min, n: x.numMeasured }; });
  await attempt("deviation primitive plane", () => r(m.deviation(fine, { primitive: { type: "plane", params: [0, 0, 1, 5, 0, 0, 0, 0, 0, 0] } })));
  const dev = await attempt("deviation w/ tolerance + register", () => m.deviation(shift(fine, 0.3), { reference: fine, tolerance: 0.05, register: true }));
  const devS = m.deviation(shift(fine, 0.3), { reference: fine });
  await attempt("deviationRegions", () => r(m.deviationRegions(devS.mesh, { tolerance: 0.1 })));
  await attempt("exaggerate", () => r(m.exaggerate(devS.mesh, { scale: 5 })));
  await attempt("colorize deviation", () => r(m.colorize(devS.mesh, { field: "deviation:distance", cmap: "viridis" })));
  await attempt("measure plane spec", () => { const x = m.measure(fine, { elements: [{ name: "top", type: "plane", seeds: [[0, 0, 10]] }] }); return { ...r(x), report: x.report }; });
  await attempt("measure bad spec (expect throw)", () => r(m.measure(fine, "{}")));
  await attempt("registerLandmarks", () => m.registerLandmarks([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], [1, 0, 0, 2, 0, 0, 1, 1, 0, 1, 0, 1]));
  await attempt("findSymmetryPlane", () => m.findSymmetryPlane(fine, {}));
  await attempt("autoAlign", () => r(m.autoAlign(fine, {})));
  await attempt("registerRigid auto", () => m.registerRigid(shift(fine, 0.5), fine, { initial: "auto" }));
  await attempt("sections z", () => brief(m.sections(fine, [0, 0, 1], [2, 5, 8], {})));
  await attempt("silhouette z", () => { const x = m.silhouette(fine, { normal: [0, 0, 1] }); return r(x); });
  await attempt("silhouette extrude", () => { const x = m.silhouette(fine, { normal: [0, 0, 1], extrude: true }); return r(x); });
  const sec = m.sections(fine, [0, 0, 1], [5], {});
  await attempt("fitCurves", () => { const x = m.fitCurves(sec, {}); return { ...r(x), pieces: x.pieces.slice(0, 2) }; });
  await attempt("slice chain", () => brief(m.slice(fine, [0, 0, 5], [0, 0, 1], false, { chain: true })));
  await attempt("clip mid keepBelow", () => r(m.clip(fine, [0, 0, 5], [0, 0, 1], { keepBelow: true, cap: true })));
  await attempt("offsetSurface +1", () => { const x = m.offsetSurface(fine, 1, {}); const p = x.mesh.points; return { ...r(x), zmax: Math.max(...Array.from({ length: p.length / 3 }, (_, i) => p[i * 3 + 2])) }; });
  await attempt("thicken 1 inward", () => r(m.thicken(fine, 1, { side: "inward" })));
  await attempt("hollow 1", () => r(m.hollow(fine, 1, {})));
  await attempt("flipNormals", () => r(m.flipNormals(fine)));
  const island = { ...fine, points: Float64Array.from([...fine.points, 100, 100, 100, 101, 100, 100, 100, 101, 100]) };
  const nPts = fine.points.length / 3;
  island.cells = [...fine.cells, { type: "triangle", data: Int32Array.from([nPts, nPts + 1, nPts + 2]), nodesPerCell: 3 }];
  await attempt("removeIslands dryRun", () => r(m.removeIslands(island, { dryRun: true })));
  await attempt("removeIslands", () => r(m.removeIslands(island, {})));
  await attempt("thickness cone", () => r(m.thickness(fine, { method: "cone", twoSided: true })));
  await attempt("segment region (expect throw)", () => r(m.segment(fine, "primitive", 0.01, { region: "nope" })));
  await attempt("constrainPrimitives (no fit table, expect throw)", () => r(m.constrainPrimitives(fine, {})));
  await attempt("writeStepElements (no fit table, expect throw)", () => m.writeStepElements("/e.step", fine, {}));
  await attempt("profileSolid", () => { const x = m.profileSolid(sec, "extrude:10", {}); return r(x); });
  await attempt("faceSupport (needs fit_cad solid, expect throw)", () => r(m.faceSupport(fine, fine, {})));
  await attempt("fitCadIterate", () => { const x = m.fitCadIterate(fine, { maxRounds: 2 }); return { ...r(x), rounds: x.rounds }; });
}
main().then(() => process.exit(0), (e) => { console.error("fatal", e?.message ?? e); process.exit(1); });
