/** meshio++ 18.0.0 probe: MMG + Netgen in the FULL artifact, selectRegion,
 * findIntersections, thickness, tetToPoly/polyToTet, optimizeVolume objectives.
 * Run: npm run probe -- scripts/probe/examples/meshio-1800.ts --run   (JSON on stderr)
 * Exit 0 means the probe completed, not that any gate passed.
 */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";
import { brepSkinStlBytes } from "../../../src/octreeService";

console.log = console.error.bind(console);
const out = (o: unknown): void => { console.error(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? Number(v) : v))); };
const trunc = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 240);
function counts(mesh: any): Record<string, number> {
  const c: Record<string, number> = {};
  for (const b of mesh.cells) c[b.type] = (c[b.type] ?? 0) + Math.floor(b.data.length / (b.nodesPerCell ?? 1));
  return c;
}
function tryRun(label: string, f: () => any, pick: (r: any) => unknown): any {
  const t = Date.now();
  try { const r = f(); out({ label, ms: Date.now() - t, ...(pick(r) as object) }); return r; }
  catch (e) { out({ label, error: trunc(e) }); return null; }
}
let n = 0;
function readStl(m: any, bytes: Uint8Array): any {
  const p = `/p${n++}.stl`;
  m.FS.writeFile(p, bytes);
  return m.readMesh(p, "stl");
}
/** Translate a mesh by dx (Float64 points). */
function shifted(mesh: any, dx: number, dy = 0, dz = 0): any {
  const pts = Float64Array.from(mesh.points as ArrayLike<number>);
  for (let i = 0; i < pts.length; i += 3) { pts[i] += dx; pts[i + 1] += dy; pts[i + 2] += dz; }
  return { ...mesh, points: pts };
}

