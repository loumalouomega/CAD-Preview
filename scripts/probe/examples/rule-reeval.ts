/** Debug probe: does a plane-rule Part re-evaluate to include a coplanar face of an added box? */
import * as fs from "fs";
import { resolvePartSelectors } from "../../../src/entityFacts";
console.log = console.error.bind(console);
async function main() {
  const bytes = fs.readFileSync("examples/STP/block.stp");
  const ops: any[] = [
    { op: "addBox", center: [0, 0, 0], size: [100, 10, 10] },
    { op: "addBox", center: [-45, 20, 0], size: [10, 10, 10] },
  ];
  const sel = { version: 1, source: { kind: "scene", filter: [{ kind: "plane", point: [-50, 0, 0], normal: [1, 0, 0] }] } };
  const parts: any[] = [{ name: "R", color: "#f00", volumes: [], surfaces: ["face-6"], lines: [], points: [], selector: sel, selectorOpKind: "scene" }];
  const r = await resolvePartSelectors(process.cwd(), bytes, "step", ops, parts);
  console.error(JSON.stringify({ surfaces: r.parts[0].surfaces, resolved: r.resolved, frozen: r.frozen, warnings: r.warnings }));
}
main();
