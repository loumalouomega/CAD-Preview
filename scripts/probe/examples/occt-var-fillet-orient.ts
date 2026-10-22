/** Roadmap 2.23 probe: which end of an edge does Add_3(R1,R2,edge) put R1 on? Compares curve First/Last and explorer-vertex order over all 12 cube edges. */
import { getOcct } from "../../../src/occtService";
import { collectEdges, bboxCenter } from "../../../src/occtOperations";
import { volumePropertiesAdaptive } from "../../../src/brepGProp";
import { tessellateByGroup } from "../../../src/meshExtract";
import { TESSELLATION_PRESETS } from "../../../src/tessellationQuality";
import { clipTrianglesToPlane, buildCutLoops, loopArea } from "../../../src/drawingSection";

console.log = console.error.bind(console);
type Oc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Del = { delete(): void };
type V3 = [number, number, number];

const R1 = 2, R2 = 8;
const analyticSection = (r: number): number => 400 - r * r * (1 - Math.PI / 4);

function dist(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function makeCube(oc: Oc, cleanup: Del[]): any {
  const p1 = new oc.gp_Pnt_3(0, 0, 0); cleanup.push(p1);
  const p2 = new oc.gp_Pnt_3(20, 20, 20); cleanup.push(p2);
  const box = new oc.BRepPrimAPI_MakeBox_3(p1, p2); cleanup.push(box);
  const shape = box.Shape(); cleanup.push(shape);
  return shape;
}

function edgeNear(oc: Oc, shape: any, target: number[], cleanup: Del[]): any {
  let best: any = null, bestD = Infinity;
  for (const e of collectEdges(oc, shape, cleanup)) {
    const d = dist(bboxCenter(oc, e, cleanup), target);
    if (d < bestD) { bestD = d; best = e; }
  }
  if (!best) throw new Error("no edges");
  return best;
}

function volumeOf(oc: Oc, shape: any, cleanup: Del[]): number {
  const vp = new oc.GProp_GProps_1(); cleanup.push(vp);
  volumePropertiesAdaptive(oc, shape, vp);
  return vp.Mass();
}

function faceCount(oc: Oc, shape: any, cleanup: Del[]): number {
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  cleanup.push(exp);
  let n = 0; for (; exp.More(); exp.Next()) n++;
  return n;
}

function validityOf(oc: Oc, shape: any, cleanup: Del[]): boolean {
  const analyzer = new oc.BRepCheck_Analyzer(shape, true); cleanup.push(analyzer);
  return analyzer.IsValid_2();
}

/** Total closed-loop area of the tessellated shape cut by a plane. */
function sectionArea(oc: Oc, shape: any, origin: V3, normal: V3): { loops: number; area: number; triangles: number } {
  const local: Del[] = [];
  try {
    const groups = tessellateByGroup(oc, shape, TESSELLATION_PRESETS.fine);
    let vCount = 0;
    const pos: number[] = [];
    const idx: number[] = [];
    for (const g of groups) {
      for (const f of g.faces) {
        const base = vCount;
        const p = f.buffers.positions, ix = f.buffers.indices;
        for (let i = 0; i < p.length; i++) pos.push(p[i]);
        for (let i = 0; i < ix.length; i++) idx.push(base + ix[i]);
        vCount += p.length / 3;
      }
    }
    const clipped = clipTrianglesToPlane(new Float32Array(pos), new Uint32Array(idx), undefined, { origin, normal });
    if (!clipped.crossed) return { loops: 0, area: 0, triangles: Math.floor(idx.length / 3) };
    // Project onto an arbitrary basis perpendicular to the normal.
    const n = normal.map((v) => v / Math.hypot(...normal)) as V3;
    const helper = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const right: V3 = [
      helper[1] * n[2] - helper[2] * n[1],
      helper[2] * n[0] - helper[0] * n[2],
      helper[0] * n[1] - helper[1] * n[0],
    ];
    const rl = Math.hypot(...right);
    const r: V3 = [right[0] / rl, right[1] / rl, right[2] / rl];
    const up: V3 = [n[1] * r[2] - n[2] * r[1], n[2] * r[0] - n[0] * r[2], n[0] * r[1] - n[1] * r[0]];
    const chains = buildCutLoops(clipped.cutSegments, 1e-6);
    let area = 0, loops = 0;
    for (const c of chains) {
      if (!c.closed || c.points.length < 3) continue;
      loops++;
      area += loopArea(c.points.map((p) => [p[0] * r[0] + p[1] * r[1] + p[2] * r[2], p[0] * up[0] + p[1] * up[1] + p[2] * up[2]] as [number, number]));
    }
    return { loops, area, triangles: Math.floor(idx.length / 3) };
  } finally {
    for (let i = local.length - 1; i >= 0; i--) { try { local[i].delete(); } catch { /* ignore */ } }
  }
}

async function main(): Promise<void> {
  const oc: Oc = await getOcct(process.cwd());
  const rows: unknown[] = [];
  for (let k = 0; k < 12; k++) {
    const cleanup: Del[] = [];
    try {
      const shape = makeCube(oc, cleanup);
      const edges = collectEdges(oc, shape, cleanup);
      const e = edges[k];
      const curve = new oc.BRepAdaptor_Curve_2(e); cleanup.push(curve);
      const pF = curve.Value(curve.FirstParameter()), pL = curve.Value(curve.LastParameter());
      cleanup.push(pF, pL);
      const first: V3 = [pF.X(), pF.Y(), pF.Z()], last: V3 = [pL.X(), pL.Y(), pL.Z()];
      const vexp = new oc.TopExp_Explorer_2(e, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); cleanup.push(vexp);
      const ev: V3[] = [];
      for (; vexp.More(); vexp.Next()) { const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex_1(vexp.Current())); ev.push([p.X(), p.Y(), p.Z()]); }
      const orient = e.Orientation_1().value;
      const maker = new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational); cleanup.push(maker);
      maker.Add_3(R1, R2, e);
      const s = maker.Shape(); cleanup.push(s);
      const d = [last[0] - first[0], last[1] - first[1], last[2] - first[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      const n = d.map((v) => v / len) as V3;
      const at = (p: V3, off: number): V3 => [p[0] + n[0] * off, p[1] + n[1] * off, p[2] + n[2] * off];
      const aFirst = sectionArea(oc, s, at(first, 0.5), n).area;
      const aLast = sectionArea(oc, s, at(last, -0.5), n).area;
      rows.push({ k, orient, first, last, explorer: ev, aFirst: +aFirst.toFixed(2), aLast: +aLast.toFixed(2),
        r1At: aFirst > aLast ? "curveFirst" : "curveLast",
        explorerFirstIsCurveFirst: ev.length ? dist(ev[0], first) < 1e-6 : null });
    } catch (err) { rows.push({ k, error: String((err as Error)?.message ?? err) }); }
    finally { for (let i = cleanup.length - 1; i >= 0; i--) { try { cleanup[i].delete(); } catch { /* ignore */ } } }
  }
  console.error(JSON.stringify(rows, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
