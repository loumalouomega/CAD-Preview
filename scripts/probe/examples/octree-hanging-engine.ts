/** Roadmap 4.18 end-to-end probe: `engine: "octree"`, `octreeTransition: "hanging"`
 * through generateMesh / exportMdpa.
 * Run: npm run probe -- scripts/probe/examples/octree-hanging-engine.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that the gate passed.
 *
 * block.stp (B-rep, volume 60, surface area 94) and cube.stl (volume 1000, area 600):
 * element mix (all hexahedra), summed volume, the constraints the result
 * reports, the displayed boundary area (must equal the true surface — a
 * coarse/fine interface drawn as boundary would add to it), the link count, and
 * the MDPA the same request writes (Constraints blocks, ids resolve, patch test).
 */
import * as fs from "fs";
import { generateMesh, exportMdpa } from "../../../src/gmshService";
import { DEFAULT_MESH_OPTIONS } from "../../../src/meshOptions";

console.log = console.error.bind(console);

function triArea(pos: Float32Array, idx: Uint32Array): number {
  let a = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [i, j, k] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const u = [pos[j] - pos[i], pos[j + 1] - pos[i + 1], pos[j + 2] - pos[i + 2]];
    const v = [pos[k] - pos[i], pos[k + 1] - pos[i + 1], pos[k + 2] - pos[i + 2]];
    a += 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  }
  return a;
}

async function main(): Promise<void> {
  const out: Record<string, unknown> = {};
  const ext = process.cwd();
  const cases: Array<[string, any, number, number]> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ["block-brep", { kind: "brep", stepBytes: fs.readFileSync("examples/STP/block.stp") }, 60, 94],
    ["cube-stl", { kind: "stl", stlBytes: fs.readFileSync("examples/STL/cube.stl") }, 1000, 600],
  ];
  for (const [name, input, volume, area] of cases) {
    const row: Record<string, unknown> = { knownVolume: volume, knownArea: area };
    try {
      const options = { ...DEFAULT_MESH_OPTIONS, engine: "octree" as const, octreeMaxLevel: 4, octreeTransition: "hanging" as const };
      const t0 = Date.now();
      const r = await generateMesh(ext, input, options, []);
      row.ms = Date.now() - t0;
      row.octree = r.octree;
      row.warnings = r.warnings;
      row.nodeCount = r.nodeCount;
      row.elementCount = r.elementCount;
      row.displayedBoundaryArea = triArea(r.positions, r.indices);
      row.linkSegments = (r.constraintLinks?.length ?? 0) / 2;
      const mdpa = await exportMdpa(ext, input, options, [], "elements");
      row.mdpaConstraintBlocks = mdpa.match(/^Begin Constraints .*$/gm)?.length;
      row.mdpaElementBlocks = [...new Set(mdpa.match(/Begin Elements \w+/g) ?? [])];
      row.mdpaHangingPart = /Begin SubModelPart HangingNodes/.test(mdpa);
      fs.writeFileSync(`/tmp/${name}-hanging.mdpa`, mdpa);
    } catch (e) {
      row.error = String((e as Error)?.message ?? e).slice(0, 400);
    }
    out[name] = row;
  }
  console.error(JSON.stringify(out, null, 2));
}

main().then(() => process.exit(0), () => process.exit(0));
