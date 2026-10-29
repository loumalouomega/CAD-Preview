/** meshio++ 17.23 probe: the operations and options added in 17.22–17.23.
 * Run: npm run probe -- scripts/probe/examples/meshio-1723.ts --run   (JSON on stderr)
 * Exit 0 means the probe completed, not that any gate passed.
 */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";

console.log = console.error.bind(console);
const out = (o: unknown): void => { console.error(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? Number(v) : v))); };
const trunc = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 220);
function counts(mesh: any): Record<string, number> {
  const c: Record<string, number> = {};
  for (const b of mesh.cells) c[b.type] = (c[b.type] ?? 0) + Math.floor(b.data.length / (b.nodesPerCell ?? 1));
  return c;
}
function tryRun(label: string, f: () => any, pick: (r: any) => unknown): any {
  const t = Date.now();
  try { const r = f(); out({ label, ms: Date.now() - t, ...(pick(r) as object) }); return r; }
  catch (e) { out({ label, error: trunc(e) }); return null; }
}

async function main(): Promise<void> {
  const m: any = await getMeshio();
  out({ hasNetgen: m.hasNetgen?.(), hasMmg: m.hasMmg?.(), hasKahip: m.hasKahip?.() });
  for (const [name, file, size] of [["block", "examples/STP/block.stp", 1], ["bull", "examples/STP/bull.stp", 3]] as const) {
    m.FS.writeFile("/mc.stp", fs.readFileSync(file));
    const info: any = (m.readMeshSelective("/mc.stp", { format: "step", info: true }) as any).info;
    const mc = (o: Record<string, unknown>) => m.meshCadSurface(info, { edges: false, targetSize: size, ...o });
    const pickMc = (r: any) => ({ name, cells: counts(r.mesh), tri: r.numTriangles, quads: r.numQuads, open: r.numOpenEdges, minA: +(r.minAngleDeg ?? 0).toFixed(2), warnings: r.warnings });
    const base = tryRun(`${name}:base`, () => mc({}), pickMc);
    tryRun(`${name}:quads-dominant`, () => mc({ quads: "dominant" }), pickMc);
    tryRun(`${name}:quads-all`, () => mc({ quads: "all" }), pickMc);
    tryRun(`${name}:quads-greedy`, () => mc({ quads: "dominant", quadPairs: "greedy" }), pickMc);
    tryRun(`${name}:quads-o2`, () => mc({ quads: "dominant", order: 2 }), pickMc);
    tryRun(`${name}:untangle-o2`, () => mc({ order: 2, untangle: true }), pickMc);
    tryRun(`${name}:reparam-o2`, () => mc({ order: 2, reparamConditionNumber: 5 }), pickMc);
    tryRun(`${name}:virtual-o2`, () => mc({ order: 2, virtualFaces: true }), pickMc);
    if (!base) continue;

    // octreeMesh hexGrading
    const skinMesh = base.mesh;
    for (const g of ["uniform", "graded"]) {
      tryRun(`${name}:octreeMesh-hex-${g}`, () => m.octreeMesh(skinMesh, { output: "hex", maxSize: size * 2, minSize: size / 2, hexGrading: g, maxCells: 2e6 }),
        (r: any) => ({ cells: counts(r.mesh ?? r), keys: Object.keys(r).slice(0, 14), warnings: r.warnings }));
    }

    // tetrahedralize / checkConformity / errorSize / boundaryLayer / extrude / revolve / mirror
    const tet = tryRun(`${name}:tetrahedralize`, () => m.tetrahedralize(skinMesh, { backend: "auto", maxSize: size * 2 }),
      (r: any) => ({ backend: r.backend, tets: r.numTetrahedra, volume: r.volume, preserved: r.boundaryPreserved, dihedral: [r.minDihedralDeg, r.maxDihedralDeg], warnings: r.warnings }));
    const vol = tet?.mesh;
    if (vol) {
      tryRun(`${name}:checkConformity`, () => m.checkConformity(vol), (r: any) => ({ conforming: r.conforming, dim: r.dimension, hang: r.numHangingNodes, tj: r.numTJunctions, mode: r.interfaceMode }));
      tryRun(`${name}:estimateError+errorSize`, () => {
        const m2: any = m.estimateError ? m.estimateError(vol, {}) : null;
        return m.errorSize(m2?.mesh ?? vol, { targetError: 0.1 });
      }, (r: any) => ({ keys: Object.keys(r) }));
      tryRun(`${name}:boundaryLayer-3d`, () => m.boundaryLayer(skinMesh, { firstHeight: size * 0.05, numLayers: 3 }),
        (r: any) => ({ cells: counts(r.mesh), shrunk: r.numShrunk, minSJ: r.minScaledJacobian, thickness: [r.minThickness, r.maxThickness], warnings: r.warnings }));
    }
    tryRun(`${name}:mirror`, () => m.mirror(skinMesh, { normal: [1, 0, 0], keepOriginal: true }),
      (r: any) => ({ cells: counts(r.mesh), flipped: r.numFlippedCells, onPlane: r.numPointsOnPlane }));
    tryRun(`${name}:extrude`, () => m.extrude(skinMesh, { direction: [0, 0, 1], numLayers: 2 }), (r: any) => ({ cells: counts(r.mesh), minSJ: r.minScaledJacobian, warnings: r.warnings }));
    tryRun(`${name}:revolve`, () => m.revolve(skinMesh, { angle: 90, numLayers: 4 }), (r: any) => ({ cells: counts(r.mesh), minSJ: r.minScaledJacobian, warnings: r.warnings }));

    // projectToCad: perturb the surface mesh then snap it back onto the CAD side channel
    const pts = base.mesh.points as Float64Array;
    const noisy = { ...base.mesh, points: Float64Array.from(pts, (v: number, i: number) => v + ((i * 2654435761) % 1000 / 1000 - 0.5) * size * 0.02) };
    tryRun(`${name}:projectToCad`, () => m.projectToCad(noisy, info, {}),
      (r: any) => ({ projected: r.numProjected, onEdges: r.numOnEdges, failed: r.numFailed, tooFar: r.numTooFar, maxMove: r.maxMove, warnings: r.warnings }));
  }
}
main().catch((e) => { out({ fatal: trunc(e) }); }).finally(() => process.exit(0));
