/** Roadmap 3.5 "N-sided surface filling" probe (BRepOffsetAPI_MakeFilling).
 * Run: npm run probe -- scripts/probe/examples/occt-filling.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that the gate passed.
 */
import { getOcct } from "../../../src/occtService";
import { surfacePropertiesAdaptive } from "../../../src/brepGProp";

console.log = console.error.bind(console);
type Oc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Del = { delete(): void };
const out = (o: unknown) => console.error(JSON.stringify(o));
const protoNames = (oc: Oc, cls: string) => (oc[cls] ? Object.getOwnPropertyNames(oc[cls].prototype).filter((n) => n !== "constructor") : null);
function tryCall<T>(label: string, fn: () => T): T | undefined {
  try { return fn(); } catch (e) {
    out({ label, error: typeof e === "number" ? `raw:${e}` : String((e as Error)?.message ?? e).slice(0, 300) });
    return undefined;
  }
}
function dispose(c: Del[]) { for (let i = c.length - 1; i >= 0; i--) { try { c[i].delete(); } catch { /* ignore */ } } }
function sub(oc: Oc, shape: any, kind: string, c: Del[]): any[] {
  const res: any[] = [];
  const ex = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum[kind], oc.TopAbs_ShapeEnum.TopAbs_SHAPE); c.push(ex);
  for (; ex.More(); ex.Next()) { const s = ex.Current(); c.push(s); res.push(s); }
  return res;
}
const R = 5, H = 10;

