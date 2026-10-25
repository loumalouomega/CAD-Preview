/** Roadmap 3.7 "Fillets and chamfers on 2D profiles" probe.
 * Run: npm run probe -- scripts/probe/examples/occt-profile-fillet.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that the gate passed.
 */
import { getOcct } from "../../../src/occtService";
import { surfacePropertiesAdaptive, volumePropertiesAdaptive } from "../../../src/brepGProp";

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
function area(oc: Oc, shape: any, c: Del[]) {
  const p = new oc.GProp_GProps_1(); c.push(p); surfacePropertiesAdaptive(oc, shape, p); return p.Mass();
}
/** 10 x 6 rectangle in z=0 as a planar face. */
function rectFace(oc: Oc, c: Del[]) {
  const pts = [[0, 0], [10, 0], [10, 6], [0, 6]].map(([x, y]) => { const p = new oc.gp_Pnt_3(x, y, 0); c.push(p); return p; });
  const mw = new oc.BRepBuilderAPI_MakeWire_1(); c.push(mw);
  for (let i = 0; i < 4; i++) {
    const e = new oc.BRepBuilderAPI_MakeEdge_3(pts[i], pts[(i + 1) % 4]); c.push(e);
    mw.Add_1(e.Edge());
  }
  const w = mw.Wire(); c.push(w);
  const f = new oc.BRepBuilderAPI_MakeFace_15(w, true); c.push(f);
  const face = f.Face(); c.push(face);
  return face;
}

async function main() {
  const oc: Oc = await getOcct(process.cwd());
  out({ step: "prototypes", ctors: Object.keys(oc).filter((k) => /^ChFi2d_(Fillet|Chamfer)API/.test(k)),
    fillet: protoNames(oc, "ChFi2d_FilletAPI"), chamfer: protoNames(oc, "ChFi2d_ChamferAPI"),
    fillet2d: protoNames(oc, "ChFi2d_Builder"), ctorsBuilder: Object.keys(oc).filter((k) => k.startsWith("ChFi2d_Builder")) });

  const c: Del[] = [];
  try {
    const face = rectFace(oc, c);
    const a0 = area(oc, face, c);
    out({ step: "rect", area: a0, expected: 60 });
    const edges = sub(oc, face, "TopAbs_EDGE", c);
    out({ step: "edges", n: edges.length });

    const Ed = (i: number) => oc.TopoDS.Edge_1(edges[i]);
    /** Rebuild a wire from edges and report its area as a face, closure and prism volume. */
    const rebuild = (label: string, es: any[]) => tryCall(label, () => {
      const mw = new oc.BRepBuilderAPI_MakeWire_1(); c.push(mw);
      es.forEach((e) => mw.Add_1(e));
      const closedOk = mw.IsDone();
      const w = mw.Wire(); c.push(w);
      const an = new oc.BRepCheck_Analyzer(w, true); c.push(an);
      const mf = new oc.BRepBuilderAPI_MakeFace_15(w, true); c.push(mf);
      const f = mf.Face(); c.push(f);
      const v = new oc.gp_Vec_4(0, 0, 5); c.push(v);
      const pr = new oc.BRepPrimAPI_MakePrism_1(f, v, false, true); c.push(pr);
      const sol = pr.Shape(); c.push(sol);
      const vp = new oc.GProp_GProps_1(); c.push(vp); volumePropertiesAdaptive(oc, sol, vp);
      const a = area(oc, f, c);
      return { wireDone: closedOk, wireValid: an.IsValid_2(), edges: es.length, area: a, dropFromRect: 60 - a, prismVolume: vp.Mass(), prismVolOverArea: vp.Mass() / a };
    });
    const pln = new oc.gp_Pln_1(); c.push(pln);
    const corner = new oc.gp_Pnt_3(10, 0, 0); c.push(corner);

    // ---- fillet at (10,0): bottom edge[0] and right edge[1] ----
    const fil = tryCall("fillet", () => {
      const api = new oc.ChFi2d_FilletAPI_3(Ed(0), Ed(1), pln); c.push(api);
      const ok = api.Perform(1);
      const e1 = new oc.TopoDS_Edge(); c.push(e1);
      const e2 = new oc.TopoDS_Edge(); c.push(e2);
      const arc = api.Result(corner, e1, e2, -1); c.push(arc);
      return { ok, nb: api.NbResults(corner), arc, e1, e2 };
    });
    out({ step: "fillet-api", ok: fil?.ok, nb: fil?.nb });
    if (fil) {
      const r = rebuild("fillet-wire", [fil.e1, fil.arc, fil.e2, Ed(2), Ed(3)]);
      out({ step: "fillet-result", r, expectedDrop: 1 - Math.PI / 4 });
    }

    // ---- chamfer at (10,0) ----
    const cham = tryCall("chamfer", () => {
      const api = new oc.ChFi2d_ChamferAPI_3(Ed(0), Ed(1)); c.push(api);
      const ok = api.Perform();
      const e1 = new oc.TopoDS_Edge(); c.push(e1);
      const e2 = new oc.TopoDS_Edge(); c.push(e2);
      const ch = api.Result(e1, e2, 1, 1); c.push(ch);
      return { ok, ch, e1, e2 };
    });
    out({ step: "chamfer-api", ok: cham?.ok });
    if (cham) out({ step: "chamfer-result", r: rebuild("chamfer-wire", [cham.e1, cham.ch, cham.e2, Ed(2), Ed(3)]), expectedDrop: 0.5 });
    // asymmetric chamfer, and reversed edge order, and a second corner on the filleted result
    const cham2 = tryCall("chamfer-asym", () => {
      const api = new oc.ChFi2d_ChamferAPI_3(Ed(1), Ed(0)); c.push(api);
      const ok = api.Perform();
      const e1 = new oc.TopoDS_Edge(); c.push(e1);
      const e2 = new oc.TopoDS_Edge(); c.push(e2);
      const ch = api.Result(e1, e2, 2, 1); c.push(ch);
      return { ok, ch, e1, e2 };
    });
    if (cham2) out({ step: "chamfer-asym-reversed(d1=2 on edge[1])", r: rebuild("chamfer2-wire", [cham2.e2, cham2.ch, cham2.e1, Ed(2), Ed(3)]), expectedDrop: 1 });
    // oversize radius: should not abort
    const big = tryCall("fillet-big", () => {
      const api = new oc.ChFi2d_FilletAPI_3(Ed(0), Ed(1), pln); c.push(api);
      const ok = api.Perform(50);
      return { ok, nb: api.NbResults(corner) };
    });
    out({ step: "fillet-oversize", big });
    // whole-wire API: _2(wire, plane)
    const ww = tryCall("fillet-wire-api", () => {
      const mw = new oc.BRepBuilderAPI_MakeWire_1(); c.push(mw);
      for (let i = 0; i < 4; i++) mw.Add_1(Ed(i));
      const w = mw.Wire(); c.push(w);
      const api = new oc.ChFi2d_FilletAPI_2(w, pln); c.push(api);
      return { proto: protoNames(oc, "ChFi2d_FilletAPI") };
    });
    out({ step: "wire-ctor", ww });
  } finally { dispose(c); }
  void volumePropertiesAdaptive;
}
main().catch((e) => { out({ fatal: typeof e === "number" ? `raw:${e}` : String(e?.stack ?? e) }); process.exit(1); });
