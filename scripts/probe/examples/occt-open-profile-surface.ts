/** Roadmap 3.4 "Open-profile surface output" probe.
 * Run: npm run probe -- scripts/probe/examples/occt-open-profile-surface.ts --run
 * Prisms/revolves an OPEN wire, checks analytic area, free edges, face-id lockstep
 * (tessellateByGroup vs collectFaces) and a STEP round trip. JSON on stderr.
 */
import * as fs from "fs";
import { getOcct, readShape, writeShape } from "../../../src/occtService";
import { collectFaces } from "../../../src/occtOperations";
import { tessellateByGroup } from "../../../src/meshExtract";
import { surfacePropertiesAdaptive } from "../../../src/brepGProp";

console.log = console.error.bind(console);
type Oc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Del = { delete(): void };
const out = (o: unknown) => console.error(JSON.stringify(o));
function dispose(c: Del[]) { for (let i = c.length - 1; i >= 0; i--) { try { c[i].delete(); } catch { /* ignore */ } } }
function tryCall<T>(label: string, fn: () => T): T | undefined {
  try { return fn(); } catch (e) { out({ label, error: typeof e === "number" ? `raw:${e}` : String((e as Error)?.message ?? e).slice(0, 300) }); return undefined; }
}
const type = (oc: Oc, s: any) => { const t = s.ShapeType(); for (const k of Object.keys(oc.TopAbs_ShapeEnum)) if (oc.TopAbs_ShapeEnum[k] === t) return k; return String(t); };
function area(oc: Oc, shape: any, c: Del[]) { const p = new oc.GProp_GProps_1(); c.push(p); surfacePropertiesAdaptive(oc, shape, p); return p.Mass(); }
function openWire(oc: Oc, pts: number[][], c: Del[]) {
  const mw = new oc.BRepBuilderAPI_MakeWire_1(); c.push(mw);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = new oc.gp_Pnt_3(...pts[i]); const b = new oc.gp_Pnt_3(...pts[i + 1]); c.push(a, b);
    const e = new oc.BRepBuilderAPI_MakeEdge_3(a, b); c.push(e);
    mw.Add_1(e.Edge());
  }
  const w = mw.Wire(); c.push(w);
  return w;
}
function freeEdges(oc: Oc, shape: any, c: Del[]) {
  const sew = new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false); c.push(sew);
  sew.Add(shape); const pi = new oc.Handle_Message_ProgressIndicator_1(); c.push(pi); sew.Perform(pi);
  return sew.NbFreeEdges();
}
function faceCount(oc: Oc, shape: any, c: Del[]) { return collectFaces(oc, shape, c).length; }

async function main() {
  const oc: Oc = await getOcct(process.cwd());
  const wires: Array<[string, number[][], number]> = [
    ["one-segment", [[0, 0, 0], [4, 0, 0]], 4],
    ["polyline-3pt", [[0, 0, 0], [3, 0, 0], [3, 4, 0]], 3 + 4],
  ];
  const H = 5;
  for (const [name, pts, length] of wires) {
    const c: Del[] = [];
    try {
      const w = openWire(oc, pts, c);
      const v = new oc.gp_Vec_4(0, 0, H); c.push(v);
      const pr = new oc.BRepPrimAPI_MakePrism_1(w, v, false, true); c.push(pr);
      const sh = pr.Shape(); c.push(sh);
      const segs = pts.length - 1;
      const a = area(oc, sh, c);
      out({ step: "prism", name, type: type(oc, sh), faces: faceCount(oc, sh, c), segs, area: a, expected: length * H, free: freeEdges(oc, sh, c), expectedFree: 2 * segs + 2 });

      // append to block.stp exactly as featureModel would: compound(existing + new)
      oc.FS.writeFile("/b.stp", fs.readFileSync("examples/STP/block.stp"));
      const box = readShape(oc, "/b.stp", "step", c);
      const b = new oc.BRep_Builder(); c.push(b);
      const comp = new oc.TopoDS_Compound(); c.push(comp);
      b.MakeCompound(comp); b.Add(comp, box); b.Add(comp, sh);
      const ids = collectFaces(oc, comp, c).length;
      const groups = tessellateByGroup(oc, comp);
      const tot = groups.reduce((n, g) => n + g.faceCount, 0);
      out({ step: "lockstep", name, collectFaces: ids, tessellated: tot, groups: groups.map((g) => `${g.id}:${g.faceCount}`) });

      // STEP round trip
      const cl: Del[] = [];
      writeShape(oc, comp, "/o.step", "step", cl);
      const re = readShape(oc, "/o.step", "step", cl);
      out({ step: "step-roundtrip", name, faces: faceCount(oc, re, cl), area: area(oc, re, cl), expectedTotal: 2 * (3 * 4 + 3 * 5 + 4 * 5) + length * H });
      dispose(cl);
    } catch (e) { out({ fatal: name, e: String((e as Error)?.message ?? e) }); } finally { dispose(c); try { oc.FS.unlink("/b.stp"); } catch { /* */ } try { oc.FS.unlink("/o.step"); } catch { /* */ } }
  }
  // revolve: segment at x=2..2 (vertical line from (2,0,0) to (2,0,3)) about Z = cylinder side, area 2*pi*2*3
  {
    const c: Del[] = [];
    tryCall("revolve", () => {
      const w = openWire(oc, [[2, 0, 0], [2, 0, 3]], c);
      const o = new oc.gp_Pnt_3(0, 0, 0); const d = new oc.gp_Dir_4(0, 0, 1); c.push(o, d);
      const ax = new oc.gp_Ax1_2(o, d); c.push(ax);
      const rv = new oc.BRepPrimAPI_MakeRevol_1(w, ax, 2 * Math.PI, false); c.push(rv);
      const sh = rv.Shape(); c.push(sh);
      out({ step: "revolve", type: type(oc, sh), faces: faceCount(oc, sh, c), area: area(oc, sh, c), pappus: 2 * Math.PI * 2 * 3 });
    });
    dispose(c);
  }
}
main().catch((e) => { out({ fatal: typeof e === "number" ? `raw:${e}` : String(e?.stack ?? e) }); process.exit(1); });
