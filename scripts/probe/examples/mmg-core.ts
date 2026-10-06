/** Task's feasibility experiment, NOT a production remeshing API.
 * Run via npm run probe -- scripts/probe/examples/mmg-core.ts --run.
 * All diagnostics go to stderr; mmg-transport.mjs checks the real fd 1.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { Mmg } from "@loumalouomega/mmg-wasm";
import { getMeshio } from "../../../src/meshioService";
import { getGmsh } from "../../../src/gmshService";
import { tetrahedralize, tetsToMsh41 } from "../../../src/ftetwildService";
import { parseStl } from "../../../src/stlParser";
import { weldTriangleSoup } from "../../../src/meshComponents";
import { kernelVersions } from "../../../src/kernelVersions";

console.log = console.error.bind(console);
console.info = console.error.bind(console);
console.warn = console.error.bind(console);
console.debug = console.error.bind(console);

const requirePackage = createRequire(`${process.cwd()}/package.json`);
let singleton: Promise<Mmg> | null = null;
let generations = 0;
const logs: string[] = [];
function getMmg(): Promise<Mmg> {
  if (!singleton) {
    generations++;
    // Real require condition, not esbuild's ESM import condition. The
    // separately replaceable package remains outside the probe bundle.
    singleton = requirePackage("@loumalouomega/mmg-wasm")({
      wasmBinary: readFileSync(requirePackage.resolve("@loumalouomega/mmg-wasm/mmg-core.wasm")),
      print: (text: string) => logs.push(text),
      printErr: (text: string) => logs.push(text),
    }).catch((error: unknown) => { singleton = null; throw error; });
  }
  return singleton!;
}

type Mesh = { vertices: Float64Array; cells: Int32Array; refs: Int32Array };
function ensureHarvest(np: number, nc: number): void {
  if (np <= 0 || nc <= 0) throw new Error("MMG empty harvest");
}

async function remesh(input: Mesh, surface = false, optim = false, hausd = 0.01, hmax?: number): Promise<Mesh & { status: number }> {
  const mmg = await getMmg();
  const api = surface ? mmg.mmgs : mmg.mmg3d;
  const h = api.init();
  try {
    if (surface) mmg.mmgs.setMeshSize(h.mesh, input.vertices.length / 3, input.cells.length / 3, 0);
    else mmg.mmg3d.setMeshSize(h.mesh, input.vertices.length / 3, input.cells.length / 4, 0, 0, 0, 0);
    api.setVertices(h.mesh, input.vertices, null);
    if (surface) mmg.mmgs.setTriangles(h.mesh, input.cells, input.refs);
    else mmg.mmg3d.setTetrahedra(h.mesh, input.cells, input.refs);
    api.setIparameter(h.mesh, h.met, api.IPARAM_verbose, -1);
    api.setDparameter(h.mesh, h.met, api.DPARAM_hausd, hausd);
    if (hmax !== undefined) api.setDparameter(h.mesh, h.met, api.DPARAM_hmax, hmax);
    if (optim) api.setIparameter(h.mesh, h.met, api.IPARAM_optim, 1);
    const status = api.remesh(h.mesh, h.met);
    const size: { np: number; nt: number; ne?: number } = api.getMeshSize(h.mesh);
    const nc = surface ? size.nt : size.ne!;
    ensureHarvest(size.np, nc);
    const vertices = api.getVertices(h.mesh, size.np).vertices;
    const cells = surface ? mmg.mmgs.getTriangles(h.mesh, nc) : mmg.mmg3d.getTetrahedra(h.mesh, nc);
    return { vertices, cells: "tria" in cells ? cells.tria : cells.tetra, refs: cells.refs, status };
  } catch (error) {
    // STRONGFAILURE is an explicit wrapper error, not necessarily a WASM
    // abort. Reset on either; do not depend solely on the abort regex.
    singleton = null;
    throw error;
  } finally {
    api.free(h);
  }
}

function tetVolume(mesh: Mesh, reference?: number): number {
  let total = 0;
  for (let i = 0; i < mesh.cells.length; i += 4) {
    if (reference !== undefined && mesh.refs[i / 4] !== reference) continue;
    const p = Array.from(mesh.cells.slice(i, i + 4), index => Array.from(mesh.vertices.slice((index - 1) * 3, index * 3)));
    const [a, b, c] = p.slice(1).map(q => q.map((x, j) => x - p[0][j]));
    total += Math.abs(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return total;
}

function bounds(mesh: Mesh): number[][] {
  return [0, 1, 2].map(axis => {
    let min = Infinity, max = -Infinity;
    for (let i = axis; i < mesh.vertices.length; i += 3) { min = Math.min(min, mesh.vertices[i]); max = Math.max(max, mesh.vertices[i]); }
    return [min, max];
  });
}

function meanEdge(mesh: Mesh): number {
  const edges = new Set<string>();
  let total = 0;
  for (let i = 0; i < mesh.cells.length; i += 4) for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
    const u = mesh.cells[i + a] - 1, v = mesh.cells[i + b] - 1;
    const key = [u, v].sort((x, y) => x - y).join(",");
    if (edges.has(key)) continue;
    edges.add(key);
    total += Math.hypot(...[0, 1, 2].map(j => mesh.vertices[u * 3 + j] - mesh.vertices[v * 3 + j]));
  }
  return total / edges.size;
}

async function materialInput(): Promise<{ mesh: Mesh; names: string[] }> {
  const m = await getMeshio();
  m.FS.writeFile("/mmg.med", readFileSync("examples/MED/two-material-tets.med"));
  let raw: any;
  try { raw = m.readMesh("/mmg.med", "med"); } finally { m.FS.unlink("/mmg.med"); }
  assert.equal(raw.cells.length, 1);
  assert.equal(raw.cells[0].type, "tetra");
  const regions = raw.regions.filter((r: any) => r.kind === "cell");
  assert.equal(regions.length, 2);
  const cells = Int32Array.from(raw.cells[0].data, (n: any) => Number(n) + 1);
  const refs = new Int32Array(cells.length / 4);
  regions.forEach((r: any, index: number) => { for (const id of r.entries) { assert.equal(refs[Number(id)], 0); refs[Number(id)] = index + 1; } });
  assert(refs.every(n => n > 0));
  return { mesh: { vertices: raw.points, cells, refs }, names: regions.map((r: any) => r.name) };
}

async function quality(mesh: Mesh): Promise<number> {
  const gmsh = await getGmsh(process.cwd());
  gmsh.model.add("mmg-quality");
  try {
    gmsh.FS.writeFile("/mmg.msh", tetsToMsh41(mesh.vertices, Uint32Array.from(mesh.cells, n => n - 1)));
    try { gmsh.merge("/mmg.msh"); } finally { gmsh.FS.unlink("/mmg.msh"); }
    const tags = gmsh.model.mesh.getElements(3).elementTags.flat();
    assert(tags.length > 0);
    const q = gmsh.model.mesh.getElementQualities(tags, "minSICN").elementsQuality;
    assert.equal(q.length, tags.length);
    return Math.min(...q);
  } finally { gmsh.model.remove(); }
}

async function strongFailure(input: Mesh): Promise<string> {
  const mmg = await getMmg();
  const api = mmg.mmg3d;
  const h = api.init({ levelset: true });
  try {
    api.setMeshSize(h.mesh, input.vertices.length / 3, input.cells.length / 4, 0, 0, 0, 0);
    api.setVertices(h.mesh, input.vertices, null);
    api.setTetrahedra(h.mesh, input.cells, input.refs);
    api.setSolSize(h.mesh, h.ls!, mmg.MMG5_Vertex, input.vertices.length / 3, mmg.MMG5_Scalar);
    api.setScalarSols(h.ls!, Float64Array.from({ length: input.vertices.length / 3 }, (_, i) => input.vertices[i * 3] - 0.25));
    api.setIparameter(h.mesh, h.met, api.IPARAM_verbose, -1);
    api.setIparameter(h.mesh, h.met, api.IPARAM_numberOfMat, 1);
    api.setMultiMat(h.mesh, h.met, 1, 1, 3, 4); // ref 2 deliberately absent
    try { api.levelset(h.mesh, h.ls!, h.met); } catch (error) {
      assert.match(String(error), /STRONGFAILURE/);
      singleton = null;
      return String(error);
    }
    throw new Error("Missing material map did not produce STRONGFAILURE");
  } finally { api.free(h); }
}

export async function runMmgProbe(full = true): Promise<any> {
  const packagePath = resolve(dirname(requirePackage.resolve("@loumalouomega/mmg-wasm")), "../package.json");
  const facts: any = { versions: { ...kernelVersions(), mmg: JSON.parse(readFileSync(packagePath, "utf8")).version } };
  const { mesh: input, names } = await materialInput();
  const bbox = bounds(input);
  const hausd = Math.hypot(...bbox.map(([min, max]) => max - min)) * 0.005;
  const hmax = meanEdge(input) * 0.5;
  let start = performance.now();
  const output = await remesh(input, false, false, hausd, hmax);
  const outBounds = bounds(output);
  facts.volume = { ms: performance.now() - start, names, hausd, hmax, inputTets: input.cells.length / 4, outputTets: output.cells.length / 4, refs: [...new Set(output.refs)], inputVolume: tetVolume(input), outputVolume: tetVolume(output), bounds: outBounds, status: output.status };
  facts.volume.relativeError = Math.abs(facts.volume.outputVolume / facts.volume.inputVolume - 1);
  facts.volume.insideBounds = outBounds.every(([min, max], j) => min >= bbox[j][0] - 1e-12 && max <= bbox[j][1] + 1e-12);
  facts.volume.perReference = [1, 2].map(ref => ({ ref, before: tetVolume(input, ref), after: tetVolume(output, ref) }));
  assert.deepEqual(facts.volume.refs.sort(), [1, 2]);
  assert(facts.volume.insideBounds);
  assert(facts.volume.relativeError <= 1e-6);
  for (const { before, after } of facts.volume.perReference) assert(Math.abs(after / before - 1) <= 1e-6);
  const generation = generations;
  start = performance.now();
  facts.failure = { error: await strongFailure(input) };
  assert.equal(singleton, null);
  await remesh(input, false, false, hausd, hmax);
  assert.equal(generations, generation + 1);
  assert.throws(() => ensureHarvest(0, 1), /empty harvest/);
  assert.throws(() => ensureHarvest(1, 0), /empty harvest/);
  facts.failure.ms = performance.now() - start;
  facts.failure.resetAndRecovery = true;
  if (full) {
    start = performance.now();
    const skin = weldTriangleSoup(parseStl(readFileSync("examples/STL/holed-cube.stl")));
    const ft = await tetrahedralize(skin);
    const tets = { vertices: ft.vertices.slice(), cells: Int32Array.from(ft.tets, n => n + 1), refs: new Int32Array(ft.tets.length / 4).fill(1) };
    facts.optim = { ftetwildMs: performance.now() - start, before: await quality(tets) };
    start = performance.now();
    const optim = await remesh(tets, false, true);
    facts.optim.mmgMs = performance.now() - start;
    facts.optim.after = await quality(optim);
    facts.optim.inputTets = tets.cells.length / 4;
    facts.optim.outputTets = optim.cells.length / 4;
    facts.optim.status = optim.status;
    facts.optim.nonDecreasing = facts.optim.after >= facts.optim.before;
    start = performance.now();
    const sphere = weldTriangleSoup(parseStl(readFileSync("examples/STL/large-sphere-100k.stl")));
    const surf = { vertices: Float64Array.from(sphere.positions), cells: Int32Array.from(sphere.indices, n => n + 1), refs: new Int32Array(sphere.indices.length / 3).fill(1) };
    const coarse = await remesh(surf, true);
    let maxError = 0;
    for (let i = 0; i < coarse.vertices.length; i += 3) maxError = Math.max(maxError, Math.abs(Math.hypot(...coarse.vertices.slice(i, i + 3)) - 10));
    facts.surface = { ms: performance.now() - start, inputTriangles: sphere.indices.length / 3, outputTriangles: coarse.cells.length / 3, maxVertexRadialError: maxError, hausd: 0.01, withinBound: maxError <= 0.01, status: coarse.status };
    assert(facts.surface.outputTriangles < facts.surface.inputTriangles);
    assert(facts.surface.withinBound);
    facts.memory = [];
    start = performance.now();
    for (let i = 0; i < 20; i++) {
      await remesh(input, false, false, hausd, hmax);
      const mmg = await getMmg();
      facts.memory.push({ iteration: i + 1, ...process.memoryUsage(), wasmBytes: (mmg.module.HEAPU8 as Uint8Array).byteLength });
    }
    facts.repeatMs = performance.now() - start;
    facts.decision = facts.optim.nonDecreasing ? "pass-numerical-gates; transport still required" : "partial: optim does not guarantee non-decreasing minSICN";
  }
  facts.logLines = logs.length;
  // The raw worker check verifies real typed-array IPC, not just JSON facts.
  if (!full) facts.harvest = output;
  return facts;
}

if (process.argv.includes("--run")) {
  runMmgProbe().then(facts => { console.error(JSON.stringify(facts, null, 2)); process.exit(0); }, error => { console.error(error); process.exit(1); });
}
