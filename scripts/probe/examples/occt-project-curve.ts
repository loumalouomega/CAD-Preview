/** Roadmap 3.9 probe: BRepProj_Projection projects a wire onto a shape along a direction (_1) or from a point (_2).
 * Run: npm run probe -- scripts/probe/examples/occt-project-curve.ts --run   (JSON on stderr)
 * Cases: (a) line -> sphere r=10 along -z, (b) circle r=3 -> cylinder r=5 h=10 along the cylinder axis? (no hit; tried radially
 * from the axis point), (c) projected edges into BRepFeat_SplitShape.Add_3 on the sphere face. Analytic gates:
 * every sampled point within 1e-6 of the surface, split raises the face count by 1 with area/volume unchanged. */
import { getOcct } from "../../../src/occtService";
import { collectFaces } from "../../../src/occtOperations";
import { volumePropertiesAdaptive, surfacePropertiesAdaptive } from "../../../src/brepGProp";

console.log = console.error.bind(console);
type Oc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Del = { delete(): void };

function edgesOf(oc: Oc, shape: any, cleanup: Del[]): any[] {
  const ex = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); cleanup.push(ex);
  const out: any[] = [];
  for (; ex.More(); ex.Next()) { const e = oc.TopoDS.Edge_1(ex.Current()); cleanup.push(e); out.push(e); }
  return out;
}

function samplePoints(oc: Oc, edge: any, n: number, cleanup: Del[]): number[][] {
  const c = new oc.BRepAdaptor_Curve_2(edge); cleanup.push(c);
  const t0 = c.FirstParameter(), t1 = c.LastParameter();
  const pts: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const p = c.Value(t0 + ((t1 - t0) * i) / n); cleanup.push(p);
    pts.push([p.X(), p.Y(), p.Z()]);
  }
  return pts;
}

function props(oc: Oc, shape: any, cleanup: Del[]): { volume: number; area: number; faces: number } {
  const vp = new oc.GProp_GProps_1(); cleanup.push(vp);
  volumePropertiesAdaptive(oc, shape, vp);
  const sp = new oc.GProp_GProps_1(); cleanup.push(sp);
  surfacePropertiesAdaptive(oc, shape, sp);
  return { volume: vp.Mass(), area: sp.Mass(), faces: collectFaces(oc, shape, cleanup).length };
}

async function run(name: string, fn: (oc: Oc, cleanup: Del[]) => unknown): Promise<unknown> {
  const oc: Oc = await getOcct(process.cwd());
  const cleanup: Del[] = [];
  const t0 = Date.now();
  try { return { name, ms: undefined as unknown, result: fn(oc, cleanup), wall: Date.now() - t0 }; }
  catch (e) { return { name, error: String((e as Error)?.message ?? e).slice(0, 300) }; }
  finally { for (let i = cleanup.length - 1; i >= 0; i--) { try { cleanup[i].delete(); } catch { /* ignore */ } } }
}

function wireOfEdge(oc: Oc, edge: any, cleanup: Del[]): any {
  const mw = new oc.BRepBuilderAPI_MakeWire_1(); cleanup.push(mw);
  mw.Add_1(edge);
  const w = mw.Wire(); cleanup.push(w);
  return w;
}

