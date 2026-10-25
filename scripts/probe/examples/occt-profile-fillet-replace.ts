/** Probe for the `filletProfile` op: replace two adjacent edges of a wire inside a compound.
 * Run: npm run probe -- scripts/probe/examples/occt-profile-fillet-replace.ts --run
 * JSON facts on stderr. Exit 0 means the probe completed, not that the gate passed.
 */
import { getOcct } from "../../../src/occtService";
import { surfacePropertiesAdaptive } from "../../../src/brepGProp";

console.log = console.error.bind(console);
type Oc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Del = { delete(): void };
const out = (o: unknown) => console.error(JSON.stringify(o));
const tryCall = <T,>(label: string, fn: () => T): T | undefined => {
  try { return fn(); } catch (e) { out({ label, error: typeof e === "number" ? `raw:${e}` : String((e as Error)?.message ?? e).slice(0, 300) }); return undefined; }
};
const dispose = (c: Del[]) => { for (let i = c.length - 1; i >= 0; i--) { try { c[i].delete(); } catch { /* ignore */ } } };
const names = (oc: Oc, cls: string) => (oc[cls] ? Object.getOwnPropertyNames(oc[cls].prototype).filter((n) => n !== "constructor") : null);

async function main() {
  const oc: Oc = await getOcct(process.cwd());
  out({ plnCtors: Object.keys(oc).filter((k) => /^gp_Pln_\d/.test(k)), iter: Object.keys(oc).filter((k) => k.startsWith("TopoDS_Iterator")), iterProto: names(oc, "TopoDS_Iterator") });
  const c: Del[] = [];
  try {
    // 10 x 6 rectangle tilted into the plane with normal (0,1,1)/sqrt2, as a closed wire inside a compound.
    const s = Math.SQRT1_2;
    const to3 = ([x, y]: number[]): number[] => [x, y * s, y * s];
    const pts = [[0, 0], [10, 0], [10, 6], [0, 6]].map(to3).map(([x, y, z]) => { const p = new oc.gp_Pnt_3(x, y, z); c.push(p); return p; });
    const mw = new oc.BRepBuilderAPI_MakeWire_1(); c.push(mw);
    for (let i = 0; i < 4; i++) { const e = new oc.BRepBuilderAPI_MakeEdge_3(pts[i], pts[(i + 1) % 4]); c.push(e); const ed = e.Edge(); c.push(ed); mw.Add_1(ed); }
    const wire = mw.Wire(); c.push(wire);
    const comp = new oc.TopoDS_Compound(); c.push(comp);
    const bld = new oc.BRep_Builder(); c.push(bld);
    bld.MakeCompound(comp); bld.Add(comp, wire);

    // top-level children via TopoDS_Iterator
    const kids = tryCall("iterator", () => {
      const it = new oc.TopoDS_Iterator_2(comp, true, true); c.push(it);
      const res: string[] = [];
      for (; it.More(); it.Next()) { const v = it.Value(); c.push(v); res.push(String(v.ShapeType())); }
      return res;
    });
    out({ step: "iterator", kids });

    // plane through the corner
    const normal = new oc.gp_Dir_4(0, s, -s); c.push(normal); // perpendicular to the tilted plane
    const pln = tryCall("pln_3", () => { const p = new oc.gp_Pln_3(pts[0], normal); c.push(p); return p; });
    out({ step: "pln", ok: !!pln });

    const edges: any[] = [];
    const ex = new oc.TopExp_Explorer_2(wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); c.push(ex);
    for (; ex.More(); ex.Next()) edges.push(oc.TopoDS.Edge_1(ex.Current()));
    const corner = pts[1];
    const api = new oc.ChFi2d_FilletAPI_3(edges[0], edges[1], pln); c.push(api);
    const ok = api.Perform(1);
    const e1 = new oc.TopoDS_Edge(); c.push(e1); const e2 = new oc.TopoDS_Edge(); c.push(e2);
    const arc = api.Result(corner, e1, e2, -1); c.push(arc);
    out({ step: "fillet-tilted", ok });

    const mw2 = new oc.BRepBuilderAPI_MakeWire_1(); c.push(mw2);
    for (const e of [e1, arc, e2, edges[2], edges[3]]) mw2.Add_1(e);
    const w2 = mw2.Wire(); c.push(w2);
    const f = new oc.BRepBuilderAPI_MakeFace_15(w2, true); c.push(f);
    const face = f.Face(); c.push(face);
    const gp = new oc.GProp_GProps_1(); c.push(gp); surfacePropertiesAdaptive(oc, face, gp);
    out({ step: "tilted-area", done: mw2.IsDone(), area: gp.Mass(), expected: 60 - (1 - Math.PI / 4) });
  } finally { dispose(c); }
}
main().catch((e) => { out({ fatal: typeof e === "number" ? `raw:${e}` : String(e?.stack ?? e) }); process.exit(1); });
