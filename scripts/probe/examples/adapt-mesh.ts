/** Roadmap probe "Metric-driven adaptive remeshing from a field". NOT a product API.
 * Run: npm run probe -- scripts/probe/examples/adapt-mesh.ts --run   (diagnostics: JSON on stderr)
 *
 *   field f = exp(-|x-c|^2/sigma^2) on examples/MED/two-material-tets.med
 *   -> estimateError (ZZ indicator) -> size map -> mmg3d (scalar, then tensor metric)
 *   -> density near/far, conservativeInterpolate conservation, interpolation error.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Mmg } from "@loumalouomega/mmg-wasm";
import type { Mesh } from "@meshioplusplus/wasm";
import { getMeshio } from "../../../src/meshioService";
import { prepareMmgMesh } from "../../../src/mmgMesh";
import { getMmg } from "../../../src/mmgService";
import { getGmsh } from "../../../src/gmshService";

console.log = console.error.bind(console);
const out: Record<string, unknown> = {};

function tets(m: { positions: Float64Array; tet: Int32Array }): { centroid: number[]; volume: number; verts: number[] }[] {
  const res = [];
  for (let i = 0; i < m.tet.length; i += 4) {
    const v = [0, 1, 2, 3].map((j) => m.tet[i + j] - 1);
    const p = v.map((k) => [m.positions[3 * k], m.positions[3 * k + 1], m.positions[3 * k + 2]]);
    const a = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const b = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const c = [p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]];
    const vol = Math.abs(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    res.push({ centroid: [0, 1, 2].map((d) => (p[0][d] + p[1][d] + p[2][d] + p[3][d]) / 4), volume: vol, verts: v });
  }
  return res;
}

async function main(): Promise<void> {
  const meshio = await getMeshio();
  // two-material-tets.med has 2 tets (a uniform ZZ indicator, nothing to adapt), so the source
  // is a Gmsh mesh of examples/STP/block.stp (3x4x5) at a moderate size instead.
  const gmsh: any = await getGmsh(process.cwd());
  gmsh.clear(); gmsh.model.add("m");
  gmsh.FS.writeFile("/model.step", readFileSync("examples/STP/block.stp"));
  gmsh.model.occ.importShapes("/model.step"); gmsh.model.occ.synchronize();
  for (const k of ["General.NumThreads", "Mesh.MaxNumThreads1D", "Mesh.MaxNumThreads2D", "Mesh.MaxNumThreads3D"]) gmsh.option.setNumber(k, 1);
  gmsh.option.setNumber("Mesh.MeshSizeMax", Number(process.env.SRC_SIZE ?? 0.5)); gmsh.option.setNumber("Mesh.MeshSizeMin", 0);
  gmsh.option.setNumber("Mesh.SaveAll", 1); gmsh.option.setNumber("General.Verbosity", 1);
  gmsh.model.mesh.generate(3);
  gmsh.write("/o.msh");
  const mshText = gmsh.FS.readFile("/o.msh", { encoding: "utf8" }) as string;
  meshio.FS.writeFile("/a.msh", mshText);
  let mesh: Mesh;
  try { mesh = meshio.readMesh("/a.msh", "gmsh"); } finally { meshio.FS.unlink("/a.msh"); }
  // keep tetra only (the MSH also carries triangle/line/vertex blocks)
  mesh = { ...mesh, cells: mesh.cells.filter((b: any) => b.type === "tetra"), regions: [], cell_data: {}, cell_data_components: {}, point_data: {}, point_data_components: {}, field_data: {}, field_data_components: {} } as Mesh;
  const np = mesh.points.length / mesh.dim;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < np; i++) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], mesh.points[i * 3 + d]); hi[d] = Math.max(hi[d], mesh.points[i * 3 + d]); }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  // Peak a quarter of the way in so near/far shells both exist.
  const c = [lo[0] + 0.25 * (hi[0] - lo[0]), (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const sigma = 0.12 * diag;
  const f = (x: number, y: number, z: number): number => Math.exp(-((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2) / sigma ** 2);
  const fv = new Float64Array(np);
  for (let i = 0; i < np; i++) fv[i] = f(mesh.points[i * 3], mesh.points[i * 3 + 1], mesh.points[i * 3 + 2]);
  mesh.point_data = { f: fv };
  out.source = { points: np, diag, centre: c, sigma, cellBlocks: mesh.cells.map((b: any) => [b.type, b.data.length / b.nodesPerCell]) };

  // 1. error indicator
  const t0 = Date.now();
  const err = meshio.estimateError(mesh, "f", "zz", "none");
  const indicator = (err.mesh.cell_data!["error:zz"] as any)[0] as Float64Array;
  out.estimate = { ms: Date.now() - t0, globalError: err.globalError, numSkipped: err.numSkipped, min: Math.min(...indicator), max: Math.max(...indicator) };

  // 2. size map: per-vertex min over incident cells of h0/(1+alpha*e/emean)
  const bridge = prepareMmgMesh(mesh);
  const input = bridge.input;
  const srcTets = tets({ positions: input.positions, tet: input.tetrahedra });
  const emean = indicator.reduce((s, v) => s + v, 0) / indicator.length;
  const h0 = 0.3 * diag, alpha = Number(process.env.ALPHA ?? 6);
  const sizeAt = new Float64Array(np).fill(h0);
  srcTets.forEach((t, i) => {
    const h = Math.max(0.02 * diag, h0 / (1 + (alpha * (indicator[i] ?? 0)) / emean));
    for (const v of t.verts) sizeAt[v] = Math.min(sizeAt[v], h);
  });

  const mmg: Mmg = await getMmg(process.cwd());
  const api = mmg.mmg3d as any;
  async function adapt(kind: "scalar" | "tensor") {
    const h = api.init();
    try {
      api.setIparameter(h.mesh, h.met, api.IPARAM_mem, 128);
      api.setIparameter(h.mesh, h.met, api.IPARAM_verbose, -1);
      api.setMeshSize(h.mesh, np, input.tetrahedra.length / 4, 0, input.triangles.length / 3, 0, 0);
      api.setVertices(h.mesh, input.positions, null);
      api.setTetrahedra(h.mesh, input.tetrahedra, input.tetraRefs);
      if (input.triangles.length) api.setTriangles(h.mesh, input.triangles, input.triangleRefs);
      api.setDparameter(h.mesh, h.met, api.DPARAM_hausd, 0.01 * diag);
      if (kind === "scalar") {
        api.setSolSize(h.mesh, h.met, 1 /* MMG5_Vertex */, np, 1 /* MMG5_Scalar */);
        api.setScalarSols(h.met, sizeAt);
      } else {
        api.setSolSize(h.mesh, h.met, 1, np, 3 /* MMG5_Tensor */);
        const sols = new Float64Array(np * 6);
        for (let i = 0; i < np; i++) {
          const x = [input.positions[3 * i] - c[0], input.positions[3 * i + 1] - c[1], input.positions[3 * i + 2] - c[2]];
          const r = Math.hypot(...x) || 1;
          const n = x.map((v) => v / r); // gradient direction of the radial Gaussian
          const hg = sizeAt[i], ht = Math.min(h0, sizeAt[i] * 3); // fine along the gradient, coarser across it
          const lg = 1 / (hg * hg), lt = 1 / (ht * ht);
          // M = lt*I + (lg-lt) n n^T
          sols.set([lt + (lg - lt) * n[0] * n[0], (lg - lt) * n[0] * n[1], (lg - lt) * n[0] * n[2], lt + (lg - lt) * n[1] * n[1], (lg - lt) * n[1] * n[2], lt + (lg - lt) * n[2] * n[2]], 6 * i);
        }
        api.setTensorSols(h.met, sols);
      }
      const t = Date.now();
      const status = api.remesh(h.mesh, h.met);
      const size = api.getMeshSize(h.mesh) as { np: number; nt: number; ne: number };
      const positions = api.getVertices(h.mesh, size.np).vertices.slice() as Float64Array;
      const tet = api.getTetrahedra(h.mesh, size.ne).tetra.slice() as Int32Array;
      return { status, ms: Date.now() - t, np: size.np, ne: size.ne, positions, tet };
    } finally { api.free(h); }
  }

  const near = (t: { centroid: number[] }) => Math.hypot(t.centroid[0] - c[0], t.centroid[1] - c[1], t.centroid[2] - c[2]) < sigma;
  const far = (t: { centroid: number[] }) => Math.hypot(t.centroid[0] - c[0], t.centroid[1] - c[1], t.centroid[2] - c[2]) > 2.5 * sigma;

  const srcDensity = (() => {
    const n = srcTets.filter(near), fr = srcTets.filter(far);
    return { near: n.length / Math.max(1e-12, n.reduce((s, t) => s + t.volume, 0)), far: fr.length / Math.max(1e-12, fr.reduce((s, t) => s + t.volume, 0)) };
  })();
  out.sourceDensity = srcDensity;

  for (const kind of ["scalar", "tensor"] as const) {
    try {
      const r = await adapt(kind);
      const ts = tets({ positions: r.positions, tet: r.tet });
      const n = ts.filter(near), fr = ts.filter(far);
      const dn = n.length / Math.max(1e-12, n.reduce((s, t) => s + t.volume, 0));
      const df = fr.length / Math.max(1e-12, fr.reduce((s, t) => s + t.volume, 0));
      // P1 interpolation error of f on the new mesh: |f(centroid) - mean f(vertices)|
      let sq = 0, vol = 0;
      for (const t of ts) {
        const mean = t.verts.reduce((s, v) => s + f(r.positions[3 * v], r.positions[3 * v + 1], r.positions[3 * v + 2]), 0) / 4;
        const e = f(t.centroid[0], t.centroid[1], t.centroid[2]) - mean;
        sq += e * e * t.volume; vol += t.volume;
      }
      // conservation: transfer f source -> remeshed target
      const target: Mesh = {
        points: Float64Array.from({ length: r.np * 3 }, (_, i) => r.positions[i]), dim: 3,
        cells: [{ type: "tetra", nodesPerCell: 4, data: BigInt64Array.from(r.tet, (v) => BigInt(v - 1)) } as any],
      } as Mesh;
      let conservation: unknown;
      try {
        const tr = meshio.conservativeInterpolate(mesh, target, ["f"]);
        const keys = { point: Object.keys(tr.point_data ?? {}), cell: Object.keys(tr.cell_data ?? {}) };
        const srcSum = (() => { let s = 0; for (const t of srcTets) s += t.volume * (t.verts.reduce((a, v) => a + fv[v], 0) / 4); return s; })();
        let tgtSum = 0;
        if (tr.cell_data?.f) { const arr = (tr.cell_data.f as any)[0] as Float64Array; ts.forEach((t, i) => { tgtSum += t.volume * arr[i]; }); }
        else if (tr.point_data?.f) { const arr = tr.point_data.f as Float64Array; for (const t of ts) tgtSum += t.volume * (t.verts.reduce((a, v) => a + arr[v], 0) / 4); }
        conservation = { keys, srcSum, tgtSum, relError: Math.abs(tgtSum - srcSum) / Math.abs(srcSum) };
      } catch (e) { conservation = { error: String((e as Error).message).slice(0, 200) }; }
      out[kind] = { status: r.status, ms: r.ms, np: r.np, ne: r.ne, densityNear: dn, densityFar: df, ratio: dn / df, rmsInterpError: Math.sqrt(sq / vol), conservation };
    } catch (e) { out[kind] = { error: String((e as Error).message).slice(0, 300) }; }
  }
  console.error("ADAPT " + JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
