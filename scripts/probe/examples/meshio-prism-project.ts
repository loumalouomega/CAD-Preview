/** meshio++ 17.23 probe: `projectToCad` and 3-D `boundaryLayer` (prism layers).
 * Run: npm run probe -- scripts/probe/examples/meshio-prism-project.ts --run   (JSON on stderr)
 */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";
import { getGmsh } from "../../../src/gmshService";

console.log = console.error.bind(console);
const out = (o: unknown): void => { console.error(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? Number(v) : v))); };
const trunc = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 240);
const counts = (mesh: any): Record<string, number> => { const c: Record<string, number> = {}; for (const b of mesh.cells) c[b.type] = (c[b.type] ?? 0) + Math.floor(b.data.length / (b.nodesPerCell ?? 1)); return c; };
const names = (mesh: any) => ({ cell: Object.keys(mesh.cell_data ?? mesh.cellData ?? {}), point: Object.keys(mesh.point_data ?? mesh.pointData ?? {}) });

function wedgeVolumes(pts: ArrayLike<number>, data: ArrayLike<number | bigint>): { total: number; neg: number; n: number } {
  // signed volume of each wedge as 3 tets (Gmsh prism node order: bottom 0,1,2 top 3,4,5)
  const P = (i: number) => [pts[Number(i) * 3], pts[Number(i) * 3 + 1], pts[Number(i) * 3 + 2]];
  const det = (a: number[], b: number[], c: number[], d: number[]) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    return (u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0])) / 6;
  };
  let total = 0, neg = 0, n = 0;
  for (let i = 0; i + 5 < data.length; i += 6) {
    const p = [0, 1, 2, 3, 4, 5].map((k) => P(data[i + k] as number));
    const v = det(p[0], p[1], p[2], p[3]) + det(p[1], p[2], p[3], p[4]) + det(p[2], p[3], p[4], p[5]);
    total += v; n++; if (v <= 0) neg++;
  }
  return { total: +total.toFixed(6), neg, n };
}

