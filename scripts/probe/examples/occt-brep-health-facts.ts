/** Roadmap 3.3 "More facts in the B-rep validity report" probe.
 * Run: npm run probe -- scripts/probe/examples/occt-brep-health-facts.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that the gate passed.
 *
 * (1) prototype enumeration for BRepExtrema_SelfIntersection and ShapeAnalysis_FreeBounds;
 * (2) self-intersection: clean box vs a box whose top face is translated through the bottom face;
 * (3) free bounds on piston.stp vs the ShapeAnalysis_Shell free-edge count;
 * (4) signed volume of a reversed solid; (5) timing on turbine.stp.
 */
import * as fs from "fs";
import { getOcct, readShape } from "../../../src/occtService";
import { collectFaces, collectSolids } from "../../../src/occtOperations";
import { volumePropertiesAdaptive } from "../../../src/brepGProp";

console.log = console.error.bind(console);
type Oc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Del = { delete(): void };

const out = (o: unknown) => console.error(JSON.stringify(o));
const protoNames = (oc: Oc, cls: string) => {
  const c = oc[cls];
  return c ? Object.getOwnPropertyNames(c.prototype).filter((n) => n !== "constructor") : null;
};

function tryCall<T>(label: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    out({ label, error: typeof e === "number" ? `raw:${e}` : String((e as Error)?.message ?? e).slice(0, 200) });
    return undefined;
  }
}

function dispose(cleanup: Del[]) {
  for (let i = cleanup.length - 1; i >= 0; i--) {
    try { cleanup[i].delete(); } catch { /* ignore */ }
  }
}

function edges(oc: Oc, shape: any, cleanup: Del[]): any[] {
  const res: any[] = [];
  const ex = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  cleanup.push(ex);
  for (; ex.More(); ex.Next()) { const s = ex.Current(); cleanup.push(s); res.push(s); }
  return res;
}

function signedVolume(oc: Oc, shape: any, cleanup: Del[]): number {
  const vp = new oc.GProp_GProps_1(); cleanup.push(vp);
  volumePropertiesAdaptive(oc, shape, vp);
  return vp.Mass();
}

