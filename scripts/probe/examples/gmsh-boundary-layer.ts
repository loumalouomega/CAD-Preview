/** Roadmap "Anisotropic boundary layers" gate: does a `BoundaryLayer` field survive a `Min`
 * background size field, and what does it do with two layers?
 * Run: npm run probe -- scripts/probe/examples/gmsh-boundary-layer.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that a gate passed.
 *
 * Pitfall: OCC bounding boxes carry a 1e-7 pad, so an edge at y = 0 has `ymax = 1e-7`. Selecting the
 * wall curve with a 1e-9 tolerance finds nothing and every layer silently degenerates to the plain mesh
 * (hit while writing this probe), hence `TOL` below.
 */
import { getGmsh } from "../../../src/gmshService";

console.log = console.error.bind(console);
type Gmsh = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const TOL = 1e-5;

interface Rect { bottom: number; top: number; bottomPts: number[]; topPts: number[] }

function rectangle(gmsh: Gmsh): Rect {
  gmsh.clear();
  gmsh.model.add("r");
  for (const k of ["General.NumThreads", "Mesh.MaxNumThreads1D", "Mesh.MaxNumThreads2D", "Mesh.MaxNumThreads3D"]) gmsh.option.setNumber(k, 1);
  gmsh.option.setNumber("Mesh.RecombineAll", 0);
  gmsh.option.setNumber("Mesh.Algorithm", 6);
  gmsh.model.occ.addRectangle(0, 0, 0, 10, 4);
  gmsh.model.occ.synchronize();
  let bottom = -1, top = -1;
  const cs = gmsh.model.getEntities(1).dimTags as number[];
  for (let i = 0; i < cs.length; i += 2) {
    const b = gmsh.model.getBoundingBox(1, cs[i + 1]);
    if (Math.abs(b.ymax) < TOL) bottom = cs[i + 1];
    if (Math.abs(b.ymin - 4) < TOL) top = cs[i + 1];
  }
  const bottomPts: number[] = [], topPts: number[] = [];
  const ps = gmsh.model.getEntities(0).dimTags as number[];
  for (let i = 0; i < ps.length; i += 2) {
    const b = gmsh.model.getBoundingBox(0, ps[i + 1]);
    if (Math.abs(b.ymax) < TOL) bottomPts.push(ps[i + 1]);
    if (Math.abs(b.ymin - 4) < TOL) topPts.push(ps[i + 1]);
  }
  return { bottom, top, bottomPts, topPts };
}

function layer(gmsh: Gmsh, curves: number[], fan: number[], wall = 0.05, ratio = 1.2, thickness = 0.5): number {
  const f = gmsh.model.mesh.field.add("BoundaryLayer");
  gmsh.model.mesh.field.setNumbers(f, "CurvesList", curves);
  gmsh.model.mesh.field.setNumbers(f, "FanPointsList", fan);
  gmsh.model.mesh.field.setNumber(f, "hwall_n", wall);
  gmsh.model.mesh.field.setNumber(f, "ratio", ratio);
  gmsh.model.mesh.field.setNumber(f, "thickness", thickness);
  gmsh.model.mesh.field.setNumber(f, "Quads", 1);
  gmsh.model.mesh.field.setAsBoundaryLayer(f);
  return f;
}

/** The production composition: Distance -> Threshold -> Min -> setAsBackgroundMesh. */
function background(gmsh: Gmsh, curves: number[], sizeMin: number, sizeMax: number): void {
  const F = gmsh.model.mesh.field;
  const d = F.add("Distance");
  F.setNumbers(d, "CurvesList", curves);
  F.setNumber(d, "Sampling", 100);
  const t = F.add("Threshold");
  F.setNumber(t, "InField", d);
  F.setNumber(t, "SizeMin", sizeMin);
  F.setNumber(t, "SizeMax", sizeMax);
  F.setNumber(t, "DistMin", 0.2);
  F.setNumber(t, "DistMax", 3);
  const m = F.add("Min");
  F.setNumbers(m, "FieldsList", [t]);
  F.setAsBackgroundMesh(m);
}

