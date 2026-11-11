/** meshio++ 20.0.0 probe, part 2: spec grammar and the chained scan-to-CAD calls. */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";
console.log = console.error.bind(console);
const show = (label: string, v: unknown): void => console.error(label, JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : ArrayBuffer.isView(x) ? (x as any).length <= 16 ? Array.from(x as any, Number) : `${(x as any).constructor.name}[${(x as any).length}]` : x)).slice(0, 1100));
const attempt = async (label: string, f: () => unknown): Promise<any> => {
  try { const r = await f(); show(`OK ${label}`, r); return r; } catch (e) { console.error(`FAIL ${label}:`, (e as Error)?.message ?? e); return undefined; }
};
const brief = (mm: any) => ({ pts: mm.points.length / mm.dim, cells: mm.cells.map((b: any) => [b.type, b.data.length / (b.nodesPerCell ?? 1)]), cd: Object.keys(mm.cell_data ?? {}), fd: Object.keys(mm.field_data ?? {}) });
const r = (x: any) => (x?.mesh ? { ...x, mesh: brief(x.mesh) } : x);
async function main(): Promise<void> {
  const m: any = await getMeshio();
  m.FS.writeFile("/c.stl", new Uint8Array(fs.readFileSync("examples/STL/cube.stl")));
  const fine = m.refine(m.readMesh("/c.stl", "stl"), 2, false);
  const spec = { elements: [{ name: "top", fit: "plane", seeds: [[0, 0, 5]] }, { name: "bot", fit: "plane", seeds: [[0, 0, -5]] }, { name: "side", fit: "plane", seeds: [[5, 0, 0]] }], dimensions: [{ name: "height", type: "distance", between: ["top", "bot"], nominal: 10, tolerance: 0.1 }, { name: "ang", type: "angle", between: ["top", "side"], nominal: 90, tolerance: 0.5 }] };
  let measMesh: any; const meas = await attempt("measure", () => { const x = m.measure(fine, spec); measMesh = x.mesh; return { ...r(x), report: x.report }; });
  if (meas) {
    await attempt("alignDatums", () => r(m.alignDatums(measMesh, "bot", "side")));
    await attempt("measureElementPrimitive", () => m.measureElementPrimitive(measMesh, "top"));
    await attempt("deviation element", () => { const x = m.pipeline ? undefined : undefined; return x; });
  }
  const seg = m.segment(fine, 30, 0, 0, 1, "", "patch", "primitive", 0.01);
  show("segment", brief(seg.mesh ?? seg));
  let fitMesh: any; const fp = await attempt("fitPrimitives", () => { const x = m.fitPrimitives(seg.mesh, "segment:patch", 0.01, true, 0.9, undefined, 20); fitMesh = x.mesh; return r(x); });
  const fm = fp ? fitMesh : undefined;
  if (fm) {
    await attempt("constrainPrimitives", () => r(m.constrainPrimitives(fm, {})));
    await attempt("writeStepElements", () => { const x = m.writeStepElements("/e.step", fm, {}); return { ...x, bytes: m.FS.readFile("/e.step").length }; });
    await attempt("deviation primitive from fit", () => { const x = m.deviation(fine, { primitive: { type: "plane", params: [0, 0, 1, 0, 0, 5, 0, 0, 0, 0] } }); return { max: x.max, min: x.min }; });
  }
  const sec = m.sections(fine, [0, 0, 1], [5], {});
  const fc = m.fitCurves(sec, {});
  await attempt("profileSolid", () => r(m.profileSolid(fc.mesh, "extrude:10", {})));
  await attempt("profileSolid fillet", () => r(m.profileSolid(fc.mesh, "extrude:10;fillet:0.5", {})));
  const it = m.fitCadIterate(fine, { maxRounds: 2 });
  await attempt("faceSupport", () => r(m.faceSupport(it.mesh, fine, {})));
  await attempt("pipeline thickness op", () => { const x = m.pipeline ?? null; return typeof x; });
  await attempt("segment region", () => { const x = m.segment(fine, 30, 0, 0, 1, "nope", "patch"); return brief(x.mesh ?? x); });
}
main().then(() => process.exit(0), (e) => { console.error("fatal", e?.message ?? e); process.exit(1); });
