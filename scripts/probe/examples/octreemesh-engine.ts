/** Roadmap 2.24 end-to-end probe: `engine: "octreemesh"` through generateMesh / exportMdpa.
 * Run: npm run probe -- scripts/probe/examples/octree-engine.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that the gate passed.
 *
 * Meshes block.stp (B-rep, volume 60), bull.stp (curved) and cube.stl (mesh
 * source, volume 1000) with the octree engine, and records the engine used,
 * element mix, quality, parity of the summed cell volumes with the known
 * volume (cell volumes from the MSH text via the three classes' tet
 * decompositions), the MDPA the same request writes, and the refusals.
 */
import * as fs from "fs";
import { generateMesh, exportMdpa } from "../../../src/gmshService";
import { DEFAULT_MESH_OPTIONS } from "../../../src/meshOptions";

console.log = console.error.bind(console);
type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const tripleVol = (o: V, a: V, b: V, c: V): number => {
  const u = sub(a, o), v = sub(b, o), w = sub(c, o);
  return (u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0])) / 6;
};

/** Sum of signed cell volumes from MSH 4.1 text (tet exact; pyramid = 2 tets; hex = 6 tets about a diagonal). */
function mshVolume(msh: string): { volume: number; negative: number; byType: Record<string, number> } {
  const lines = msh.split("\n");
  const nodes = new Map<number, V>();
  let i = lines.indexOf("$Nodes") + 1;
  const [blocks] = lines[i++].split(" ").map(Number);
  for (let b = 0; b < blocks; b++) {
    const [, , , n] = lines[i++].split(" ").map(Number);
    const tags = lines.slice(i, i + n).map(Number);
    i += n;
    for (let k = 0; k < n; k++) {
      const [x, y, z] = lines[i++].split(" ").map(Number);
      nodes.set(tags[k], [x, y, z]);
    }
  }
  let j = lines.indexOf("$Elements") + 1;
  const [eb] = lines[j++].split(" ").map(Number);
  let volume = 0, negative = 0;
  const byType: Record<string, number> = {};
  for (let b = 0; b < eb; b++) {
    const [dim, , type, n] = lines[j++].split(" ").map(Number);
    for (let k = 0; k < n; k++) {
      const row = lines[j++].split(" ").map(Number).slice(1);
      if (dim !== 3) continue;
      const P = row.map((t) => nodes.get(t)!);
      let vol = 0;
      if (type === 4) vol = tripleVol(P[0], P[1], P[2], P[3]);
      if (type === 7) {
        // exact pyramid volume: split the base quad into two triangles, each with the apex.
        vol = tripleVol(P[0], P[1], P[2], P[4]) + tripleVol(P[0], P[2], P[3], P[4]);
      }
      if (type === 5) {
        // hex = sum of 6 tets around the 0-6 diagonal (exact for a parallelepiped-like cell).
        const t = [[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]];
        vol = t.reduce((a, q) => a + tripleVol(P[q[0]], P[q[1]], P[q[2]], P[q[3]]), 0);
      }
      byType[String(type)] = (byType[String(type)] ?? 0) + 1;
      if (vol <= 0) negative++;
      volume += vol;
    }
  }
  return { volume, negative, byType };
}

const OUT = (process.env.OCTREEMESH_OUTPUT === "hex" ? "hex" : "tet") as "tet" | "hex";

async function main(): Promise<void> {
  const out: Record<string, unknown> = {};
  const ext = process.cwd();
  const cases: Array<[string, any, number | null]> = [
    ["block-brep", { kind: "brep", stepBytes: fs.readFileSync("examples/STP/block.stp") }, 60],
    ["bull-brep", { kind: "brep", stepBytes: fs.readFileSync("examples/STP/bull.stp") }, null],
    ["cube-stl", { kind: "stl", stlBytes: fs.readFileSync("examples/STL/cube.stl") }, 1000],
  ];
  for (const [name, input, known] of cases) {
    const row: Record<string, unknown> = {};
    try {
      const t0 = Date.now();
      const r = await generateMesh(ext, input, { ...DEFAULT_MESH_OPTIONS, engine: "octreemesh", octreeMeshOutput: OUT }, []);
      row.ms = Date.now() - t0;
      row.engineUsed = r.engineUsed;
      row.nodeCount = r.nodeCount;
      row.elementCount = r.elementCount;
      row.octreeMesh = r.octreeMesh && { ...r.octreeMesh, warnings: undefined };
      row.warnings = r.warnings;
      row.quality = r.quality ? { min: r.quality.min, mean: r.quality.mean } : null;
      row.boundaryTriangles = r.indices.length / 3;
      const mv = mshVolume(r.mshText);
      row.volume = Math.round(mv.volume * 1000) / 1000;
      row.knownVolume = known;
      row.negativeCells = mv.negative;
      row.mshTypes = mv.byType;
      const mdpa = await exportMdpa(ext, input, { ...DEFAULT_MESH_OPTIONS, engine: "octreemesh", octreeMeshOutput: OUT }, [], "elements").catch((e: Error) => `ERR ${e.message}`);
      row.mdpa = mdpa.startsWith("ERR ")
        ? mdpa
        : { chars: mdpa.length, elementBlocks: [...new Set(mdpa.match(/Begin Elements \w+/g) ?? [])] };
    } catch (e) {
      row.error = String((e as Error)?.message ?? e).slice(0, 400);
    }
    out[name] = row;
  }
  // Refusals and downgrades.
  const stepBytes = fs.readFileSync("examples/STP/block.stp");
  const brep = { kind: "brep" as const, stepBytes };
  for (const [name, opts] of [
    ["elementOrder2", { elementOrder: 2 as const }],
    ["periodic", { periodic: [{ slave: "a", master: "b", translation: [1, 0, 0] as [number, number, number] }] }],
    ["dim2", { dimension: 2 as const }],
  ] as Array<[string, object]>) {
    try {
      const r = await generateMesh(ext, brep, { ...DEFAULT_MESH_OPTIONS, engine: "octreemesh", ...opts }, []);
      out[`refuse-${name}`] = { engineUsed: r.engineUsed, warnings: r.warnings };
    } catch (e) {
      out[`refuse-${name}`] = { threw: String((e as Error).message).slice(0, 200) };
    }
  }
  console.error(JSON.stringify(out, null, 2));
}

main().then(() => process.exit(0), () => process.exit(0));
