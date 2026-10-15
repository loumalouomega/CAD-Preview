/**
 * meshio++ `checkQuality` probe — call shape and result facts on a Gmsh mesh.
 *
 *   npm run probe -- scripts/probe/examples/check-quality.ts --run
 */
import * as fs from "fs";
import { generateMesh } from "../../../src/gmshService";
import { getMeshio } from "../../../src/meshioService";
import { DEFAULT_MESH_OPTIONS } from "../../../src/meshOptions";
import { kernelVersions } from "../../../src/kernelVersions";

async function main(): Promise<void> {
  console.error(JSON.stringify(await kernelVersions(process.cwd())));
  const meshed = await generateMesh(
    process.cwd(),
    { kind: "brep", stepBytes: fs.readFileSync("examples/STP/block.stp") } as never,
    { ...DEFAULT_MESH_OPTIONS, dimension: 3, sizeMin: 0, sizeMax: 1.5 },
    []
  );
  const m: any = await getMeshio();
  m.FS.writeFile("/in.msh", Buffer.from(meshed.mshText, "utf8"));
  const mesh = m.readMesh("/in.msh", "gmsh");
  const show = (label: string, f: () => unknown) => {
    try {
      const r: any = f();
      console.log(label, JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
    } catch (e) {
      console.log(label, "THROWS", String((e as Error).message));
    }
  };
  show("lenient", () => m.checkQuality(mesh, "scaled_jacobian >= 0.01", 0, 0));
  show("strict", () => m.checkQuality(mesh, "scaled_jacobian >= 0.99", 0, 0));
  show("fraction", () => m.checkQuality(mesh, "scaled_jacobian >= 0.99 @ 100%", 0, 0));
  show("two", () => m.checkQuality(mesh, "scaled_jacobian >= 0.2; aspect_ratio <= 5 @ 1%", 0, 0));
  show("empty", () => m.checkQuality(mesh, "", 0, 0));
  show("negdisable", () => m.checkQuality(mesh, "", -1, -1));
  show("badmetric", () => m.checkQuality(mesh, "bogus >= 1", 0, 0));
  show("badsyntax", () => m.checkQuality(mesh, "scaled_jacobian ~ ~", 0, 0));
}
main().catch((e) => { console.error(e); process.exit(1); });
