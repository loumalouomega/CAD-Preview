/** Roadmap 2.23: variable fillet over a 3-edge U chain on a 20 mm cube, via the shipped applyEditsBRep path.
 * Chain order given scrambled must not matter; a disjoint pair must be refused (applied:false). */
import { getOcct } from "../../../src/occtService";
import { collectEdges, bboxCenter, applyEditsBRep } from "../../../src/occtOperations";
import { volumePropertiesAdaptive } from "../../../src/brepGProp";

console.log = console.error.bind(console);
type Del = { delete(): void };

async function main(): Promise<void> {
  const oc: any = await getOcct(process.cwd()); // eslint-disable-line @typescript-eslint/no-explicit-any
  const cleanup: Del[] = [];
  const p1 = new oc.gp_Pnt_3(0, 0, 0), p2 = new oc.gp_Pnt_3(20, 20, 20); cleanup.push(p1, p2);
  const box = new oc.BRepPrimAPI_MakeBox_3(p1, p2); cleanup.push(box);
  const cube = box.Shape(); cleanup.push(cube);
  const edges = collectEdges(oc, cube, cleanup);
  const centres = edges.map((e: any) => bboxCenter(oc, e, cleanup)); // eslint-disable-line @typescript-eslint/no-explicit-any
  const idOf = (c: number[]): string => `edge-${centres.findIndex((q: number[]) => Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]) < 1e-3)}`;
  // U on the z=0 face: x=0 edge (0,10,0), y=0 edge (10,0,0)... use three of the four bottom edges.
  const u = [idOf([10, 0, 0]), idOf([20, 10, 0]), idOf([10, 20, 0])];
  const vol = (s: any): number => { const g = new oc.GProp_GProps_1(); cleanup.push(g); volumePropertiesAdaptive(oc, s, g); return g.Mass(); }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const run = (ops: any[]): { v: number; outcomes: any[] } => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const outcomes: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = applyEditsBRep(oc, cube, ops, cleanup, outcomes);
    return { v: vol(r), outcomes };
  };
  const out = {
    u,
    base: vol(cube),
    c2: run([{ op: "fillet", edges: u, radius: 2 }]).v,
    c6: run([{ op: "fillet", edges: u, radius: 6 }]).v,
    var: run([{ op: "fillet", edges: u, radius: 2, radius2: 6 }]),
    varScrambled: run([{ op: "fillet", edges: [u[2], u[0], u[1]], radius: 2, radius2: 6 }]),
    varReversed: run([{ op: "fillet", edges: [u[2], u[1], u[0]], radius: 2, radius2: 6 }]),
    disjoint: run([{ op: "fillet", edges: [idOf([10, 0, 0]), idOf([10, 20, 20])], radius: 2, radius2: 6 }]),
  };
  console.error(JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