async function main(): Promise<void> {
  const out: unknown[] = [];

  out.push(await run("line -> sphere r=10 along -z (Projection_1)", (oc, cleanup) => {
    const centre = new oc.gp_Pnt_3(0, 0, 0); cleanup.push(centre);
    const mkS = new oc.BRepPrimAPI_MakeSphere_5(centre, 10); cleanup.push(mkS);
    const sphere = mkS.Shape(); cleanup.push(sphere);
    const a = new oc.gp_Pnt_3(-4, 1, 20), b = new oc.gp_Pnt_3(4, 1, 20); cleanup.push(a, b);
    const mkE = new oc.BRepBuilderAPI_MakeEdge_3(a, b); cleanup.push(mkE);
    const wire = wireOfEdge(oc, mkE.Edge(), cleanup);
    const dir = new oc.gp_Dir_4(0, 0, -1); cleanup.push(dir);
    const proj = new oc.BRepProj_Projection_1(wire, sphere, dir); cleanup.push(proj);
    const done = proj.IsDone();
    const res = done ? proj.Shape() : null; if (res) cleanup.push(res);
    const edges = res ? edgesOf(oc, res, cleanup) : [];
    let maxDev = 0;
    const pts = edges.flatMap((e) => samplePoints(oc, e, 20, cleanup));
    for (const [x, y, z] of pts) maxDev = Math.max(maxDev, Math.abs(Math.hypot(x, y, z) - 10));
    return { done, shapeType: res ? res.ShapeType().value : null, edges: edges.length, samples: pts.length, maxRadialDeviation: maxDev };
  }));

  out.push(await run("circle r=3 -> cylinder r=5 h=10, radial from axis point (Projection_2)", (oc, cleanup) => {
    const ax = new oc.gp_Ax2_3(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(0, 0, 1)); cleanup.push(ax);
    const mkC = new oc.BRepPrimAPI_MakeCylinder_3(ax, 5, 10); cleanup.push(mkC);
    const cyl = mkC.Shape(); cleanup.push(cyl);
    const cax = new oc.gp_Ax2_3(new oc.gp_Pnt_3(0, 0, 5), new oc.gp_Dir_4(0, 0, 1)); cleanup.push(cax);
    const circ = new oc.gp_Circ_2(cax, 3); cleanup.push(circ);
    const mkE = new oc.BRepBuilderAPI_MakeEdge_8(circ); cleanup.push(mkE);
    const wire = wireOfEdge(oc, mkE.Edge(), cleanup);
    const eye = new oc.gp_Pnt_3(0, 0, 5); cleanup.push(eye);
    const proj = new oc.BRepProj_Projection_2(wire, cyl, eye); cleanup.push(proj);
    const done = proj.IsDone();
    const res = done ? proj.Shape() : null; if (res) cleanup.push(res);
    const edges = res ? edgesOf(oc, res, cleanup) : [];
    let maxDev = 0;
    const pts = edges.flatMap((e) => samplePoints(oc, e, 20, cleanup));
    for (const [x, y] of pts) maxDev = Math.max(maxDev, Math.abs(Math.hypot(x, y) - 5));
    return { done, edges: edges.length, samples: pts.length, maxRadialDeviation: maxDev };
  }));

  out.push(await run("circle r=3 -> cylinder, parallel along +x dir (Projection_1)", (oc, cleanup) => {
    const ax = new oc.gp_Ax2_3(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(0, 0, 1)); cleanup.push(ax);
    const mkC = new oc.BRepPrimAPI_MakeCylinder_3(ax, 5, 10); cleanup.push(mkC);
    const cyl = mkC.Shape(); cleanup.push(cyl);
    // circle in the x=-20 plane (normal x), radius 3 centred at y=0,z=5: projects along +x onto the cylinder wall (two sheets: near and far)
    const cax = new oc.gp_Ax2_3(new oc.gp_Pnt_3(-20, 0, 5), new oc.gp_Dir_4(1, 0, 0)); cleanup.push(cax);
    const circ = new oc.gp_Circ_2(cax, 3); cleanup.push(circ);
    const mkE = new oc.BRepBuilderAPI_MakeEdge_8(circ); cleanup.push(mkE);
    const wire = wireOfEdge(oc, mkE.Edge(), cleanup);
    const dir = new oc.gp_Dir_4(1, 0, 0); cleanup.push(dir);
    const proj = new oc.BRepProj_Projection_1(wire, cyl, dir); cleanup.push(proj);
    const done = proj.IsDone();
    const res = done ? proj.Shape() : null; if (res) cleanup.push(res);
    const edges = res ? edgesOf(oc, res, cleanup) : [];
    let maxDev = 0;
    const pts = edges.flatMap((e) => samplePoints(oc, e, 20, cleanup));
    for (const [x, y] of pts) maxDev = Math.max(maxDev, Math.abs(Math.hypot(x, y) - 5));
    // iterate the lazy list too
    let current = 0; for (proj.Init(); proj.More(); proj.Next()) { const s = proj.Current(); cleanup.push(s); current++; }
    return { done, edges: edges.length, currentWires: current, samples: pts.length, maxRadialDeviation: maxDev };
  }));

  out.push(await run("split: line projected on a box top face (planar) fed to BRepFeat_SplitShape.Add_3", (oc, cleanup) => {
    const mkB = new oc.BRepPrimAPI_MakeBox_3(new oc.gp_Pnt_3(-5, -5, -5), new oc.gp_Pnt_3(5, 5, 5)); cleanup.push(mkB);
    const box = mkB.Shape(); cleanup.push(box);
    const faces = collectFaces(oc, box, cleanup);
    let top: any = null;
    for (const f of faces) {
      const bb = new oc.Bnd_Box_1(); cleanup.push(bb);
      oc.BRepBndLib.Add(f, bb, false);
      if (Math.abs(bb.CornerMin().Z() - 5) < 1e-4 && Math.abs(bb.CornerMax().Z() - 5) < 1e-4) { top = f; break; }
    }
    const before = props(oc, box, cleanup);
    const a = new oc.gp_Pnt_3(-20, 1, 30), b = new oc.gp_Pnt_3(20, 1, 30); cleanup.push(a, b);
    const mkE = new oc.BRepBuilderAPI_MakeEdge_3(a, b); cleanup.push(mkE);
    const wire = wireOfEdge(oc, mkE.Edge(), cleanup);
    const dir = new oc.gp_Dir_4(0, 0, -1); cleanup.push(dir);
    const proj = new oc.BRepProj_Projection_1(wire, top, dir); cleanup.push(proj);
    const done = proj.IsDone();
    const res = proj.Shape(); cleanup.push(res);
    const projEdges = edgesOf(oc, res, cleanup);
    // The projected edge reaches beyond the face (x +/-20 vs +/-5) — record whether it is trimmed to the face.
    const pts = projEdges.flatMap((e) => samplePoints(oc, e, 4, cleanup));
    const split = new oc.BRepFeat_SplitShape_2(box); cleanup.push(split);
    split.Add_3(projEdges[0], top);
    split.Build();
    const splitDone = split.IsDone();
    const r = splitDone ? split.Shape() : null; if (r) cleanup.push(r);
    return { done, projEdges: projEdges.length, pts, before, splitDone, after: r ? props(oc, r, cleanup) : null };
  }));

  console.error(JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
