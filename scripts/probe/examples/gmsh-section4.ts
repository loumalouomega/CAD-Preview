/** Roadmap meshing probes 4.5 (healing), 4.6 (type-140), 4.7 (periodic), 4.8 (size callback).
 * Run: npm run probe -- scripts/probe/examples/gmsh-section4.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probes completed, not that a gate passed.
 */
import * as fs from "fs";
import { getGmsh, resetGmsh } from "../../../src/gmshService";

console.log = console.error.bind(console);
const out: Record<string, unknown> = {};
const num = (r: unknown): number => (typeof r === "number" ? r : (r as { value: number }).value);

async function load(gmsh: any, file: string): Promise<void> {
  gmsh.clear();
  gmsh.model.add("m");
  gmsh.FS.writeFile("/model.step", fs.readFileSync(file));
  gmsh.model.occ.importShapes("/model.step");
  gmsh.model.occ.synchronize();
  for (const k of ["General.NumThreads", "Mesh.MaxNumThreads1D", "Mesh.MaxNumThreads2D", "Mesh.MaxNumThreads3D"]) gmsh.option.setNumber(k, 1);
  gmsh.option.setNumber("Mesh.Algorithm3D", 1);
  gmsh.option.setNumber("Mesh.SaveAll", 1);
}

function tetVolume(gmsh: any): { tets: number; volume: number; nodes: number } {
  const els = gmsh.model.mesh.getElements(3) as { elementTypes: number[]; nodeTags: number[][] };
  const nodes = gmsh.model.mesh.getNodes(-1, -1, false, false) as { nodeTags: number[]; coord: number[] };
  const pos = new Map<number, number[]>();
  nodes.nodeTags.forEach((t, i) => pos.set(t, [nodes.coord[3 * i], nodes.coord[3 * i + 1], nodes.coord[3 * i + 2]]));
  let vol = 0, tets = 0;
  els.elementTypes.forEach((ty, k) => {
    if (ty !== 4) return;
    const nt = els.nodeTags[k];
    for (let i = 0; i + 4 <= nt.length; i += 4) {
      const [a, b, c, d] = [0, 1, 2, 3].map((j) => pos.get(nt[i + j])!);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      vol += Math.abs(u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0])) / 6;
      tets++;
    }
  });
  return { tets, volume: vol, nodes: nodes.nodeTags.length };
}

async function tryMesh(gmsh: any, file: string, heal: boolean, sizeMax: number): Promise<Record<string, unknown>> {
  const r: Record<string, unknown> = { file, heal };
  try {
    await load(gmsh, file);
    r.facesBefore = (gmsh.model.getEntities(2).dimTags as number[]).length / 2;
    r.volumesBefore = (gmsh.model.getEntities(3).dimTags as number[]).length / 2;
    if (heal) {
      gmsh.model.occ.removeAllDuplicates();
      gmsh.model.occ.healShapes();
      gmsh.model.occ.synchronize();
      r.facesAfter = (gmsh.model.getEntities(2).dimTags as number[]).length / 2;
      r.volumesAfter = (gmsh.model.getEntities(3).dimTags as number[]).length / 2;
    }
    gmsh.option.setNumber("Mesh.MeshSizeMax", sizeMax);
    gmsh.option.setNumber("Mesh.MeshSizeMin", 0);
    const t0 = Date.now();
    gmsh.model.mesh.generate(3);
    r.ms = Date.now() - t0;
    Object.assign(r, tetVolume(gmsh), { ok: true });
  } catch (e) {
    r.ok = false;
    r.error = String((e as Error)?.message ?? e).slice(0, 200);
    if (/abort|out of bounds|unreachable/i.test(String(r.error))) resetGmsh();
  }
  return r;
}