const tetOnly = (x: any): any => ({ ...x, cells: x.cells.filter((b: any) => b.type === "tetra") });
async function main(): Promise<void> {
  const m: any = await getMeshio();
  out({ hasNetgen: m.hasNetgen?.(), hasMmg: m.hasMmg?.(), hasMmgElas: m.hasMmgElas?.(), hasKahip: m.hasKahip?.() });
  const cube = readStl(m, fs.readFileSync("examples/STL/cube.stl"));
  out({ cube: counts(cube), bbox: [Math.min(...(cube.points as number[])), Math.max(...(cube.points as number[]))] });

  // ---- analysis ----
  tryRun("thickness:cube:auto", () => m.thickness(cube, {}), (r: any) => ({ dir: r.direction, hit: r.numHit, miss: r.numMissed, min: r.min, max: r.max, mean: r.mean, keys: Object.keys(r) }));
  tryRun("thickness:cube:inward", () => m.thickness(cube, { direction: "inward", threshold: 11 }), (r: any) => ({ dir: r.direction, hit: r.numHit, below: r.numBelow, min: r.min, max: r.max, minCell: r.minCell, minPoint: Array.from(r.minPoint ?? []) }));
  tryRun("thickness:cube:outward", () => m.thickness(cube, { direction: "outward" }), (r: any) => ({ hit: r.numHit, miss: r.numMissed, warnings: r.warnings }));
  tryRun("findIntersections:cube-self", () => m.findIntersections(cube, {}), (r: any) => ({ pairs: r.numPairs, tri: r.numTrianglePairs, coplanar: r.numCoplanar, segs: r.numSegments, clean: r.clean, warnings: r.warnings }));
  const cube2 = shifted(cube, 5, 5, 5);
  tryRun("findIntersections:cube-vs-shifted", () => m.findIntersections(cube, { other: cube2 }), (r: any) => ({ pairs: r.numPairs, tri: r.numTrianglePairs, coplanar: r.numCoplanar, segs: r.numSegments, segMesh: r.segments ? counts(r.segments) : null, clean: r.clean, pairsLen: r.pairs?.length }));
  tryRun("findIntersections:cube-vs-far", () => m.findIntersections(cube, { other: shifted(cube, 50) }), (r: any) => ({ pairs: r.numPairs, clean: r.clean }));
  tryRun("findIntersections:maxPairs", () => m.findIntersections(cube, { other: cube2, maxPairs: 2 }), (r: any) => ({ pairs: r.numPairs, kept: r.pairs?.length / 2, truncated: r.truncated }));
  tryRun("thickness:cube-to-other", () => m.thickness(cube, { other: shifted(cube, 30), direction: "outward" }), (r: any) => ({ hit: r.numHit, min: r.min, max: r.max }));
  tryRun("selectRegion:plane", () => m.selectRegion(cube, "top", { plane: [0, 0, 5, 0, 0, 1], mode: "all", kind: "cell" }), (r: any) => ({ cand: r.numCandidates, sel: r.numSelected, keys: Object.keys(r.mesh), cellSets: r.mesh.cellSets ? Object.keys(r.mesh.cellSets) : null, fieldData: r.mesh.fieldData ? Object.keys(r.mesh.fieldData) : null }));
  tryRun("selectRegion:box", () => m.selectRegion(cube, "bx", { box: [-6, -6, -6, 6, 6, -4], mode: "centroid" }), (r: any) => ({ cand: r.numCandidates, sel: r.numSelected }));
  tryRun("selectRegion:seed", () => m.selectRegion(cube, "face", { seed: [0, 0, 5], featureAngle: 30 }), (r: any) => ({ sel: r.numSelected, grown: r.numGrown }));
  tryRun("selectRegion:component", () => m.selectRegion(cube, "c0", { component: 0 }), (r: any) => ({ sel: r.numSelected, comps: r.numComponents }));
  tryRun("selectRegion:nocrit", () => m.selectRegion(cube, "x", {}), () => ({}));
  tryRun("selectRegion:points", () => m.selectRegion(cube, "pt", { kind: "point", box: [-6, -6, -6, 6, 6, -4] }), (r: any) => ({ sel: r.numSelected }));

  // ---- volume meshes ----
  const block = readStl(m, await brepSkinStlBytes(process.cwd(), fs.readFileSync("examples/STP/block.stp")));
  const bull = readStl(m, await brepSkinStlBytes(process.cwd(), fs.readFileSync("examples/STP/bull.stp")));
  const tets: Record<string, any> = {};
  for (const [name, skin, size] of [...(process.env.BULL ? [["bull", bull, 6] as const] : [["cube", cube, 2] as const, ["block", block, 0.8] as const])] as const) {
    for (const backend of ["netgen", "auto"]) {
      const r = tryRun(`${name}:tetrahedralize:${backend}`, () => m.tetrahedralize(skin, { backend, maxSize: size, maxVolume: size ** 3 / 6 }),
        (x: any) => ({ backend: x.backend, tets: x.numTetrahedra, newPts: x.numNewPoints, vol: x.volume, preserved: x.boundaryPreserved, dihedral: [x.minDihedralDeg, x.maxDihedralDeg], hausdorff: x.hausdorffToSurface, keys: Object.keys(x), warnings: x.warnings }));
      if (r && backend === "netgen") tets[name] = r.mesh;
    }
  }
  for (const [name, vol] of Object.entries(tets)) {
    const ctn = (x: any): unknown => ({ cells: counts(x) });
    tryRun(`${name}:optimizeVolume:worst`, () => m.optimizeVolume(tetOnly(vol), 5), (r: any) => ({ ...r, mesh: undefined }));
    tryRun(`${name}:optimizeVolume:energy`, () => m.optimizeVolume(tetOnly(vol), 5, true, true, true, 0, "energy", 7), (r: any) => ({ ...r, mesh: undefined }));
    const dual = tryRun(`${name}:tetToPoly`, () => m.tetToPoly(vol, {}, true), (r: any) => ({ ...ctn(r.mesh), newPts: r.numNewPoints, bfaces: r.numBoundaryFaces, split: r.numSplitVertices, vmap: r.vertexMap?.length }));
    if (dual) {
      tryRun(`${name}:polyToTet`, () => m.polyToTet(dual.mesh, true, true), (r: any) => ({ ...ctn(r.mesh), exact: r.numExactTets, fanned: r.numFannedCells }));
      tryRun(`${name}:tetToPoly:feature`, () => m.tetToPoly(vol, { featureAngle: 30, pointDataToCellData: true }), (r: any) => ctn(r));
      tryRun(`${name}:poly-write-vtu`, () => { m.writeMesh("/d.vtu", dual.mesh, "vtu"); return {}; }, () => ({ ok: true }));
      tryRun(`${name}:poly-write-mdpa`, () => { m.writeMesh("/d.mdpa", dual.mesh, "mdpa"); return {}; }, () => ({ ok: true }));
    }
    tryRun(`${name}:checkQuality`, () => m.computeQuality ? m.computeQuality(vol) : null, (r: any) => ({ keys: r ? Object.keys(r).slice(0, 8) : null }));
  }

  // ---- MMG ----
  const vol = tets.block ?? tets.cube;
  if (vol) {
    for (const hsiz of [2, 1, 0.5]) {
      tryRun(`block:adapt:hsiz${hsiz}`, () => m.adapt(vol, { hsiz, hausd: 0.05 }), (r: any) => ({ cells: counts(r.mesh), report: r.report }));
    }
    tryRun(`block:adapt:default`, () => m.adapt(vol, {}), (r: any) => ({ cells: counts(r.mesh), report: r.report }));
    tryRun(`block:adapt:surface`, () => m.adapt(block, { hsiz: 1 }), (r: any) => ({ cells: counts(r.mesh), report: r.report }));
    // level set: signed distance to a sphere at the centre, as point_data
    const p = vol.points as ArrayLike<number>;
    const ls = new Float64Array(p.length / 3);
    for (let i = 0; i < ls.length; i++) ls[i] = Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) - 1;
    const lsMesh = { ...vol, point_data: { ...(vol.point_data ?? {}), phi: ls }, point_data_components: { ...(vol.point_data_components ?? {}), phi: 1 } };
    tryRun("block:discretizeLevelset", () => m.discretizeLevelset(lsMesh, { levelSet: "phi", isovalue: 0, hmax: 0.4, hmin: 0.1, hausd: 0.05 }), (r: any) => ({ cells: counts(r.mesh), report: r.report }));
    tryRun("block:metricFromHessian", () => m.metricFromHessian(lsMesh, { hessian: "phi", error: 0.01 }), (r: any) => ({ keys: Object.keys(r), pd: r.pointData ? Object.keys(r.pointData) : null }));
    tryRun("block:move", () => m.move(vol, { displacement: "phi" }), () => ({}));
  }
  // mesh_domain from boundary lines: a unit square loop in 2-D
  const sq = { dim: 3, points: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), cells: [{ type: "line", data: new Int32Array([0, 1, 1, 2, 2, 3, 3, 0]), nodesPerCell: 2 }] };
  tryRun("meshDomain:square", () => m.meshDomain(sq, { hsiz: 0.2 }), (r: any) => ({ cells: counts(r.mesh), sub: r.numSubdomains, holes: r.numHoles, report: r.report }));
}

main().then(() => process.exit(0), (e) => { out({ fatal: trunc(e) }); process.exit(1); });

