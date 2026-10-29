/** Probe: meshcad engine + MeshOptions.prismLayers through generateMesh / exportMdpa on block.stp. */
import * as fs from "fs";
import { generateMesh } from "../../../src/gmshService";
import { validateMeshOptions } from "../../../src/meshOptions";

console.log = console.error.bind(console);
const out = (o: unknown): void => { console.error(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? Number(v) : v))); };
async function main(): Promise<void> {
  const stepBytes = new Uint8Array(fs.readFileSync("examples/STP/block.stp"));
  const options = validateMeshOptions({ engine: "meshcad", dimension: 2, sizeMax: 1, prismLayers: { firstHeight: 0.05, numLayers: 3, growth: 1.2 } })!;
  out({ dimension: options.dimension, prism: options.prismLayers });
  const r: any = await generateMesh(process.cwd(), { kind: "brep", stepBytes } as any, options, []);
  out({ engineUsed: r.engineUsed, elementCount: r.elementCount, nodes: r.nodeCount ?? r.nodes?.length, quality: r.quality && Object.keys(r.quality), prism: r.meshcad?.prismLayers, warnings: r.warnings });
}
main().catch((e) => out({ fatal: String(e?.stack ?? e).slice(0, 600) })).finally(() => process.exit(0));
