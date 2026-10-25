/** Roadmap 3.2 "B-rep repair as an explicit op" probe.
 * Run: npm run probe -- scripts/probe/examples/occt-shapefix.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that the gate passed.
 *
 * (1) ctor/prototype enumeration for ShapeFix_Face / Wire / FixSmallFace / FixSmallSolid;
 * (2) daratech.stp: per-face ShapeFix_Face, rebuilt into a compound, re-checked;
 * (3) piston.stp: ShapeFix_Wire per wire + ShapeFix_FixSmallFace, open-edge count before/after;
 * (4) bull.stp control: every fixer must leave a valid shape's BREP text unchanged.
 */
import * as fs from "fs";
import { getOcct, readShape } from "../../../src/occtService";
import { collectFaces } from "../../../src/occtOperations";
import { volumePropertiesAdaptive } from "../../../src/brepGProp";

console.log = console.error.bind(console);
type Oc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Del = { delete(): void };

const out = (o: unknown) => console.error(JSON.stringify(o));
const CLASSES = ["ShapeFix_Face", "ShapeFix_Wire", "ShapeFix_FixSmallFace", "ShapeFix_FixSmallSolid", "ShapeFix_Solid"];

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
function sub(oc: Oc, shape: any, kind: string, cleanup: Del[]): any[] {
  const res: any[] = [];
  const ex = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum[kind], oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  cleanup.push(ex);
  for (; ex.More(); ex.Next()) { const s = ex.Current(); cleanup.push(s); res.push(s); }
  return res;
}
function openEdges(oc: Oc, shape: any, cleanup: Del[]): number {
  const fb = new oc.ShapeAnalysis_FreeBounds_2(shape, 1e-4, true, false); cleanup.push(fb);
  const c = fb.GetClosedWires(); cleanup.push(c);
  const o = fb.GetOpenWires(); cleanup.push(o);
  return sub(oc, c, "TopAbs_EDGE", cleanup).length + sub(oc, o, "TopAbs_EDGE", cleanup).length;
}
function stats(oc: Oc, shape: any, cleanup: Del[]) {
  const an = new oc.BRepCheck_Analyzer(shape, true); cleanup.push(an);
  const faces = sub(oc, shape, "TopAbs_FACE", cleanup);
  const badFaces = faces.filter((f) => !an.IsValid_1(f)).length;
  const vp = new oc.GProp_GProps_1(); cleanup.push(vp);
  volumePropertiesAdaptive(oc, shape, vp);
  return { valid: an.IsValid_2(), faces: faces.length, badFaces, openEdges: openEdges(oc, shape, cleanup), volume: vp.Mass() };
}
function brepText(oc: Oc, shape: any): string {
  const pr = new oc.Handle_Message_ProgressIndicator_1(); oc.BRepTools.Write_2(shape, "/r.brep", pr); pr.delete();
  const t = Buffer.from(oc.FS.readFile("/r.brep")).toString("latin1");
  try { oc.FS.unlink("/r.brep"); } catch { /* ignore */ }
  return t;
}
function load(oc: Oc, file: string, cleanup: Del[]) {
  oc.FS.writeFile("/f.stp", fs.readFileSync(`examples/STP/${file}`));
  const s = readShape(oc, "/f.stp", "step", cleanup);
  try { oc.FS.unlink("/f.stp"); } catch { /* ignore */ }
  return s;
}
function compoundOf(oc: Oc, shapes: any[], cleanup: Del[]) {
  const b = new oc.BRep_Builder(); cleanup.push(b);
  const comp = new oc.TopoDS_Compound(); cleanup.push(comp);
  b.MakeCompound(comp);
  shapes.forEach((s) => b.Add(comp, s));
  return comp;
}

/** Face-level fix applied to every face of the shape; unchanged faces are passed through. */
function fixFaces(oc: Oc, shape: any, cleanup: Del[], only?: (i: number) => boolean) {
  const faces = sub(oc, shape, "TopAbs_FACE", cleanup);
  let changed = 0;
  const outFaces = faces.map((f, i) => {
    if (only && !only(i)) return f;
    const r = tryCall(`face-${i}`, () => {
      const fx = new oc.ShapeFix_Face_2(oc.TopoDS.Face_1(f)); cleanup.push(fx);
      const did = fx.Perform();
      const nf = fx.Face(); cleanup.push(nf);
      return { did, nf };
    });
    if (r?.did) { changed++; return r.nf; }
    return f;
  });
  return { shape: compoundOf(oc, outFaces, cleanup), changed };
}

