/** Roadmap 3.13 probe: variable-radius fillets (PASSED 2026-10-20, opencascade.js 1.1.1).
 * Run: npm run probe -- scripts/probe/examples/occt-var-fillet.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that the gate passed.
 *
 * On a 20 mm cube (volume 8000) the probe:
 *  1. enumerates BRepFilletAPI_MakeFillet.prototype for Add* and tries every
 *     overload with (R1, R2, edge) on one straight 20-long edge;
 *  2. checks the winner with BRepCheck_Analyzer, volume ordering against the
 *     constant-R1 / constant-R2 controls, and cross-section loop areas near
 *     each end (analytic: 400 - R^2*(1-pi/4), i.e. 399.14 for R=2, 386.27
 *     for R=8) cut from the fine tessellation with drawingSection.ts;
 *  3. repeats on a cylinder top circle (cylinder-plane junction, closed edge)
 *     and on a three-edge U chain, with end sections on the middle edge to
 *     see whether the radius law is per-edge or per-chain.
 */
import { getOcct, resetOcct, wrapOcctFault } from "../../../src/occtService";
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
  let oc: Oc = await getOcct(process.cwd());
  const cleanup: Del[] = [];
  const out: Record<string, unknown> = {};
  try {
    // Step 1: enumerate the Add* overloads on a throwaway maker.
    const probe = makeCube(oc, cleanup);
    const makerProbe = new oc.BRepFilletAPI_MakeFillet(probe, oc.ChFi3d_FilletShape.ChFi3d_Rational);
    cleanup.push(makerProbe);
    const adds: string[] = Object.getOwnPropertyNames(oc.BRepFilletAPI_MakeFillet.prototype)
      .filter((k) => k.startsWith("Add"))
      .sort();
    out.addOverloads = adds;

    // Try every overload as (R1, R2, edge) on the bottom-front X edge.
    const overloadResults: Record<string, unknown>[] = [];
    for (const key of adds) {
      const shape = makeCube(oc, cleanup);
      const edge = edgeNear(oc, shape, [10, 0, 0], cleanup);
      const maker = new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational);
      cleanup.push(maker);
      const t0 = Date.now();
      try {
        maker[key](R1, R2, edge);
        // Mirror filletEdges: Shape() auto-builds first, IsDone() after.
        let result: Record<string, unknown> = { overload: key, threw: false, ms: Date.now() - t0 };
        try {
          const s = maker.Shape(); cleanup.push(s);
          result = {
            ...result,
            isDone: maker.IsDone(),
            valid: validityOf(oc, s, cleanup),
            volume: Math.round(volumeOf(oc, s, cleanup) * 1000) / 1000,
            faces: faceCount(oc, s, cleanup),
          };
        } catch (e) {
          result = { ...result, isDone: false, shapeThrew: String((e as Error)?.message ?? e).slice(0, 200) };
        }
        overloadResults.push(result);
      } catch (e) {
        overloadResults.push({ overload: key, threw: true, error: String((e as Error)?.message ?? e).slice(0, 200), ms: Date.now() - t0 });
      }
    }
    out.overloadSweep = overloadResults;
    const winner = overloadResults.find((r) => r.isDone === true) as { overload: string } | undefined;
    out.winner = winner?.overload ?? null;

    // Controls: constant-radius fillets on the same edge.
    const controls: Record<string, unknown> = {};
    for (const [name, r] of [["const2", R1], ["const8", R2]] as Array<[string, number]>) {
      const shape = makeCube(oc, cleanup);
      const edge = edgeNear(oc, shape, [10, 0, 0], cleanup);
      const maker = new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational);
      cleanup.push(maker);
      maker.Add_2(r, edge);
      const s = maker.Shape(); cleanup.push(s);
      const done = maker.IsDone();
      controls[name] = { isDone: done, valid: validityOf(oc, s, cleanup), volume: Math.round(volumeOf(oc, s, cleanup) * 1000) / 1000, faces: faceCount(oc, s, cleanup) };
    }
    out.controls = controls;

    // Step 2: end sections on the winner.
    if (winner) {
      const shape = makeCube(oc, cleanup);
      const edge = edgeNear(oc, shape, [10, 0, 0], cleanup);
      const maker = new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational);
      cleanup.push(maker);
      maker[winner.overload](R1, R2, edge);
      const s = maker.Shape(); cleanup.push(s);
      const t0 = Date.now();
      const endA = sectionArea(oc, s, [1, 0, 0], [1, 0, 0]);
      const endB = sectionArea(oc, s, [19, 0, 0], [1, 0, 0]);
      out.endSections = {
        atX1: { ...endA, area: Math.round(endA.area * 100) / 100 },
        atX19: { ...endB, area: Math.round(endB.area * 100) / 100 },
        analyticR1: Math.round(analyticSection(R1) * 100) / 100,
        analyticR2: Math.round(analyticSection(R2) * 100) / 100,
        ms: Date.now() - t0,
      };
    }

    // Step 3a: closed circular edge (cylinder top = cylinder-plane junction).
    // Constant-radius controls on the same circle tell whether the variable
    // law actually varies around a closed edge (volume strictly between) or
    // degenerates. Controls use radii that fit the r=6 cylinder; the
    // variable attempt runs FIRST because a too-large radius aborts the
    // WASM instance (___cxa_is_pointer_type) and needs a kernel reset.
    const circleControls: Record<string, unknown> = {};
    const resetKernel = async (): Promise<void> => {
      // A hard abort poisons the singleton: drop it so the next getOcct()
      // builds a fresh instance. Handles created before the reset are dead;
      // the final cleanup loop already tolerates throwing deletes.
      resetOcct();
      oc = await getOcct(process.cwd());
    };
    try {
      const buildCylinder = (): any => {
        const p = new oc.gp_Pnt_3(0, 0, 0); cleanup.push(p);
        const d = new oc.gp_Dir_4(0, 0, 1); cleanup.push(d);
        const ax = new oc.gp_Ax2_3(p, d); cleanup.push(ax);
        const cyl = new oc.BRepPrimAPI_MakeCylinder_3(ax, 6, 20); cleanup.push(cyl);
        const s = cyl.Shape(); cleanup.push(s);
        return s;
      };
      const cs = buildCylinder();
      circleControls.plainVolume = Math.round(volumeOf(oc, cs, cleanup) * 1000) / 1000;
      if (winner) {
        try {
          const circle = edgeNear(oc, cs, [6, 0, 20], cleanup);
          const maker = new oc.BRepFilletAPI_MakeFillet(cs, oc.ChFi3d_FilletShape.ChFi3d_Rational);
          cleanup.push(maker);
          maker[winner.overload](R1, R2, circle);
          const s = maker.Shape(); cleanup.push(s);
          out.curvedEdge = { isDone: maker.IsDone(), valid: validityOf(oc, s, cleanup), volume: Math.round(volumeOf(oc, s, cleanup) * 1000) / 1000 };
        } catch (e) {
          out.curvedEdge = { threw: true, error: String((e as Error)?.message ?? e).slice(0, 200) };
          await resetKernel();
        }
      } else {
        out.curvedEdge = { skipped: "no winning overload" };
      }
      for (const [name, r] of [["const2", 2], ["const4", 4]] as Array<[string, number]>) {
        try {
          const s2 = buildCylinder();
          const circ = edgeNear(oc, s2, [6, 0, 20], cleanup);
          const m = new oc.BRepFilletAPI_MakeFillet(s2, oc.ChFi3d_FilletShape.ChFi3d_Rational);
          cleanup.push(m);
          m.Add_2(r, circ);
          const f = m.Shape(); cleanup.push(f);
          circleControls[name] = { isDone: m.IsDone(), valid: validityOf(oc, f, cleanup), volume: Math.round(volumeOf(oc, f, cleanup) * 1000) / 1000 };
        } catch (e) {
          circleControls[name] = { threw: true, error: String((e as Error)?.message ?? e).slice(0, 200) };
          await resetKernel();
        }
      }
      // A constant radius larger than the cylinder itself: expected to fail,
      // recorded for the failure-mode table (it aborts the WASM instance).
      try {
        const s3 = buildCylinder();
        const circ = edgeNear(oc, s3, [6, 0, 20], cleanup);
        const m = new oc.BRepFilletAPI_MakeFillet(s3, oc.ChFi3d_FilletShape.ChFi3d_Rational);
        cleanup.push(m);
        m.Add_2(8, circ);
        const f = m.Shape(); cleanup.push(f);
        circleControls["const8"] = { isDone: m.IsDone(), valid: validityOf(oc, f, cleanup), volume: Math.round(volumeOf(oc, f, cleanup) * 1000) / 1000 };
      } catch (e) {
        circleControls["const8"] = { threw: true, error: String((e as Error)?.message ?? e).slice(0, 200) };
        await resetKernel();
      }
      (out.curvedEdge as Record<string, unknown>).controls = circleControls;
    } catch (e) {
      out.curvedEdge = { threw: true, error: String((e as Error)?.message ?? e).slice(0, 200) };
    }

    // Step 3b: three-edge U chain, one maker, winner overload per edge; end
    // sections on the middle edge discriminate per-edge vs per-chain law.
    try {
      if (!winner) {
        out.chain = { skipped: "no winning overload" };
      } else {
        const shape = makeCube(oc, cleanup);
        const e1 = edgeNear(oc, shape, [10, 0, 0], cleanup);
        const e2 = edgeNear(oc, shape, [0, 10, 0], cleanup);
        const e3 = edgeNear(oc, shape, [10, 20, 0], cleanup);
        const maker = new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational);
        cleanup.push(maker);
        maker[winner.overload](R1, R2, e1);
        maker[winner.overload](R1, R2, e2);
        maker[winner.overload](R1, R2, e3);
        const s = maker.Shape(); cleanup.push(s);
        const done = maker.IsDone();
        const mid1 = sectionArea(oc, s, [0, 1, 0], [0, 1, 0]);
        const mid19 = sectionArea(oc, s, [0, 19, 0], [0, 1, 0]);
        out.chain = {
          isDone: done,
          valid: validityOf(oc, s, cleanup),
          volume: Math.round(volumeOf(oc, s, cleanup) * 1000) / 1000,
          middleEdgeEnds: {
            atY1: Math.round(mid1.area * 100) / 100,
            atY19: Math.round(mid19.area * 100) / 100,
          },
        };
      }
    } catch (e) {
      out.chain = { threw: true, error: String((e as Error)?.message ?? e).slice(0, 200) };
    }

    out.decision = "manual: read overloadSweep, endSections, curvedEdge, chain";
  } catch (e) {
    try { wrapOcctFault(e); } catch { /* ignore */ }
    out.fatal = String((e as Error)?.message ?? e).slice(0, 300);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) { try { cleanup[i].delete(); } catch { /* ignore */ } }
  }
  console.error(JSON.stringify(out, null, 2));
}

main().then(
  () => process.exit(0),
  () => process.exit(0)
);
