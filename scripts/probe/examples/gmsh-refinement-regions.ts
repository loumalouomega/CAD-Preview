/** Do Gmsh's geometry-free `Box` / `Ball` / `Cylinder` size fields work on gmsh-wasm 0.4.0, and under which option names?
 * Run: npm run probe -- scripts/probe/examples/gmsh-refinement-regions.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that a gate passed.
 *
 * Method: mesh examples/STP/block.stp at a uniform sizeMax (control), then add one region field joined into
 * a `Min` background list (exactly how `setBackgroundMin` composes fields) and measure the mean tetra edge
 * length of elements whose centroid lies inside the region vs. outside region + transition.
 *
 * Gate (set before running): mean edge inside is within 20 % of VIn, the far band equals the control within
 * 10 %, a region wholly outside the model changes nothing, no WASM abort.
 */
import * as fs from "fs";
import { getGmsh } from "../../../src/gmshService";

console.log = console.error.bind(console);
type Gmsh = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const SIZE_MAX = Number(process.env.P_MAX ?? 2), VIN = Number(process.env.P_VIN ?? 0.8), THICK = Number(process.env.P_THICK ?? 1);
const ALG3 = Number(process.env.P_ALG ?? 1);

function load(gmsh: Gmsh): void {
  gmsh.clear();
  gmsh.model.add("m");
  gmsh.FS.writeFile("/model.step", fs.readFileSync("examples/STP/block.stp"));
  gmsh.model.occ.importShapes("/model.step");
  gmsh.model.occ.synchronize();
  for (const k of ["General.NumThreads", "Mesh.MaxNumThreads1D", "Mesh.MaxNumThreads2D", "Mesh.MaxNumThreads3D"]) gmsh.option.setNumber(k, 1);
  gmsh.option.setNumber("Mesh.Algorithm3D", ALG3);
  gmsh.option.setNumber("Mesh.SaveAll", 1);
  gmsh.option.setNumber("Mesh.MeshSizeMin", 0);
  gmsh.option.setNumber("Mesh.MeshSizeMax", SIZE_MAX);
}

interface Tet { c: number[]; meanEdge: number }

function readTets(gmsh: Gmsh): Tet[] {
  const els = gmsh.model.mesh.getElements(3) as { elementTypes: number[]; nodeTags: number[][] };
  const nodes = gmsh.model.mesh.getNodes(-1, -1, false, false) as { nodeTags: number[]; coord: number[] };
  const pos = new Map<number, number[]>();
  nodes.nodeTags.forEach((t, i) => pos.set(t, [nodes.coord[3 * i], nodes.coord[3 * i + 1], nodes.coord[3 * i + 2]]));
  const out: Tet[] = [];
  els.elementTypes.forEach((ty, k) => {
    if (ty !== 4) return;
    const nt = els.nodeTags[k];
    for (let i = 0; i + 4 <= nt.length; i += 4) {
      const p = [0, 1, 2, 3].map((j) => pos.get(nt[i + j])!);
      let s = 0;
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) s += Math.hypot(p[a][0] - p[b][0], p[a][1] - p[b][1], p[a][2] - p[b][2]);
      out.push({ c: [0, 1, 2].map((x) => (p[0][x] + p[1][x] + p[2][x] + p[3][x]) / 4), meanEdge: s / 6 });
    }
  });
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function run(gmsh: Gmsh, label: string, makeField: (F: any) => number, inside: (c: number[]) => number): Record<string, unknown> {
  try {
    load(gmsh);
    const F = gmsh.model.mesh.field;
    const f = makeField(F);
    const min = F.add("Min");
    F.setNumbers(min, "FieldsList", [f]);
    F.setAsBackgroundMesh(min);
    // The same global options the shipped pipeline sets when a background field is present.
    for (const [k, v] of [["Mesh.MeshSizeFromPoints", Number(process.env.P_FP ?? 0)], ["Mesh.MeshSizeExtendFromBoundary", Number(process.env.P_FP ?? 0)], ["Mesh.MeshSizeFromCurvature", 0]] as const) gmsh.option.setNumber(k, v);
    const t0 = Date.now();
    gmsh.model.mesh.generate(3);
    const tets = readTets(gmsh);
    // inside(c) = distance outside the region (<=0 inside, >THICK beyond the transition).
    const inEdges = tets.filter((t) => inside(t.c) <= 0).map((t) => t.meanEdge);
    const farEdges = tets.filter((t) => inside(t.c) > THICK * 1.5).map((t) => t.meanEdge);
    return { label, ms: Date.now() - t0, tets: tets.length, insideN: inEdges.length, insideMeanEdge: mean(inEdges), farN: farEdges.length, farMeanEdge: mean(farEdges) };
  } catch (e) { return { label, error: String((e as Error)?.message ?? e).slice(0, 300) }; }
}

