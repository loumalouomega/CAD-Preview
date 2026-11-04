/** Live probe of the meshio++ 18.1 additions: call shapes, return shapes and degenerate inputs.
 * Run: npm run probe -- scripts/probe/examples/meshio-1810-surface.ts --run */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";
console.log = console.error.bind(console);
const show = (label: string, v: unknown): void => console.error(label, JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : ArrayBuffer.isView(x) ? `${(x as any).constructor.name}[${(x as any).length}]` : x)).slice(0, 700));
const attempt = async (label: string, f: () => unknown): Promise<unknown> => {
  try { const r = await f(); show(`OK ${label}`, r); return r; } catch (e) { console.error(`FAIL ${label}:`, (e as Error)?.message ?? e); return undefined; }
};
async function main(): Promise<void> {
  const m: any = await getMeshio();
  const cube = new Uint8Array(fs.readFileSync("examples/STL/cube.stl"));
  m.FS.writeFile("/c.stl", cube);
  const surf0 = m.readMesh("/c.stl", "stl");
  const surf = m.refine(surf0, 3, false);
  show("surface", { dim: surf.dim, pts: surf.points.length / surf.dim, cells: surf.cells.map((b: any) => [b.type, b.data.length]) });
  const tet = m.tetrahedralize(surf0, { backend: "octree", maxSize: 2 }).mesh;
  show("tet", { pts: tet.points.length / tet.dim, cells: tet.cells.map((b: any) => [b.type, b.data.length]) });
  const r = (x: any) => x?.mesh ? { ...x, mesh: { pts: x.mesh.points.length / x.mesh.dim, cells: x.mesh.cells.map((b: any) => [b.type, b.data.length]), pd: Object.keys(x.mesh.point_data ?? {}), cd: Object.keys(x.mesh.cell_data ?? {}), fd: Object.keys(x.mesh.field_data ?? {}) } } : x;
  await attempt("convexHull 3d", () => r(m.convexHull(tet)));
  await attempt("convexHull dimension 2", () => r(m.convexHull(surf, { dimension: 2 })));
  await attempt("delaunay2d", () => r(m.delaunay2d(surf)));
  await attempt("untangle tet", () => r(m.untangle(tet)));
  await attempt("untangle surface (expect throw)", () => r(m.untangle(surf)));
  await attempt("adjacency node", () => { const a = m.adjacency(surf, "node"); return { ip: a.indptr.length, ix: a.indices.length, t: a.indptr.constructor.name }; });
  await attempt("adjacency clique", () => { const a = m.adjacency(tet, "clique"); return { ip: a.indptr.length, ix: a.indices.length }; });
  await attempt("adjacency cell", () => { const a = m.adjacency(tet, "cell"); return { ip: a.indptr.length, ix: a.indices.length }; });
  await attempt("writeGraph metis", () => { const x = m.writeGraph(tet, "/g.graph", "node", "metis"); return { x, bytes: m.FS.readFile("/g.graph").length }; });
  await attempt("writeGraph scotch", () => { const x = m.writeGraph(tet, "/g.grf", "clique"); return { x, bytes: m.FS.readFile("/g.grf").length }; });
  await attempt("geodesicDistance", () => { const x = m.geodesicDistance(surf, [0]); const d = x.mesh.point_data["geodesic:distance"]; return { ...r(x), d0: d[0], dmax: Math.max(...d) }; });
  await attempt("geodesicDistance number source", () => r(m.geodesicDistance(surf, 0)));
  await attempt("geodesicDistance no source (expect throw)", () => r(m.geodesicDistance(surf, [])));
  await attempt("parameterize", () => r(m.parameterize(surf)));
  await attempt("laplacianEigenmodes", () => { const x = m.laplacianEigenmodes(surf, { numModes: 4 }); return { ...r(x), eig: x.eigenvalues }; });
  const cloud = { ...surf, cells: [], regions: [], cell_data: {}, cell_data_components: {}, field_data: {}, field_data_components: {}, point_data: {}, point_data_components: {} };
  show("cloud", { pts: cloud.points.length / cloud.dim });
  const withN = await attempt("estimateNormals", () => { const x = m.estimateNormals(cloud, { k: 8 }); return { ...r(x), nrm: Array.from(x.mesh.point_data.normals.slice(0, 6)) }; }) as any;
  await attempt("reconstructSurface (estimates normals)", () => r(m.reconstructSurface(cloud, {})));
  await attempt("reconstructSurface from estimated normals", () => withN && r(m.reconstructSurface(withN.mesh, { estimateNormals: false })));
  await attempt("registerRigid identity", () => m.registerRigid(surf, surf));
  const shifted = { ...surf, points: Float64Array.from(surf.points, (v: number, i: number) => (i % 3 === 0 ? v + 0.5 : v)) };
  await attempt("registerRigid shifted", () => m.registerRigid(shifted, surf, { maxIterations: 50 }));
  await attempt("convertCoordinates cylindrical", () => r(m.convertCoordinates(tet, { system: "cylindrical", axis: [0, 0, 1] })));
  const n = tet.points.length / tet.dim;
  const metric = new Float64Array(n * 6);
  for (let i = 0; i < n; i++) { metric[i * 6] = 4; metric[i * 6 + 3] = 4; metric[i * 6 + 5] = 4; }
  const withMetric = { ...tet, point_data: { ...(tet.point_data ?? {}), m1: metric }, point_data_components: { ...(tet.point_data_components ?? {}), m1: 6 } };
  await attempt("prepareMetric", () => r(m.prepareMetric(withMetric, { arrays: ["m1"], targetVertices: 200 })));
  await attempt("prepareMetric missing array (expect throw)", () => r(m.prepareMetric(tet, { arrays: ["nope"] })));
  const disp = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) disp[i * 3] = 0.1 * tet.points[i * 3 + 2];
  const withD = { ...tet, point_data: { ...(tet.point_data ?? {}), d: disp }, point_data_components: { ...(tet.point_data_components ?? {}), d: 3 } };
  await attempt("morph", () => r(m.morph(withD, { array: "d" })));
}
main().then(() => process.exit(0), (e) => { console.error("fatal", e?.message ?? e); process.exit(1); });