async function main() {
  const oc: Oc = await getOcct(process.cwd());
  out({
    step: "prototypes",
    ...Object.fromEntries(CLASSES.map((c) => [c, {
      ctors: Object.keys(oc).filter((k) => k.startsWith(c + "_")),
      proto: oc[c] ? Object.getOwnPropertyNames(oc[c].prototype).filter((n) => n !== "constructor") : null,
    }])),
  });

  // ---- (4) control first: bull.stp through each fixer ----
  {
    const cleanup: Del[] = [];
    try {
      const bull = load(oc, "bull.stp", cleanup);
      const before = brepText(oc, bull);
      out({ step: "bull-before", ...stats(oc, bull, cleanup) });
      const t0 = Date.now();
      const r = fixFaces(oc, bull, cleanup);
      out({ step: "bull-ShapeFix_Face", ms: Date.now() - t0, changedFaces: r.changed, ...stats(oc, r.shape, cleanup) });
      const wiresChanged = tryCall("bull-wire", () => {
        let n = 0;
        const faces = sub(oc, bull, "TopAbs_FACE", cleanup);
        for (const f of faces) {
          for (const w of sub(oc, f, "TopAbs_WIRE", cleanup)) {
            const fw = new oc.ShapeFix_Wire_2(oc.TopoDS.Wire_1(w), oc.TopoDS.Face_1(f), 1e-6); cleanup.push(fw);
            if (fw.Perform()) n++;
          }
        }
        return n;
      });
      out({ step: "bull-ShapeFix_Wire", wiresReportedChanged: wiresChanged });
      const small = tryCall("bull-smallface", () => {
        const fs_ = new oc.ShapeFix_FixSmallFace(); cleanup.push(fs_);
        fs_.Init(bull); fs_.Perform();
        const res = fs_.FixShape(); cleanup.push(res);
        return { same: brepText(oc, res) === before, ...stats(oc, res, cleanup) };
      });
      out({ step: "bull-ShapeFix_FixSmallFace", result: small });
      out({ step: "bull-face-text-identical", identical: brepText(oc, r.shape) === before, note: "compound of faces vs original shape; differs structurally by design" });
    } finally { dispose(cleanup); }
  }

  // ---- (2) daratech.stp ----
  {
    const cleanup: Del[] = [];
    try {
      const d = load(oc, "daratech.stp", cleanup);
      const base = stats(oc, d, cleanup);
      out({ step: "daratech-before", ...base });
      const an = new oc.BRepCheck_Analyzer(d, true); cleanup.push(an);
      const faces = sub(oc, d, "TopAbs_FACE", cleanup);
      const bad = faces.map((f, i) => (an.IsValid_1(f) ? -1 : i)).filter((i) => i >= 0);
      out({ step: "daratech-bad-faces", bad });
      const t0 = Date.now();
      const r = fixFaces(oc, d, cleanup, (i) => bad.includes(i));
      out({ step: "daratech-ShapeFix_Face", ms: Date.now() - t0, changedFaces: r.changed, ...stats(oc, r.shape, cleanup) });
      const all = fixFaces(oc, d, cleanup);
      out({ step: "daratech-ShapeFix_Face-all", changedFaces: all.changed, ...stats(oc, all.shape, cleanup) });
    } finally { dispose(cleanup); }
  }

  // ---- (3) piston.stp ----
  {
    const cleanup: Del[] = [];
    try {
      const p = load(oc, "piston.stp", cleanup);
      out({ step: "piston-before", ...stats(oc, p, cleanup) });
      const r = fixFaces(oc, p, cleanup);
      out({ step: "piston-ShapeFix_Face", changedFaces: r.changed, ...stats(oc, r.shape, cleanup) });
      const small = tryCall("piston-smallface", () => {
        const fx = new oc.ShapeFix_FixSmallFace(); cleanup.push(fx);
        fx.Init(p); fx.Perform();
        const res = fx.FixShape(); cleanup.push(res);
        return stats(oc, res, cleanup);
      });
      out({ step: "piston-ShapeFix_FixSmallFace", result: small });
      const solids = sub(oc, p, "TopAbs_SOLID", cleanup);
      const sm = tryCall("piston-smallsolid", () => {
        const fx = new oc.ShapeFix_FixSmallSolid(); cleanup.push(fx);
        fx.SetFixMode(1);
        const res = fx.Remove(p, new oc.ShapeBuild_ReShape(), new oc.ShapeBuild_ReShape()); // exploratory shape of API
        return { solids: solids.length, res: !!res };
      });
      out({ step: "piston-ShapeFix_FixSmallSolid", result: sm });
    } finally { dispose(cleanup); }
  }
  // ---- (5) plain ctors + ShapeFix_Wire on daratech's flagged faces ----
  {
    const cleanup: Del[] = [];
    try {
      for (const c of ["ShapeFix_FixSmallFace", "ShapeFix_FixSmallSolid"]) {
        out({ step: "plain-ctor", cls: c, typeofClass: typeof oc[c], result: tryCall(c, () => { const o = new oc[c](); cleanup.push(o); return "constructed"; }) });
      }
      const d = load(oc, "daratech.stp", cleanup);
      const faces = sub(oc, d, "TopAbs_FACE", cleanup);
      for (const i of [13, 54, 58, 70, 71]) {
        const f = faces[i];
        const r = tryCall(`wire-${i}`, () => {
          let did = 0, wires = 0;
          for (const w of sub(oc, f, "TopAbs_WIRE", cleanup)) {
            wires++;
            const fw = new oc.ShapeFix_Wire_2(oc.TopoDS.Wire_1(w), oc.TopoDS.Face_1(f), 1e-4); cleanup.push(fw);
            if (fw.Perform()) did++;
          }
          const fx = new oc.ShapeFix_Face_2(oc.TopoDS.Face_1(f)); cleanup.push(fx);
          fx.FixOrientationMode = true;
          const p = fx.Perform();
          const nf = fx.Face(); cleanup.push(nf);
          const an = new oc.BRepCheck_Analyzer(nf, true); cleanup.push(an);
          return { wires, wireFixed: did, facePerform: p, faceValidAfter: an.IsValid_2() };
        });
        out({ step: "daratech-face", i, result: r });
      }
    } finally { dispose(cleanup); }
  }
  void collectFaces;
}

main().catch((e) => { out({ fatal: typeof e === "number" ? `raw:${e}` : String(e?.stack ?? e) }); process.exit(1); });