async function main(): Promise<void> {
  const gmsh = await getGmsh(process.cwd());
  const out: Record<string, unknown> = {};
  load(gmsh);
  const bb = gmsh.model.getBoundingBox(-1, -1) as Record<string, number>;
  out.bbox = bb;
  gmsh.model.mesh.generate(3);
  const ctl = readTets(gmsh);
  out.control = { tets: ctl.length, meanEdge: mean(ctl.map((t) => t.meanEdge)) };

  const cx = (bb.xmin + bb.xmax) / 2, cy = (bb.ymin + bb.ymax) / 2, cz = (bb.zmin + bb.zmax) / 2;
  const R = Number(process.env.P_R ?? 1.2);
  out.ball = run(gmsh, "ball", (F) => {
    const f = F.add("Ball");
    F.setNumber(f, "Radius", R); F.setNumber(f, "VIn", VIN); F.setNumber(f, "VOut", SIZE_MAX); F.setNumber(f, "Thickness", THICK);
    F.setNumber(f, "XCenter", cx); F.setNumber(f, "YCenter", cy); F.setNumber(f, "ZCenter", cz);
    return f;
  }, (c) => Math.hypot(c[0] - cx, c[1] - cy, c[2] - cz) - R);

  const h = 0.8;
  out.box = run(gmsh, "box", (F) => {
    const f = F.add("Box");
    F.setNumber(f, "VIn", VIN); F.setNumber(f, "VOut", SIZE_MAX); F.setNumber(f, "Thickness", THICK);
    F.setNumber(f, "XMin", cx - h); F.setNumber(f, "XMax", cx + h);
    F.setNumber(f, "YMin", cy - h); F.setNumber(f, "YMax", cy + h);
    F.setNumber(f, "ZMin", cz - h); F.setNumber(f, "ZMax", cz + h);
    return f;
  }, (c) => Math.max(Math.abs(c[0] - cx), Math.abs(c[1] - cy), Math.abs(c[2] - cz)) - h);

  // Cylinder: centre + axis vector (half-length, per Gmsh docs) + radius, along +x.
  const half = Number(process.env.P_HALF ?? 1.0), cr = Number(process.env.P_CR ?? 0.9);
  out.cylinder = run(gmsh, "cylinder", (F) => {
    const f = F.add("Cylinder");
    F.setNumber(f, "VIn", VIN); F.setNumber(f, "VOut", SIZE_MAX); F.setNumber(f, "Radius", cr);
    F.setNumber(f, "XCenter", cx); F.setNumber(f, "YCenter", cy); F.setNumber(f, "ZCenter", cz);
    F.setNumber(f, "XAxis", half); F.setNumber(f, "YAxis", 0); F.setNumber(f, "ZAxis", 0);
    return f;
  }, (c) => Math.max(Math.abs(c[0] - cx) - half, Math.hypot(c[1] - cy, c[2] - cz) - cr));

  // Wholly outside the model: must change nothing.
  out.outside = run(gmsh, "ball-outside", (F) => {
    const f = F.add("Ball");
    F.setNumber(f, "Radius", 1); F.setNumber(f, "VIn", VIN); F.setNumber(f, "VOut", SIZE_MAX); F.setNumber(f, "Thickness", THICK);
    F.setNumber(f, "XCenter", cx + 100); F.setNumber(f, "YCenter", cy); F.setNumber(f, "ZCenter", cz);
    return f;
  }, () => 5);

  console.error(JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