function measure(gmsh: Gmsh): Record<string, unknown> {
  gmsh.model.mesh.generate(2);
  const e = gmsh.model.mesh.getElements(2) as { elementTypes: number[]; elementTags: number[][] };
  const counts: Record<string, number> = {};
  e.elementTypes.forEach((t, i) => (counts[String(t)] = e.elementTags[i].length));
  const n = gmsh.model.mesh.getNodes(-1, -1, false, false) as { coord: number[] };
  const ys: number[] = [];
  for (let i = 1; i < n.coord.length; i += 3) ys.push(n.coord[i]);
  const rows = [...new Set(ys.map((v) => Math.round(v * 1e4) / 1e4))].sort((a, b) => a - b);
  const low = rows.slice(0, 5), high = rows.slice(-5).reverse().map((v) => Math.round((4 - v) * 1e4) / 1e4);
  const growth = low.slice(1).map((v, i, a) => (i === 0 ? v - low[0] : v - a[i - 1]));
  return {
    counts,
    quads: counts["3"] ?? 0,
    triangles: counts["2"] ?? 0,
    nodesNearBottom: ys.filter((y) => y < 0.8).length,
    nodesNearTop: ys.filter((y) => y > 3.2).length,
    rowsFromBottom: low,
    rowsFromTop: high,
    rowSpacing: growth.map((g, i, a) => (i === 0 ? null : Math.round((g / a[i - 1]) * 1e3) / 1e3)).slice(1),
  };
}

async function main(): Promise<void> {
  const gmsh = await getGmsh(process.cwd());
  const out: Record<string, unknown> = {
    version: gmsh.option.getString("General.BuildInfo").value.match(/Packaged by: [^;]+/)?.[0],
  };
  const run = (name: string, fn: () => Record<string, unknown>): void => {
    try { out[name] = fn(); } catch (e) { out[name] = { error: String((e as Error)?.message ?? e).slice(0, 300) }; }
  };

  run("plain", () => { rectangle(gmsh); return measure(gmsh); });
  run("layerOnly", () => { const r = rectangle(gmsh); layer(gmsh, [r.bottom], r.bottomPts); return measure(gmsh); });
  run("backgroundOnly_topFine", () => { const r = rectangle(gmsh); background(gmsh, [r.top], 0.3, 2); return measure(gmsh); });
  run("layer+background_otherWall_bgFirst", () => { const r = rectangle(gmsh); background(gmsh, [r.top], 0.3, 2); layer(gmsh, [r.bottom], r.bottomPts); return measure(gmsh); });
  run("layer+background_otherWall_layerFirst", () => { const r = rectangle(gmsh); layer(gmsh, [r.bottom], r.bottomPts); background(gmsh, [r.top], 0.3, 2); return measure(gmsh); });
  run("layer+background_sameWall", () => { const r = rectangle(gmsh); layer(gmsh, [r.bottom], r.bottomPts); background(gmsh, [r.bottom], 0.3, 2); return measure(gmsh); });
  run("twoLayers_disjointFans", () => {
    const r = rectangle(gmsh);
    layer(gmsh, [r.bottom], r.bottomPts);
    layer(gmsh, [r.top], r.topPts);
    return measure(gmsh);
  });
  run("twoLayers_sharedFanPoint", () => {
    const r = rectangle(gmsh);
    layer(gmsh, [r.bottom], r.bottomPts);
    layer(gmsh, [r.top], [...r.topPts, r.bottomPts[0]]);
    return measure(gmsh);
  });
  run("fanElementsOption", () => { gmsh.option.setNumber("Mesh.BoundaryLayerFanElements", 7); return { roundTrip: gmsh.option.getNumber("Mesh.BoundaryLayerFanElements").value }; });

  console.error(JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
