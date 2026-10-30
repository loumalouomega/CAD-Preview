/** meshio++ 17.21 probe: `meshCadSurface` options added in 17.14–17.20 and the engine seam they feed.
 * Run: npm run probe -- scripts/probe/examples/meshio-meshcad-1721.ts --run   (diagnostics: JSON on stderr)
 * Exit 0 means the probe completed, not that the gate passed.
 *
 * Records, on block.stp (volume 60, area 94) and bull.stp (declares INCH):
 *  1. units — the surface extent vs the host-OCCT skin extent;
 *  2. every new option's effect (counts, min angle, histogram);
 *  3. triangle6 / triangle10 node order on PLANAR faces (block.stp: edge nodes must sit on the
 *     straight edge in Gmsh's order, so a hand-written MSH needs no permutation);
 *  4. what meshio++'s own gmsh writer emits (header, $Entities) next to a hand-written single-entity MSH 4.1,
 *     and whether Gmsh merges each (entities, element types, readable elements).
 */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";
import { getGmsh } from "../../../src/gmshService";
import { brepSkinStlBytes } from "../../../src/octreeService";

console.log = console.error.bind(console);
const out = (o: unknown): void => { console.error(JSON.stringify(o)); };

function bbox(points: ArrayLike<number>): number[] {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < points.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], points[i + k]); hi[k] = Math.max(hi[k], points[i + k]); }
  return [...lo, ...hi].map((v) => +v.toFixed(4));
}
function area(points: ArrayLike<number>, tris: ArrayLike<number | bigint>): number {
  let a = 0;
  for (let i = 0; i + 2 < tris.length; i += 3) {
    const p = (j: number) => [points[Number(tris[i + j]) * 3], points[Number(tris[i + j]) * 3 + 1], points[Number(tris[i + j]) * 3 + 2]];
    const A = p(0), B = p(1), C = p(2);
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    a += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return a;
}

async function main(): Promise<void> {
  const m = await getMeshio();
  const ext = process.cwd();
  for (const [name, file, size] of [["block.stp", "examples/STP/block.stp", 1], ["bull.stp", "examples/STP/bull.stp", 3]] as const) {
    const bytes = fs.readFileSync(file);
    m.FS.writeFile("/mc.stp", bytes);
    const info: any = (m.readMeshSelective("/mc.stp", { format: "step", info: true }) as any).info;
    const run = (o: Record<string, unknown>) => m.meshCadSurface(info, { edges: false, targetSize: size, ...o }) as any;

    // 1. units
    const base = run({});
    m.FS.writeFile("/sk.stl", await brepSkinStlBytes(ext, new Uint8Array(bytes)));
    const skin = m.readMesh("/sk.stl", "stl") as any;
    out({ name, step: "units", meshcadBbox: bbox(base.mesh.points), occtSkinBbox: bbox(skin.points) });

    // 2. option effects
    const cases: Array<[string, Record<string, unknown>]> = [
      ["base", {}], ["minAngle25", { minAngle: 25 }], ["minAngle25+lop", { minAngle: 25, lopCorners: true }],
      ["minAngle25+odt3", { minAngle: 25, smoothIterations: 3, smoothMethod: "odt" }],
      ["curvDev", { targetSize: size * 3, curvatureDeviation: size * 0.05, grading: 1.3 }],
      ["gaps2", { targetSize: size * 3, cellsAcrossGaps: 2 }], ["poleRings2", { poleRings: 2 }],
      ["face0", { faceSizes: { 0: size / 3 } }], ["edge0", { edgeSizes: { 0: size / 3 } }],
      ["varying", { metric: "varying" }], ["virtual", { virtualEdges: true, virtualFaces: true, modelTolerances: true }],
      ["reparam", { reparamConditionNumber: 5 }],
    ];
    for (const [label, o] of cases) {
      const t = Date.now();
      try {
        const r = run(o);
        out({ name, label, ms: Date.now() - t, pts: r.numPoints, tri: r.numTriangles, open: r.numOpenEdges, failed: r.numFailed,
          minA: +r.minAngleDeg.toFixed(2), refine: r.numRefinementPoints, below: r.numFacesBelowBound, smoothed: r.numSmoothed,
          hist: r.angleHistogram, virtualEdges: r.virtualEdges.length, reparam: r.reparametrised.length, merged: r.mergedFaces.length,
          tol: r.toleranceUses.length, lopped: r.loppedCorners.length, warnings: r.warnings });
      } catch (e) { out({ name, label, error: String((e as Error).message).slice(0, 200) }); }
    }

    // 3. node order of curved elements on planar faces (block.stp)
    for (const order of [2, 3]) {
      const r = run({ order });
      const pts = r.mesh.points as ArrayLike<number>;
      const blk = r.mesh.cells.find((b: any) => b.type === (order === 2 ? "triangle6" : "triangle10"));
      const n = order === 2 ? 6 : 10;
      const P = (i: number) => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
      let worst = 0, cells = Math.floor(blk.data.length / n);
      const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      // distance of node q from the point at fraction t of the straight segment a->b
      const dev = (q: number[], a: number[], b: number[], t: number) => dist(q, a.map((v, k) => v + (b[k] - v) * t));
      if (name === "block.stp") {
        for (let c = 0; c < cells; c++) {
          const id = (j: number) => P(Number(blk.data[c * n + j]));
          const v0 = id(0), v1 = id(1), v2 = id(2);
          if (order === 2) worst = Math.max(worst, dev(id(3), v0, v1, 0.5), dev(id(4), v1, v2, 0.5), dev(id(5), v2, v0, 0.5));
          else worst = Math.max(worst,
            dev(id(3), v0, v1, 1 / 3), dev(id(4), v0, v1, 2 / 3), dev(id(5), v1, v2, 1 / 3), dev(id(6), v1, v2, 2 / 3),
            dev(id(7), v2, v0, 1 / 3), dev(id(8), v2, v0, 2 / 3),
            dist(id(9), v0.map((v, k) => (v + v1[k] + v2[k]) / 3)));
        }
      }
      out({ name, step: "nodeOrder", order, type: blk.type, cells, worstDeviationFromGmshOrder: name === "block.stp" ? worst : "n/a (curved faces)" });
    }
  }

  // 4. merge seam on block.stp order 2
  m.FS.writeFile("/mc.stp", fs.readFileSync("examples/STP/block.stp"));
  const info: any = (m.readMeshSelective("/mc.stp", { format: "step", info: true }) as any).info;
  const gmsh: any = await getGmsh(ext);
  for (const order of [1, 2, 3]) {
    const r: any = m.meshCadSurface(info, { targetSize: 1, edges: false, order });
    m.writeMesh("/mc.msh", r.mesh, "gmsh");
    const text = new TextDecoder().decode(m.FS.readFile("/mc.msh"));
    const head = text.split("\n").slice(0, 8).join("|");
    const hasEntities = text.includes("$Entities");
    gmsh.clear(); gmsh.model.add("m" + order);
    gmsh.FS.writeFile("/i.msh", text);
    let merged: unknown;
    try {
      gmsh.merge("/i.msh");
      const ents = [2, 3].map((d) => gmsh.model.getEntities(d).length);
      const types = new Set<number>();
      for (const [d, t] of gmsh.model.getEntities(2)) { const e = gmsh.model.mesh.getElements(d, t); for (const x of e.elementTypes ?? e[0] ?? []) types.add(x); }
      merged = { entitiesDim2and3: ents, elementTypes: [...types] };
    } catch (e) { merged = { error: String((e as Error).message).slice(0, 200) }; }
    out({ step: "meshioGmshWriter", order, bytes: text.length, hasEntities, head, merged });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
