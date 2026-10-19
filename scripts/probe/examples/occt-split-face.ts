/** Roadmap "Imprint and split faces for boundary-condition regions" probe.
 * Run: npm run probe -- scripts/probe/examples/occt-split-face.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that the gate passed.
 *
 * On examples/STP/block.stp (3 x 4 x 5, centred on the origin: x in [-1.5, 1.5], y in [-2, 2], z in [-2.5, 2.5])
 * split the top face (z = 2.5, area 12) along y = 0 and require, analytically:
 *   - the face count rises by exactly one (6 -> 7) and the solid count stays 1;
 *   - the volume is unchanged (60) and the surface area is unchanged (94);
 *   - the two new top faces have area 6 each and their centres are y = -1 and y = +1.
 * Tried with (a) BRepFeat_SplitShape with an edge on the face and (b) BRepAlgoAPI_Splitter with a plane-face tool.
 */
import * as fs from "fs";
import { getOcct, readShape } from "../../../src/occtService";
import { collectFaces, bboxCenter } from "../../../src/occtOperations";
import { volumePropertiesAdaptive, surfacePropertiesAdaptive } from "../../../src/brepGProp";

console.log = console.error.bind(console);
type Oc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Del = { delete(): void };

function measure(oc: Oc, shape: any, cleanup: Del[]): Record<string, unknown> {
  const faces = collectFaces(oc, shape, cleanup);
  const vp = new oc.GProp_GProps_1(); cleanup.push(vp);
  volumePropertiesAdaptive(oc, shape, vp); // returns the integration error estimate; the value is Mass()
  const volume = vp.Mass();
  const sp = new oc.GProp_GProps_1(); cleanup.push(sp);
  surfacePropertiesAdaptive(oc, shape, sp);
  const area = sp.Mass();
  const solids = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); cleanup.push(solids);
  let nSolids = 0; for (; solids.More(); solids.Next()) nSolids++;
  const top: { area: number; centre: number[] }[] = [];
  for (const f of faces) {
    const c = bboxCenter(oc, f, cleanup);
    if (Math.abs(c[2] - 2.5) > 1e-6) continue; // top faces only
    const fp = new oc.GProp_GProps_1(); cleanup.push(fp);
    surfacePropertiesAdaptive(oc, f, fp);
    top.push({ area: fp.Mass(), centre: c.map((v) => Math.round(v * 1e6) / 1e6) });
  }
  return { faces: faces.length, solids: nSolids, volume, area, topFaces: top };
}

async function attempt(name: string, fn: (oc: Oc, shape: any, topFace: any, cleanup: Del[]) => any): Promise<Record<string, unknown>> {
  const oc: Oc = await getOcct(process.cwd());
  const cleanup: Del[] = [];
  try {
    oc.FS.writeFile("/b.step", fs.readFileSync("examples/STP/block.stp"));
    const shape = readShape(oc, "/b.step", "step", cleanup);
    const before = measure(oc, shape, cleanup);
    const faces = collectFaces(oc, shape, cleanup);
    const topFace = faces.find((f: any) => Math.abs(bboxCenter(oc, f, cleanup)[2] - 2.5) < 1e-6);
    const t0 = Date.now();
    const result = fn(oc, shape, topFace, cleanup);
    const ms = Date.now() - t0;
    const after = measure(oc, result, cleanup);
    return { name, ms, before, after };
  } catch (e) {
    return { name, error: String((e as Error)?.message ?? e).slice(0, 300) };
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) { try { cleanup[i].delete(); } catch { /* ignore */ } }
    try { oc.FS.unlink("/b.step"); } catch { /* ignore */ }
  }
}

async function main(): Promise<void> {
  const out: unknown[] = [];
  for (const overload of ["Add_2", "Add_3", "Add_4", "Add_5"]) {
    out.push(await attempt(`BRepFeat_SplitShape.${overload} + edge on the face`, (oc, shape, topFace, cleanup) => {
      const a = new oc.gp_Pnt_3(-1.5, 0, 2.5); cleanup.push(a);
      const b = new oc.gp_Pnt_3(1.5, 0, 2.5); cleanup.push(b);
      const mk = new oc.BRepBuilderAPI_MakeEdge_3(a, b); cleanup.push(mk);
      const edge = mk.Edge(); cleanup.push(edge);
      const split = new oc.BRepFeat_SplitShape_2(shape); cleanup.push(split);
      split[overload](edge, topFace);
      split.Build();
      if (!split.IsDone()) throw new Error("BRepFeat_SplitShape did not finish");
      const r = split.Shape(); cleanup.push(r);
      return r;
    }));
  }
  out.push(await attempt("BRepAlgoAPI_Splitter + EDGE tool lying on the top face", (oc, shape, _topFace, cleanup) => {
    const a = new oc.gp_Pnt_3(-1.5, 0, 2.5); cleanup.push(a);
    const b = new oc.gp_Pnt_3(1.5, 0, 2.5); cleanup.push(b);
    const mk = new oc.BRepBuilderAPI_MakeEdge_3(a, b); cleanup.push(mk);
    const edge = mk.Edge(); cleanup.push(edge);
    const splitter = new oc.BRepAlgoAPI_Splitter_1(); cleanup.push(splitter);
    const args = new oc.TopTools_ListOfShape_1(); cleanup.push(args);
    args.Append_1(shape);
    const tools = new oc.TopTools_ListOfShape_1(); cleanup.push(tools);
    tools.Append_1(edge);
    splitter.SetArguments(args);
    splitter.SetTools(tools);
    splitter.Build();
    if (!splitter.IsDone()) throw new Error("BRepAlgoAPI_Splitter did not finish");
    const r = splitter.Shape(); cleanup.push(r);
    return r;
  }));
  out.push(await attempt("BRepAlgoAPI_Splitter + plane-face tool (y = 0)", (oc, shape, _topFace, cleanup) => {
    // A planar tool face larger than the block, in the y = 0 plane, normal +y.
    const origin = new oc.gp_Pnt_3(0, 0, 0); cleanup.push(origin);
    const dir = new oc.gp_Dir_4(0, 1, 0); cleanup.push(dir);
    const plane = new oc.gp_Pln_3(origin, dir); cleanup.push(plane);
    const mk = new oc.BRepBuilderAPI_MakeFace_9(plane, -10, 10, -10, 10); cleanup.push(mk);
    const tool = mk.Face(); cleanup.push(tool);
    const splitter = new oc.BRepAlgoAPI_Splitter_1(); cleanup.push(splitter);
    const args = new oc.TopTools_ListOfShape_1(); cleanup.push(args);
    args.Append_1(shape);
    const tools = new oc.TopTools_ListOfShape_1(); cleanup.push(tools);
    tools.Append_1(tool);
    splitter.SetArguments(args);
    splitter.SetTools(tools);
    splitter.Build();
    if (!splitter.IsDone()) throw new Error("BRepAlgoAPI_Splitter did not finish");
    const r = splitter.Shape(); cleanup.push(r);
    return r;
  }));
  console.error(JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