async function main() {
  const oc: Oc = await getOcct(process.cwd());
  out({ step: "prototypes", ctors: Object.keys(oc).filter((k) => k.startsWith("BRepOffsetAPI_MakeFilling")),
    filling: protoNames(oc, "BRepOffsetAPI_MakeFilling"),
    edgeCtors: Object.keys(oc).filter((k) => /^BRepBuilderAPI_MakeEdge_(8|9|10|11)$/.test(k)) });
  const c: Del[] = [];
  try {
    const P = (x: number, y: number, z: number) => { const p = new oc.gp_Pnt_3(x, y, z); c.push(p); return p; };
    const line = (a: any, b: any) => { const m = new oc.BRepBuilderAPI_MakeEdge_3(a, b); c.push(m); const e = m.Edge(); c.push(e); return e; };
    // Quarter-cylinder patch: arcs at z=0 and z=H (angle 0..90 deg) + two straight rulings.
    const arc = (z: number) => {
      const ax = new oc.gp_Ax2_3(P(0, 0, z), new oc.gp_Dir_4(0, 0, 1)); c.push(ax);
      const circ = new oc.gp_Circ_2(ax, R); c.push(circ);
      const m = new oc.BRepBuilderAPI_MakeEdge_9(circ, 0, Math.PI / 2); c.push(m);
      const e = m.Edge(); c.push(e); return e;
    };
    const e0 = arc(0), e1 = arc(H);
    const r0 = line(P(R, 0, 0), P(R, 0, H)), r1 = line(P(0, R, 0), P(0, R, H));

    const fill = (label: string, edges: any[]) => tryCall(label, () => {
      const mf = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9); c.push(mf);
      for (const e of edges) mf.Add_1(e, oc.GeomAbs_Shape.GeomAbs_C0, true);
      const t0 = Date.now();
      mf.Build();
      const done = mf.IsDone();
      if (!done) return { done };
      const shape = mf.Shape(); c.push(shape);
      const a = new oc.GProp_GProps_1(); c.push(a); surfacePropertiesAdaptive(oc, shape, a);
      return { done, ms: Date.now() - t0, type: shape.ShapeType?.(), area: a.Mass(), shape };
    });

    const f4 = fill("fill4", [e0, r0, e1, r1]) as any;
    if (f4?.done) {
      const faces = sub(oc, f4.shape, "TopAbs_FACE", c);
      out({ step: "fill4", area: f4.area, expectedCylArea: (Math.PI / 2) * R * H, faces: faces.length, ms: f4.ms });
      // sample: bounding box/tessellate and measure radial deviation
      const msh = new oc.BRepMesh_IncrementalMesh_2(f4.shape, 0.05, false, 0.1, true); c.push(msh);
      let maxDev = 0, n = 0;
      for (const f of faces) {
        const loc = new oc.TopLoc_Location_1(); c.push(loc);
        const tri = oc.BRep_Tool.Triangulation(oc.TopoDS.Face_1(f), loc); c.push(tri);
        if (tri.IsNull()) continue;
        const t = tri.get();
        for (let i = 1; i <= t.NbNodes(); i++) { const p = t.Node(i); const d = Math.abs(Math.hypot(p.X(), p.Y()) - R); maxDev = Math.max(maxDev, d); n++; p.delete(); }
      }
      out({ step: "fill4-dev", samples: n, maxRadialDeviation: maxDev, relToR: maxDev / R });
    }

    // Non-planar triangle: three straight edges whose corners do not share a plane with a bulge? (3 points are always planar) -> use a bent triangle with curved edge.
    const a = P(0, 0, 0), b = P(10, 0, 0), cc = P(5, 8, 3), mid = P(5, -2, 3);
    const t0 = line(a, b), t1 = line(b, cc), t2 = line(cc, a);
    out({ step: "fill3", res: (() => { const r = fill("fill3", [t0, t1, t2]) as any; return r ? { done: r.done, area: r.area } : null; })() });
    // Sewing: fill4 + the cylinder-side neighbours aren't built here; check shell closure with a mirrored second patch.
    if (f4?.done) {
      const sew = new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false); c.push(sew);
      sew.Add(f4.shape);
      const pi = new oc.Handle_Message_ProgressIndicator_1(); c.push(pi);
      sew.Perform(pi);
      out({ step: "sew-single", freeEdges: sew.NbFreeEdges() });
    }
    mid.delete?.();

    // Closure: open box (top removed) + filled lid from its rim edges -> sew -> solid.
    const bx = new oc.BRepPrimAPI_MakeBox_3(P(0, 0, 0), P(10, 10, 10)); c.push(bx);
    const box = bx.Shape(); c.push(box);
    const faces = sub(oc, box, "TopAbs_FACE", c);
    const topIdx = faces.findIndex((f) => { const p = new oc.GProp_GProps_1(); c.push(p); surfacePropertiesAdaptive(oc, f, p); const cm = p.CentreOfMass(); c.push(cm); return Math.abs(cm.Z() - 10) < 1e-6; });
    const rim = sub(oc, faces[topIdx], "TopAbs_EDGE", c);
    const lid = fill("lid", rim.map((e) => oc.TopoDS.Edge_1(e))) as any;
    const sew = new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false); c.push(sew);
    faces.forEach((f, i) => { if (i !== topIdx) sew.Add(f); });
    if (lid?.done) sew.Add(lid.shape);
    const pi = new oc.Handle_Message_ProgressIndicator_1(); c.push(pi);
    sew.Perform(pi);
    const sewn = sew.SewedShape(); c.push(sewn);
    const shells = sub(oc, sewn, "TopAbs_SHELL", c);
    out({ step: "lid-sew", lidArea: lid?.area, freeEdges: sew.NbFreeEdges(), shells: shells.length, shapeType: sewn.ShapeType() });
    if (shells.length) {
      const ms = new oc.BRepBuilderAPI_MakeSolid_3(oc.TopoDS.Shell_1(shells[0])); c.push(ms);
      const sol = ms.Solid(); c.push(sol);
      const vp = new oc.GProp_GProps_1(); c.push(vp);
      oc.BRepGProp.VolumeProperties_1?.(sol, vp, false, false, false);
      out({ step: "lid-solid", volume: vp.Mass(), expected: 1000 });
    }
  } finally { dispose(c); }
}
main().catch((e) => { out({ fatal: String(e?.message ?? e) }); process.exit(1); });