async function main(): Promise<void> {
  let gmsh = await getGmsh(process.cwd());

  // 4.5
  const heal: unknown[] = [];
  for (const f of ["block.stp", "daratech.stp"]) {
    for (const h of [false, true]) {
      gmsh = await getGmsh(process.cwd());
      heal.push(await tryMesh(gmsh, `examples/STP/${f}`, h, f === "block.stp" ? 2 : 50));
    }
  }
  out.heal45 = heal;

  // 4.6
  resetGmsh();
  try {
    gmsh = await getGmsh(process.cwd());
    await load(gmsh, "examples/STP/block.stp");
    gmsh.option.setNumber("Mesh.MeshSizeMax", 1);
    gmsh.option.setNumber("Mesh.Algorithm3D", 9);
    gmsh.option.setNumber("Mesh.RecombineAll", 0);
    gmsh.option.setNumber("Mesh.SubdivisionAlgorithm", 0);
    gmsh.option.setNumber("Mesh.Recombine3DAll", 1);
    gmsh.model.mesh.generate(3);
    const els = gmsh.model.mesh.getElements(3, -1) as { elementTypes: number[]; elementTags: number[][]; nodeTags: number[][] };
    const nodes = gmsh.model.mesh.getNodes(-1, -1, false, false) as { nodeTags: number[]; coord: number[] };
    const pos = new Map<number, number[]>();
    nodes.nodeTags.forEach((t, i) => pos.set(t, [nodes.coord[3 * i], nodes.coord[3 * i + 1], nodes.coord[3 * i + 2]]));
    const types: Record<string, number> = {};
    els.elementTypes.forEach((t, k) => (types[t] = els.elementTags[k].length));
    const k140 = els.elementTypes.indexOf(140);
    const info: Record<string, unknown> = { types };
    if (k140 >= 0) {
      const nt = els.nodeTags[k140];
      const n = els.elementTags[k140].length;
      info.nodesPerElement = nt.length / n;
      info.sample = Array.from({ length: Math.min(2, n) }, (_, e) => {
        const per = nt.length / n;
        return nt.slice(e * per, (e + 1) * per).map((id) => pos.get(id));
      });
      info.distinctNodesFirst = new Set(nt.slice(0, nt.length / n)).size;
    }
    out.hex46 = info;
  } catch (e) { out.hex46 = { error: String((e as Error)?.message ?? e).slice(0, 300) }; resetGmsh(); }

  // 4.7 (reset: hex-dominant options persist in the singleton and break periodic faces)
  resetGmsh();
  try {
    gmsh = await getGmsh(process.cwd());
    await load(gmsh, "examples/STP/block.stp");
    const surf = (gmsh.model.getEntities(2).dimTags as number[]);
    const info: Array<{ tag: number; cx: number; bb: number[] }> = [];
    for (let i = 0; i < surf.length; i += 2) {
      const bb = gmsh.model.getBoundingBox(2, surf[i + 1]) as { xmin: number; ymin: number; zmin: number; xmax: number; ymax: number; zmax: number };
      info.push({ tag: surf[i + 1], cx: (bb.xmin + bb.xmax) / 2, bb: [bb.xmin, bb.xmax, bb.xmax - bb.xmin] });
    }
    const minus = info.filter((s) => s.bb[2] < 1e-6 && s.cx < 0)[0];
    const plus = info.filter((s) => s.bb[2] < 1e-6 && s.cx > 0)[0];
    const dx = plus.cx - minus.cx;
    gmsh.option.setNumber("Mesh.MeshSizeMax", 1.5);
    // master = plus face, slave = minus face; affine maps slave->master
    const sign = -1; // the affine transform maps master -> slave
    gmsh.model.mesh.setPeriodic(2, [minus.tag], [plus.tag], [1, 0, 0, sign * dx, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    gmsh.model.mesh.generate(3);
    const n = (gmsh.model.mesh.getPeriodicNodes(2, minus.tag, false) as any);
    const nodesM = gmsh.model.mesh.getNodes(2, minus.tag, true, false) as { nodeTags: number[]; coord: number[] };
    const nodesP = gmsh.model.mesh.getNodes(2, plus.tag, true, false) as { nodeTags: number[]; coord: number[] };
    const key = (c: number[], i: number) => `${(c[3 * i + 1]).toFixed(6)},${(c[3 * i + 2]).toFixed(6)}`;
    const pset = new Set(nodesP.nodeTags.map((_, i) => key(nodesP.coord, i)));
    let matched = 0;
    nodesM.nodeTags.forEach((_, i) => { if (pset.has(key(nodesM.coord, i))) matched++; });
    out.periodic47 = { dx, minusNodes: nodesM.nodeTags.length, plusNodes: nodesP.nodeTags.length, matched, getPeriodicNodes: JSON.stringify(n).slice(0, 200) };
  } catch (e) { out.periodic47 = { error: String((e as Error)?.message ?? e).slice(0, 300) }; resetGmsh(); }

  // 4.8
  try {
    gmsh = await getGmsh(process.cwd());
    await load(gmsh, "examples/STP/block.stp");
    const bb = gmsh.model.getBoundingBox(-1, -1) as { zmin: number; zmax: number };
    let calls = 0;
    const t0 = Date.now();
    gmsh.option.setNumber("Mesh.MeshSizeMax", 5);
    gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0);
    gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0);
    gmsh.model.mesh.setSizeCallback((_d: number, _t: number, _x: number, _y: number, z: number) => {
      calls++;
      return 0.3 + 1.2 * (z - bb.zmin) / (bb.zmax - bb.zmin);
    });
    gmsh.model.mesh.generate(3);
    const ms = Date.now() - t0;
    const a = tetVolume(gmsh);
    // mean edge length by z-band via nodes of 1D edges
    const ed = gmsh.model.mesh.getElements(1) as { elementTypes: number[]; nodeTags: number[][] };
    const nodes = gmsh.model.mesh.getNodes(-1, -1, false, false) as { nodeTags: number[]; coord: number[] };
    const pos = new Map<number, number[]>();
    nodes.nodeTags.forEach((t, i) => pos.set(t, [nodes.coord[3 * i], nodes.coord[3 * i + 1], nodes.coord[3 * i + 2]]));
    const bands: Array<{ s: number; n: number }> = [{ s: 0, n: 0 }, { s: 0, n: 0 }, { s: 0, n: 0 }];
    const nt = ed.nodeTags.flat();
    for (let i = 0; i + 2 <= nt.length; i += 2) {
      const p = pos.get(nt[i])!, q = pos.get(nt[i + 1])!;
      if (Math.abs(p[2] - q[2]) < 1e-9) continue;
      const len = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      const zf = ((p[2] + q[2]) / 2 - bb.zmin) / (bb.zmax - bb.zmin);
      const b = bands[Math.min(2, Math.floor(zf * 3))];
      b.s += len; b.n++;
    }
    gmsh.model.mesh.removeSizeCallback();
    out.callback48 = { calls, ms, tets: a.tets, bandMeanVerticalEdge: bands.map((b) => (b.n ? b.s / b.n : null)) };
    gmsh.clear();
    await load(gmsh, "examples/STP/block.stp");
    gmsh.option.setNumber("Mesh.MeshSizeMax", 5);
    gmsh.model.mesh.generate(3);
    (out.callback48 as any).afterRemoveTets = tetVolume(gmsh).tets;
  } catch (e) { out.callback48 = { error: String((e as Error)?.message ?? e).slice(0, 300) }; resetGmsh(); }

  console.error(JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