async function main() {
  const oc: Oc = await getOcct(process.cwd());
  out({ step: "prototypes", selfIntersection: protoNames(oc, "BRepExtrema_SelfIntersection"), freeBounds: protoNames(oc, "ShapeAnalysis_FreeBounds"),
    ctorsSI: Object.keys(oc).filter((k) => k.startsWith("BRepExtrema_SelfIntersection")), ctorsFB: Object.keys(oc).filter((k) => k.startsWith("ShapeAnalysis_FreeBounds")) });

  // ---- (2) self-intersection on a box and on a box with a face pushed through ----
  {
    const cleanup: Del[] = [];
    try {
      oc.FS.writeFile("/b.step", fs.readFileSync("examples/STP/block.stp"));
      const box = readShape(oc, "/b.step", "step", cleanup);
      for (const [name, shape] of [["clean", box]] as const) {
        const t0 = Date.now();
        const r = tryCall(`si-${name}`, () => {
          const si = new oc.BRepExtrema_SelfIntersection_1(0.0);
          cleanup.push(si);
          out({ ctor1Keys: Object.getOwnPropertyNames(Object.getPrototypeOf(si)) });
          si.LoadShape(shape);
          si.Perform();
          return { isDone: si.IsDone?.(), overlaps: si.OverlapElements?.().Size?.() ?? si.OverlapElements?.() };
        });
        out({ step: "self-intersection", name, ms: Date.now() - t0, result: r });
      }
      // Dirty: translate the top face (z = +2.5) down by 6 so it passes through the bottom face (z = -2.5).
      const faces = collectFaces(oc, box, cleanup);
      out({ step: "box", faces: faces.length });
      const b = new oc.BRep_Builder(); cleanup.push(b);
      const comp = new oc.TopoDS_Compound(); cleanup.push(comp);
      b.MakeCompound(comp);
      faces.forEach((f: any, i: number) => {
        let s = f;
        const bb = new oc.Bnd_Box_1(); cleanup.push(bb);
        oc.BRepBndLib.Add(f, bb, false);
        const zmax = bb.CornerMax().Z(), zmin = bb.CornerMin().Z();
        if (zmin > 2.4 && zmax > 2.4) {
          const tr = new oc.gp_Trsf_1(); cleanup.push(tr);
          tr.SetTranslation_1(new oc.gp_Vec_4(0, 0, -6));
          const mk = new oc.BRepBuilderAPI_Transform_2(f, tr, true); cleanup.push(mk);
          s = mk.Shape();
        }
        b.Add(comp, s);
      });
      const t0 = Date.now();
      const r = tryCall("si-dirty", () => {
        const si = new oc.BRepExtrema_SelfIntersection_1(0.0);
        cleanup.push(si);
        si.LoadShape(comp);
        si.Perform();
        const els = si.OverlapElements?.();
        return { isDone: si.IsDone?.(), overlaps: els?.Size?.() ?? els, protoOverlap: els ? Object.getOwnPropertyNames(Object.getPrototypeOf(els)).slice(0, 25) : null };
      });
      out({ step: "self-intersection", name: "dirty", ms: Date.now() - t0, result: r });
    } finally { dispose(cleanup); try { oc.FS.unlink("/b.step"); } catch { /* ignore */ } }
  }

  // ---- (3) free bounds on piston.stp ----
  {
    const cleanup: Del[] = [];
    try {
      oc.FS.writeFile("/p.stp", fs.readFileSync("examples/STP/piston.stp"));
      const shape = readShape(oc, "/p.stp", "step", cleanup);
      const t0 = Date.now();
      const r = tryCall("free-bounds", () => {
        const fb = new oc.ShapeAnalysis_FreeBounds_2(shape, 1e-4, true, false); cleanup.push(fb);
        const closed = fb.GetClosedWires(); cleanup.push(closed);
        const open = fb.GetOpenWires(); cleanup.push(open);
        const nEdges = (s: any) => edges(oc, s, cleanup).length;
        const wires = (s: any) => {
          const ws: any[] = [];
          const ex = new oc.TopExp_Explorer_2(s, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); cleanup.push(ex);
          for (; ex.More(); ex.Next()) { const w = ex.Current(); cleanup.push(w); ws.push(w); }
          return ws;
        };
        return { closedWires: wires(closed).length, closedEdges: nEdges(closed), openWires: wires(open).length, openEdges: nEdges(open) };
      });
      out({ step: "free-bounds", ms: Date.now() - t0, result: r });
    } finally { dispose(cleanup); try { oc.FS.unlink("/p.stp"); } catch { /* ignore */ } }
  }

  // ---- (4) signed volume of a reversed solid ----
  {
    const cleanup: Del[] = [];
    try {
      oc.FS.writeFile("/b.step", fs.readFileSync("examples/STP/block.stp"));
      const box = readShape(oc, "/b.step", "step", cleanup);
      const solids = collectSolids(oc, box, cleanup);
      const fwd = signedVolume(oc, solids[0].solid, cleanup);
      const rev = solids[0].solid.Reversed(); cleanup.push(rev);
      out({ step: "signed-volume", forward: fwd, reversed: signedVolume(oc, rev, cleanup) });
    } finally { dispose(cleanup); try { oc.FS.unlink("/b.step"); } catch { /* ignore */ } }
  }

  // ---- (5) timing on turbine.stp ----
  {
    const cleanup: Del[] = [];
    try {
      oc.FS.writeFile("/t.stp", fs.readFileSync("examples/STP/turbine.stp"));
      const shape = readShape(oc, "/t.stp", "step", cleanup);
      let t0 = Date.now();
      const fb = tryCall("turbine-fb", () => { const x = new oc.ShapeAnalysis_FreeBounds_2(shape, 1e-4, true, false); cleanup.push(x); return x.GetClosedWires().IsNull() ? 0 : 1; });
      out({ step: "turbine-free-bounds", ms: Date.now() - t0, fb });
      t0 = Date.now();
      const si = tryCall("turbine-si", () => { const x = new oc.BRepExtrema_SelfIntersection_1(0.0); cleanup.push(x); x.LoadShape(shape); x.Perform(); return x.IsDone?.(); });
      out({ step: "turbine-self-intersection", ms: Date.now() - t0, si });
    } finally { dispose(cleanup); try { oc.FS.unlink("/t.stp"); } catch { /* ignore */ } }
  }
}

main().then(() => process.exit(0), (e) => { out({ fatal: String(e?.message ?? e) }); process.exit(1); });