async function main(): Promise<void> {
  const m: any = await getMeshio();
  for (const [name, file, size] of [["block", "examples/STP/block.stp", 1], ["bull", "examples/STP/bull.stp", 3]] as const) {
    m.FS.writeFile("/mc.stp", fs.readFileSync(file));
    const info: any = (m.readMeshSelective("/mc.stp", { format: "step", info: true }) as any).info;
    const surf: any = m.meshCadSurface(info, { targetSize: size, edges: true });
    out({ name, step: "surface", cells: counts(surf.mesh), arrays: names(surf.mesh) });

    // ---- projectToCad
    const perturb = (mesh: any, amp: number) => ({ ...mesh, points: Float64Array.from(mesh.points, (v: number, i: number) => v + (((i * 2654435761) >>> 0) % 1000 / 1000 - 0.5) * amp) });
    for (const [label, mesh, opts] of [
      ["control", surf.mesh, {}], ["noisy", perturb(surf.mesh, size * 0.02), {}], ["noisy-maxDist", perturb(surf.mesh, size * 0.2), { maxDistance: size * 0.05 }],
    ] as const) {
      try {
        const r = m.projectToCad(mesh, info, opts);
        out({ name, label, projected: r.numProjected, onEdges: r.numOnEdges, onCurves: r.numOnCurves, corners: r.numCorners, ambiguous: r.numAmbiguous, tooFar: r.numTooFar, failed: r.numFailed, outsideTrim: r.numOutsideTrim, maxMove: r.maxMove, cells: counts(r.mesh), warnings: r.warnings });
      } catch (e) { out({ name, label, error: trunc(e) }); }
    }
    // order-2 input
    try {
      const s2: any = m.meshCadSurface(info, { targetSize: size, edges: false, order: 2 });
      const r = m.projectToCad(perturb(s2.mesh, size * 0.02), info, {});
      out({ name, label: "order2", projected: r.numProjected, failed: r.numFailed, maxMove: r.maxMove, cells: counts(r.mesh) });
    } catch (e) { out({ name, label: "order2", error: trunc(e) }); }
    // file round trip keeps cad:face?
    try {
      m.writeMesh("/rt.vtu", surf.mesh, "vtu");
      const back: any = m.readMesh("/rt.vtu", "vtu");
      out({ name, label: "vtu-roundtrip", arrays: names(back) });
      const r = m.projectToCad(perturb(back, size * 0.02), info, {});
      out({ name, label: "vtu-project", projected: r.numProjected, onEdges: r.numOnEdges, failed: r.numFailed });
    } catch (e) { out({ name, label: "vtu-roundtrip", error: trunc(e) }); }
    // no cad:face
    try { m.projectToCad(m.meshCadSurface(info, { targetSize: size, edges: false }).mesh && { ...surf.mesh, cell_data: {}, cellData: {} }, info, {}); out({ name, label: "noarray", ok: true }); } catch (e) { out({ name, label: "noarray", error: trunc(e) }); }

    // ---- boundaryLayer
    const skin: any = m.meshCadSurface(info, { targetSize: size, edges: false }).mesh;
    for (const [label, o] of [
      ["default", { firstHeight: size * 0.05, numLayers: 3 }], ["growth1.5", { firstHeight: size * 0.05, numLayers: 4, growth: 1.5 }],
      ["reverse", { firstHeight: size * 0.05, numLayers: 3, reverse: true }], ["collapseLayers", { firstHeight: size * 0.1, numLayers: 4, collapse: "layers" }],
      ["thick", { firstHeight: size * 0.6, numLayers: 3 }],
    ] as const) {
      try {
        const r = m.boundaryLayer(skin, o);
        const wb = r.mesh.cells.find((b: any) => b.type === "wedge");
        out({ name, label, cells: counts(r.mesh), blocks: r.mesh.cells.map((b: any) => b.type), wedge: wb ? wedgeVolumes(r.mesh.points, wb.data) : null, shrunk: r.numShrunk, collapsed: r.numCollapsed, fewer: r.numFewerLayers, crossings: r.numFrontCrossings, minSJ: r.minScaledJacobian, thick: [r.minThickness, r.maxThickness], capClosed: r.capClosed, warnings: r.warnings });
      } catch (e) { out({ name, label, error: trunc(e) }); }
    }
    // expected total thickness for the default: firstHeight*(g^n-1)/(g-1) with g=1.2
    out({ name, label: "expectedThickness", value: size * 0.05 * ((1.2 ** 3 - 1) / 0.2) });

    // ---- merge into Gmsh as a single volume entity: skin triangles + wedges
    if (name === "block") {
      const r = m.boundaryLayer(skin, { firstHeight: size * 0.05, numLayers: 3 });
      const pts = r.mesh.points as ArrayLike<number>;
      const nn = pts.length / 3;
      const tri = r.mesh.cells.filter((b: any) => b.type === "triangle");
      out({ label: "triangle-blocks", sizes: tri.map((b: any) => b.data.length / 3), numPoints: nn });
      const wedge = r.mesh.cells.find((b: any) => b.type === "wedge");
      const lines: string[] = ["$MeshFormat", "4.1 0 8", "$EndMeshFormat", "$Nodes", `1 ${nn} 1 ${nn}`, `3 1 0 ${nn}`];
      for (let i = 1; i <= nn; i++) lines.push(String(i));
      for (let i = 0; i < nn; i++) lines.push(`${pts[i * 3]} ${pts[i * 3 + 1]} ${pts[i * 3 + 2]}`);
      lines.push("$EndNodes", "$Elements", `1 ${wedge.data.length / 6} 1 ${wedge.data.length / 6}`, `3 1 6 ${wedge.data.length / 6}`);
      let id = 1;
      for (let i = 0; i < wedge.data.length; i += 6) { const c = [0, 1, 2, 3, 4, 5].map((k) => Number(wedge.data[i + k]) + 1); lines.push(`${id++} ${c.join(" ")}`); }
      lines.push("$EndElements");
      const gmsh: any = await getGmsh();
      gmsh.clear(); gmsh.model.add("w");
      gmsh.FS?.writeFile?.("/w.msh", lines.join("\n"));
      try { gmsh.merge("/w.msh"); out({ label: "gmsh-merge", types: gmsh.model.mesh.getElementTypes(3), n: gmsh.model.mesh.getElements(3)[1]?.[0]?.length }); } catch (e) { out({ label: "gmsh-merge", error: trunc(e) }); }
    }
  }
}
main().catch((e) => out({ fatal: trunc(e) })).finally(() => process.exit(0));
