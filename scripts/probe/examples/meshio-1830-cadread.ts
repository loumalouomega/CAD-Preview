/** Live probe of the meshio++ 18.3 `cadRead` option of readMeshSelective (STEP/IGES, full artifact).
 * Run: npm run probe -- scripts/probe/examples/meshio-1830-cadread.ts --run */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";
console.log = console.error.bind(console);
const show = (label: string, v: unknown): void => console.error(label, JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : ArrayBuffer.isView(x) ? `${(x as any).constructor.name}[${(x as any).length}]` : x)).slice(0, 900));
async function main(): Promise<void> {
  const m: any = await getMeshio();
  for (const file of ["examples/STP/block.stp", "examples/STP/bull.stp"]) {
    m.FS.writeFile("/a.step", new Uint8Array(fs.readFileSync(file)));
    for (const [label, cadRead] of [["default", undefined], ["heal", { heal: true }], ["sew", { sewTolerance: 1e-3 }], ["coarse", { deflection: 5, angularDeflection: 1 }], ["bad", { deflection: -1 }]] as const) {
      try {
        const r = m.readMeshSelective("/a.step", { format: "step", info: true, ...(cadRead ? { cadRead } : {}) });
        const info = r.info;
        show(`${file} ${label}`, { pts: r.points.length / 3, cells: r.cells.map((b: any) => [b.type, b.data.length]), infoFormat: info?.format, faces: info?.faces?.length, extraType: typeof info?.extra, extra: typeof info?.extra === "string" ? info.extra.slice(0, 400) : info?.extra });
      } catch (e) { console.error(`FAIL ${file} ${label}:`, (e as Error)?.message ?? e); }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
