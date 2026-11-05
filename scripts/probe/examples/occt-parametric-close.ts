/** Roadmap 2.28 "Parametric-curve profile" probe: addParametricCurve { close: true } -> face -> extrude.
 * Run: npm run probe -- scripts/probe/examples/occt-parametric-close.ts --run
 * Fresh block.stp (12 edges, 6 faces): curve edges start at edge-12. JSON on stderr.
 */
import * as fs from "fs";
import { getOcct, readShape } from "../../../src/occtService";
import { applyEditsBRep, collectFaces, collectSolids } from "../../../src/occtOperations";
import { resolveEditOps } from "../../../src/editVariables";
import { validateEditOp, type EditOp, type OpOutcome } from "../../../src/editOps";
import { volumePropertiesAdaptive, surfacePropertiesAdaptive } from "../../../src/brepGProp";

console.log = console.error.bind(console);
type Del = { delete(): void };
const out = (o: unknown) => console.error(JSON.stringify(o));

async function main() {
  const oc = await getOcct(process.cwd());
  const cases: Array<[string, Record<string, unknown>, number]> = [
    // full period: a figure-8 touching its closing segment at s = 0.5
    ["full-period-41", { x: "s", y: "0.1*sin(360*s)", sMin: 0, sMax: 1, samples: 41 }, 2 * 0.1 / Math.PI],
    ["full-period-40", { x: "s", y: "0.1*sin(360*s)", sMin: 0, sMax: 1, samples: 40 }, 2 * 0.1 / Math.PI],
    ["half-period", { x: "s", y: "0.1*sin(360*s)", sMin: 0, sMax: 0.5, samples: 21 }, 0.1 / Math.PI],
    ["parabola", { x: "s", y: "0.5 + 0.3*s*(1-s)", sMin: 0, sMax: 1, samples: 24 }, 0.3 / 6],
    ["control-triangle", { x: "s", y: "s*(1-s)", sMin: 0, sMax: 1, samples: 3, as: "polyline" }, 0.125],
    ["half-period-81", { x: "s", y: "0.1*sin(360*s)", sMin: 0, sMax: 0.5, samples: 81 }, 0.1 / Math.PI],
    ["half-period-poly-81", { x: "s", y: "0.1*sin(360*s)", sMin: 0, sMax: 0.5, samples: 81, as: "polyline" }, 0.1 / Math.PI],
  ];
  for (const [name, params, area] of cases) {
    const c: Del[] = [];
    try {
      oc.FS.writeFile("/b.stp", fs.readFileSync("examples/STP/block.stp"));
      const box = readShape(oc, "/b.stp", "step", c);
      const raw = validateEditOp({ op: "addParametricCurve", close: true, ...params });
      if (!raw) { out({ name, error: "validate" }); continue; }
      const { ops } = resolveEditOps([raw], {});
      const outcomes: OpOutcome[] = [];
      const withCurve = applyEditsBRep(oc, box, ops, c, outcomes);
      const faces = collectFaces(oc, withCurve, c);
      const fp = new oc.GProp_GProps_1(); c.push(fp);
      surfacePropertiesAdaptive(oc, faces[faces.length - 1].face ?? faces[faces.length - 1], fp);
      out({ name, faces: faces.length, faceArea: fp.Mass(), expectedArea: area });
      const ex = { op: "extrude", profile: "face-6", dir: [0, 0, 1], length: 2 } as unknown as EditOp;
      const outcomes2: OpOutcome[] = [];
      const solid = applyEditsBRep(oc, box, [...ops, ex], c, outcomes2);
      const p = new oc.GProp_GProps_1(); c.push(p);
      const bp = new oc.GProp_GProps_1(); c.push(bp);
      volumePropertiesAdaptive(oc, solid, p); volumePropertiesAdaptive(oc, box, bp);
      const sols = collectSolids(oc, solid, c);
      const vols = sols.map((x: any) => { const q = new oc.GProp_GProps_1(); c.push(q); volumePropertiesAdaptive(oc, x.solid ?? x, q); return q.Mass(); });
      out({ name, vols });
      out({ name, outcomes2, volumeDelta: p.Mass() - bp.Mass(), expected: area * 2 });
    } catch (e) { out({ name, error: typeof e === "number" ? `raw:${e}` : String((e as Error)?.message ?? e).slice(0, 300) }); }
    finally { for (let i = c.length - 1; i >= 0; i--) { try { c[i].delete(); } catch { /* ignore */ } } }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
