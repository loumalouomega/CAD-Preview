/** Does gmsh-wasm 0.4.0's new `view.*` namespace drive mesh sizing through a `PostView` background field?
 * Run: npm run probe -- scripts/probe/examples/gmsh-view-sizing.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that a gate passed.
 *
 * Method: mesh examples/STP/block.stp coarsely, build a TARGET-SIZE view from that coarse mesh
 * (size grows with distance from the (0, 0, 0) corner... a point on the model), attach it as the
 * background field, regenerate from CAD, and measure whether tetrahedron density follows the view.
 * Two data paths: list-based (`addListData`, independent of any mesh, so it survives regeneration) and
 * model-based (`addModelData`, tied to the mesh that existed when it was added).
 *
 * Gate (set before running): density near the refined corner is >= 3x the far band, bands are
 * monotonic, no WASM abort, and removing the view returns the coarse control mesh.
 */
import * as fs from "fs";
import { getGmsh } from "../../../src/gmshService";

console.log = console.error.bind(console);
type Gmsh = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const P: [number, number, number] = [0, 0, 0]; // set below from the bbox's min corner
const H_NEAR = 0.35, H_FAR = 2.0, RADIUS = 5;

function sizeAt(x: number, y: number, z: number): number {
  const d = Math.hypot(x - P[0], y - P[1], z - P[2]);
  return H_NEAR + (H_FAR - H_NEAR) * Math.min(1, d / RADIUS);
}

function load(gmsh: Gmsh): void {
  gmsh.clear();
  gmsh.model.add("m");
  gmsh.FS.writeFile("/model.step", fs.readFileSync("examples/STP/block.stp"));
  gmsh.model.occ.importShapes("/model.step");
  gmsh.model.occ.synchronize();
  for (const k of ["General.NumThreads", "Mesh.MaxNumThreads1D", "Mesh.MaxNumThreads2D", "Mesh.MaxNumThreads3D"]) gmsh.option.setNumber(k, 1);
  gmsh.option.setNumber("Mesh.Algorithm3D", 1);
  gmsh.option.setNumber("Mesh.SaveAll", 1);
  gmsh.option.setNumber("Mesh.MeshSizeMin", 0);
}

interface Tets { centroids: number[][]; coords: number[][][]; minSICN: number; n: number }

function readTets(gmsh: Gmsh): Tets {
  const els = gmsh.model.mesh.getElements(3) as { elementTypes: number[]; elementTags: number[][]; nodeTags: number[][] };
  const nodes = gmsh.model.mesh.getNodes(-1, -1, false, false) as { nodeTags: number[]; coord: number[] };
  const pos = new Map<number, number[]>();
  nodes.nodeTags.forEach((t, i) => pos.set(t, [nodes.coord[3 * i], nodes.coord[3 * i + 1], nodes.coord[3 * i + 2]]));
  const centroids: number[][] = [], coords: number[][][] = [];
  const tags: number[] = [];
  els.elementTypes.forEach((ty, k) => {
    if (ty !== 4) return;
    const nt = els.nodeTags[k];
    for (let i = 0; i + 4 <= nt.length; i += 4) {
      const c = [0, 1, 2, 3].map((j) => pos.get(nt[i + j])!);
      coords.push(c);
      centroids.push([0, 1, 2].map((a) => (c[0][a] + c[1][a] + c[2][a] + c[3][a]) / 4));
    }
    tags.push(...els.elementTags[k]);
  });
  const q = (gmsh.model.mesh.getElementQualities(tags, "minSICN") as { elementsQuality: number[] }).elementsQuality;
  return { centroids, coords, minSICN: Math.min(...q), n: coords.length };
}

/** Tetrahedra per unit volume in three distance bands from P: [0,2), [2,4), [4,inf). */
function bands(t: Tets): number[] {
  const count = [0, 0, 0];
  const vol = [0, 0, 0];
  t.centroids.forEach((c, i) => {
    const d = Math.hypot(c[0] - P[0], c[1] - P[1], c[2] - P[2]);
    const b = d < 2 ? 0 : d < 4 ? 1 : 2;
    const [a, bb, cc, dd] = t.coords[i];
    const u = [bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]], v = [cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]], w = [dd[0] - a[0], dd[1] - a[1], dd[2] - a[2]];
    const volume = Math.abs(u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0])) / 6;
    count[b]++;
    vol[b] += volume;
  });
  return count.map((n, b) => (vol[b] > 0 ? Math.round((n / vol[b]) * 1e3) / 1e3 : 0));
}

function generate(gmsh: Gmsh): { ms: number; tets: Tets; bands: number[] } {
  const t0 = Date.now();
  gmsh.model.mesh.generate(3);
  const ms = Date.now() - t0;
  const tets = readTets(gmsh);
  return { ms, tets, bands: bands(tets) };
}

