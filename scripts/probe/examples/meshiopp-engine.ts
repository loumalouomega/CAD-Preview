/** meshio++ 20.1 full volume chain (`engine: "meshiopp"`) probe.
 * Run: npm run probe -- scripts/probe/examples/meshiopp-engine.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that the gate passed.
 *
 * Chain: exact surface (meshCadSurface for a B-rep, the source skin for a mesh)
 * -> octree tets -> adaptVolume. Meshes block.stp (volume 60), bull.stp
 * (curved) and cube.stl (volume 1000) through generateMesh, records the stats,
 * the enclosed volume from the MSH text, the quality summary and the time;
 * then the size/level knobs, the closure gate (an STL with a dropped
 * triangle), the adapter's own rejection counters, and the refusals.
 */
import * as fs from "fs";
import { generateMesh } from "../../../src/gmshService";
import { DEFAULT_MESH_OPTIONS } from "../../../src/meshOptions";

console.log = console.error.bind(console);
type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const tripleVol = (o: V, a: V, b: V, c: V): number => {
  const u = sub(a, o), v = sub(b, o), w = sub(c, o);
  return (u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0])) / 6;
};

/** Sum of signed tetra volumes from MSH 4.1 text (type 4 only — the chain emits tets). */
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
      byType[String(type)] = (byType[String(type)] ?? 0) + 1;
      if (dim !== 3) continue;
      const P = row.map((t) => nodes.get(t)!);
      const vol = type === 4 ? tripleVol(P[0], P[1], P[2], P[3]) : 0;
      if (vol <= 0) negative++;
      volume += vol;
    }
  }
  return { volume, negative, byType };
}

/** Drops one triangle from an ASCII STL — an open shell for the closure gate. */
function openStl(bytes: Uint8Array): Uint8Array {
  const text = Buffer.from(bytes).toString("utf8");
  const start = text.indexOf("facet normal");
  const end = text.indexOf("endfacet", start);
  if (start < 0 || end < 0) throw new Error("probe: expected an ASCII STL");
  return new TextEncoder().encode(text.slice(0, start) + text.slice(end + "endfacet".length));
}

async function main(): Promise<void> {
  const out: Record<string, unknown> = {};
  const ext = process.cwd();
  const blockStep = fs.readFileSync("examples/STP/block.stp");
  const cases: Array<[string, any, number | null, object]> = [
    ["block-brep", { kind: "brep", stepBytes: blockStep }, 60, {}],
    ["block-brep-l1", { kind: "brep", stepBytes: blockStep }, 60, { octreeMeshLevels: 1 }],
    ["block-brep-size1", { kind: "brep", stepBytes: blockStep }, 60, { sizeMax: 1 }],
    ["block-brep-auto", { kind: "brep", stepBytes: blockStep }, 60, { sizeMax: 0 }],
    ["bull-brep", { kind: "brep", stepBytes: fs.readFileSync("examples/STP/bull.stp") }, null, {}],
    ["cube-stl", { kind: "stl", stlBytes: fs.readFileSync("examples/STL/cube.stl") }, 1000, {}],
  ];
  for (const [name, input, known, overrides] of cases) {
    const row: Record<string, unknown> = {};
    try {
      const t0 = Date.now();
      const r = await generateMesh(ext, input, { ...DEFAULT_MESH_OPTIONS, engine: "meshiopp", sizeMax: 2, octreeMeshLevels: 2, ...overrides }, []);
      row.ms = Date.now() - t0;
      row.engineUsed = r.engineUsed;
      row.nodeCount = r.nodeCount;
      row.elementCount = r.elementCount;
      row.meshiopp = r.meshiopp && { ...r.meshiopp, warnings: undefined };
      row.warnings = r.warnings;
      row.quality = r.quality ? { min: r.quality.min, mean: r.quality.mean } : null;
      row.boundaryTriangles = r.indices.length / 3;
      const mv = mshVolume(r.mshText);
      row.volume = Math.round(mv.volume * 1000) / 1000;
      row.knownVolume = known;
      row.negativeCells = mv.negative;
      row.mshTypes = mv.byType;
    } catch (e) {
      row.error = String((e as Error)?.message ?? e).slice(0, 500);
    }
    out[name] = row;
  }

  // Closure gate: a cube with one triangle removed is an open shell.
  try {
    const cube = fs.readFileSync("examples/STL/cube.stl");
    const r = await generateMesh(ext, { kind: "stl", stlBytes: openStl(cube) }, { ...DEFAULT_MESH_OPTIONS, engine: "meshiopp", sizeMax: 2 }, []);
    out["open-cube"] = { engineUsed: r.engineUsed, elementCount: r.elementCount };
  } catch (e) {
    out["open-cube"] = { threw: String((e as Error).message).slice(0, 300) };
  }

  // Refusals and downgrades.
  for (const [name, opts] of [
    ["elementOrder2", { elementOrder: 2 as const }],
    ["hexDominant", { elementShape: "hexDominant" as const }],
    ["periodic", { periodic: [{ slave: "a", master: "b", translation: [1, 0, 0] as [number, number, number] }] }],
    ["sizeField", { sizeField: [{ point: [0, 0, 0] as [number, number, number], size: 1 }] }],
    ["refinementRegions", { refinementRegions: [{ kind: "sphere" as const, center: [0, 0, 0] as [number, number, number], radius: 5, sizeIn: 1, thickness: 1 }] }],
    ["dim2", { dimension: 2 as const }],
  ] as Array<[string, object]>) {
    try {
      const r = await generateMesh(ext, { kind: "brep" as const, stepBytes: blockStep }, { ...DEFAULT_MESH_OPTIONS, engine: "meshiopp", sizeMax: 2, ...opts }, []);
      out[`refuse-${name}`] = { engineUsed: r.engineUsed, warnings: r.warnings };
    } catch (e) {
      out[`refuse-${name}`] = { threw: String((e as Error).message).slice(0, 250) };
    }
  }
  console.error(JSON.stringify(out, null, 2));
}

main().then(() => process.exit(0), () => process.exit(0));
