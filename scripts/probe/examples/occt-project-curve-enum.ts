/** Roadmap 3.9 step 0: enumerate BRepProj_Projection bindings.
 * Run: npm run probe -- scripts/probe/examples/occt-project-curve-enum.ts --run */
import { getOcct } from "../../../src/occtService";
console.log = console.error.bind(console);
async function main(): Promise<void> {
  const oc: any = await getOcct(process.cwd());
  const ctors = Object.keys(oc).filter((k) => k.startsWith("BRepProj_Projection"));
  const proto = oc.BRepProj_Projection ? Object.getOwnPropertyNames(oc.BRepProj_Projection.prototype) : [];
  console.error(JSON.stringify({ ctors, proto }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