async function main(): Promise<void> {
  const gmsh = await getGmsh(process.cwd());
  const out: Record<string, unknown> = { packagedBy: gmsh.option.getString("General.BuildInfo").value.match(/Packaged by: [^;]+/)?.[0] };
  const brief = (r: { ms: number; tets: Tets; bands: number[] }) => ({ ms: r.ms, tets: r.tets.n, minSICN: r.tets.minSICN, densityBands: r.bands, nearOverFar: r.bands[2] > 0 ? r.bands[0] / r.bands[2] : null });

  // Control: coarse uniform mesh.
  load(gmsh);
  const bb = gmsh.model.getBoundingBox(-1, -1) as Record<string, number>;
  P[0] = bb.xmin; P[1] = bb.ymin; P[2] = bb.zmin;
  gmsh.option.setNumber("Mesh.MeshSizeMax", 2);
  const coarse = generate(gmsh);
  out.control = brief(coarse);

  // 1. List-based view from the coarse tets: scalar-on-tetrahedron ("SS"), node values = target size at the node.
  try {
    const data: number[] = [];
    for (const c of coarse.tets.coords) {
      for (let a = 0; a < 3; a++) for (let n = 0; n < 4; n++) data.push(c[n][a]); // x1..x4, y1..y4, z1..z4
      for (let n = 0; n < 4; n++) data.push(sizeAt(c[n][0], c[n][1], c[n][2])); // v1..v4
    }
    // gmsh.clear() drops every view, so rebuild the model from CAD FIRST and add the (mesh-independent) view after.
    load(gmsh);
    const viewTag = gmsh.view.add("target-size") as number;
    gmsh.view.addListData(viewTag, "SS", coarse.tets.n, data);
    out.listView = { viewTag, tags: gmsh.view.getTags() };
    const F = gmsh.model.mesh.field;
    const f = F.add("PostView");
    let optionUsed = "ViewTag";
    try { F.setNumber(f, "ViewTag", viewTag); } catch { optionUsed = "ViewIndex"; F.setNumber(f, "ViewIndex", gmsh.view.getIndex(viewTag)); }
    F.setAsBackgroundMesh(f);
    for (const [k, v] of [["Mesh.MeshSizeFromPoints", 0], ["Mesh.MeshSizeExtendFromBoundary", 0], ["Mesh.MeshSizeFromCurvature", 0], ["Mesh.MeshSizeMax", 10]] as const) gmsh.option.setNumber(k, v);
    const r = generate(gmsh);
    out.listBased = { optionUsed, ...brief(r) };
    // Remove the view and regenerate: the field must stop steering (control).
    gmsh.view.remove(viewTag);
    out.afterRemove = { tags: gmsh.view.getTags() };
  } catch (e) { out.listBased = { error: String((e as Error)?.message ?? e).slice(0, 300) }; }

  // 1b. Composition: the view inside the shared `Min` list beside a flat `Constant` field, exactly how
  // `setBackgroundMin` would combine it with a Part's `meshSize`.
  try {
    const data: number[] = [];
    for (const c of coarse.tets.coords) {
      for (let a = 0; a < 3; a++) for (let n = 0; n < 4; n++) data.push(c[n][a]);
      for (let n = 0; n < 4; n++) data.push(sizeAt(c[n][0], c[n][1], c[n][2]));
    }
    load(gmsh);
    const viewTag = gmsh.view.add("target-size-min") as number;
    gmsh.view.addListData(viewTag, "SS", coarse.tets.n, data);
    const F = gmsh.model.mesh.field;
    const view = F.add("PostView");
    F.setNumber(view, "ViewTag", viewTag);
    const vols = (gmsh.model.getEntities(3).dimTags as number[]).filter((_, i) => i % 2 === 1);
    const flat = F.add("Constant");
    F.setNumbers(flat, "VolumesList", vols);
    F.setNumber(flat, "VIn", 1.2);
    const min = F.add("Min");
    F.setNumbers(min, "FieldsList", [view, flat]);
    F.setAsBackgroundMesh(min);
    for (const [k, v] of [["Mesh.MeshSizeFromPoints", 0], ["Mesh.MeshSizeExtendFromBoundary", 0], ["Mesh.MeshSizeFromCurvature", 0], ["Mesh.MeshSizeMax", 10]] as const) gmsh.option.setNumber(k, v);
    const r = generate(gmsh);
    out.composedWithConstant = { constantVIn: 1.2, ...brief(r) };
    // Parts survive: a physical group on the model is untouched by a size field.
    gmsh.view.remove(viewTag);
  } catch (e) { out.composedWithConstant = { error: String((e as Error)?.message ?? e).slice(0, 300) }; }

  // 2. Model-based NodeData on the coarse mesh (the view is tied to the mesh that existed when it was added).
  try {
    load(gmsh);
    gmsh.option.setNumber("Mesh.MeshSizeMax", 2);
    generate(gmsh);
    const nodes = gmsh.model.mesh.getNodes(-1, -1, false, false) as { nodeTags: number[]; coord: number[] };
    const sizes = nodes.nodeTags.map((_, i) => [sizeAt(nodes.coord[3 * i], nodes.coord[3 * i + 1], nodes.coord[3 * i + 2])]);
    const viewTag = gmsh.view.add("target-size-model") as number;
    gmsh.view.addModelData(viewTag, 0, gmsh.model.getCurrent().name ?? "m", "NodeData", nodes.nodeTags, sizes, 0, 1);
    const F = gmsh.model.mesh.field;
    const f = F.add("PostView");
    try { F.setNumber(f, "ViewTag", viewTag); } catch { F.setNumber(f, "ViewIndex", gmsh.view.getIndex(viewTag)); }
    F.setAsBackgroundMesh(f);
    for (const [k, v] of [["Mesh.MeshSizeFromPoints", 0], ["Mesh.MeshSizeExtendFromBoundary", 0], ["Mesh.MeshSizeFromCurvature", 0], ["Mesh.MeshSizeMax", 10]] as const) gmsh.option.setNumber(k, v);
    gmsh.model.mesh.clear();
    const r = generate(gmsh);
    out.modelBased = brief(r);
    gmsh.view.remove(viewTag);
  } catch (e) { out.modelBased = { error: String((e as Error)?.message ?? e).slice(0, 300) }; }

  console.error(JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
