/** Roadmap 4.18 probe: all-hexahedra octree with hanging nodes + MPCs.
 * Run: npm run probe -- scripts/probe/examples/meshio-octree-hanging.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that the gate passed.
 *
 * 1. Skin of block.stp / bull.stp (host OCCT, `fine`) → meshio++ `octree` with
 *    `transition: "hanging"`, snap off and on: which cell blocks come back, is
 *    `octree:hanging` present, `numHanging`.
 * 2. Recover the constraints geometrically (`findHangingConstraints`): does the
 *    geometric count equal `numHanging`, how many chains, and the patch test
 *    (a linear field on the masters reproduced at every slave).
 * 3. meshio++ `mdpa` with a Constraints block: `readMesh` vs `readMeshSelective
 *    ({lenient, info})`, and whether the raw block survives a write.
 */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";
import { brepSkinStlBytes } from "../../../src/octreeService";
import { findHangingConstraints, patchTestMaxError, type MpcNode } from "../../../src/hangingConstraints";
import { kernelVersions } from "../../../src/kernelVersions";

console.log = console.error.bind(console);

async function octreeCase(name: string, stl: Uint8Array, maxLevel: number, snap: boolean): Promise<Record<string, unknown>> {
  const m = await getMeshio();
  const path = "/oh.stl";
  m.FS.writeFile(path, stl);
  const row: Record<string, unknown> = { name, maxLevel, snap };
  try {
    const skin = m.readMesh(path, "stl");
    const t0 = Date.now();
    const r = m.octree(skin, null, 0, maxLevel, null, undefined, undefined, 3, undefined, "face", "inside", undefined, undefined, undefined, undefined, undefined, "hanging", snap);
    row.ms = Date.now() - t0;
    row.numLeaves = r.numLeaves;
    row.numHanging = r.numHanging;
    row.numSnapped = r.numSnapped;
    row.numRefused = r.numRefused;
    row.blocks = (r.mesh.cells as Array<{ type: string; data: ArrayLike<number> }>).map((b) => ({ type: b.type, count: b.data.length }));
    row.pointData = Object.keys((r.mesh as { point_data?: Record<string, unknown> }).point_data ?? {});
    const pts = r.mesh.points as ArrayLike<number>;
    const nodes: MpcNode[] = [];
    for (let i = 0; i < pts.length / 3; i++) nodes.push({ tag: i + 1, x: pts[i * 3], y: pts[i * 3 + 1], z: pts[i * 3 + 2] });
    const hexBlock = (r.mesh.cells as Array<{ type: string; data: ArrayLike<number | bigint> }>).find((b) => b.type === "hexahedron");
    const hexes: number[][] = [];
    if (hexBlock) {
      for (let c = 0; c < hexBlock.data.length / 8; c++) hexes.push(Array.from({ length: 8 }, (_, j) => Number(hexBlock.data[c * 8 + j]) + 1));
    }
    const t1 = Date.now();
    const found = findHangingConstraints(nodes, hexes);
    row.findMs = Date.now() - t1;
    row.geometricHanging = found.constraints.length;
    row.chained = found.chained;
    row.countsMatch = found.constraints.length === r.numHanging;
    row.masterCounts = found.constraints.reduce<Record<string, number>>((a, c) => ({ ...a, [c.masters.length]: (a[c.masters.length] ?? 0) + 1 }), {});
    row.patchTestMaxError = patchTestMaxError(found.constraints, nodes);
    const flag = (r.mesh as { point_data?: Record<string, ArrayLike<number | bigint>> }).point_data?.["octree:hanging"];
    if (flag) {
      const flagged = new Set<number>();
      for (let i = 0; i < flag.length; i++) if (Number(flag[i]) !== 0) flagged.add(i + 1);
      row.flaggedByKernel = flagged.size;
      row.flagSetEqualsGeometric = flagged.size === found.constraints.length && found.constraints.every((c) => flagged.has(c.slave));
    }
  } catch (e) {
    row.error = String((e as Error)?.message ?? e).slice(0, 400);
  } finally {
    try { m.FS.unlink(path); } catch { /* ignore */ }
  }
  return row;
}

const MDPA_WITH_CONSTRAINT = `Begin Properties 0
End Properties

Begin Nodes
1 0 0 0
2 1 0 0
3 0.5 0 0
4 0 1 0
End Nodes

Begin Elements Element2D3N
1 0 1 2 4
End Elements

Begin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X DISPLACEMENT_X DISPLACEMENT_X
1 0.0 [0.5, 0.5] 3 1 2
End Constraints
`;

async function mdpaCase(): Promise<Record<string, unknown>> {
  const m = await getMeshio();
  const row: Record<string, unknown> = {};
  const path = "/c.mdpa";
  m.FS.writeFile(path, MDPA_WITH_CONSTRAINT);
  try {
    try { m.readMesh(path, "mdpa"); row.readMesh = "ok"; } catch (e) { row.readMesh = `throws: ${String((e as Error).message).slice(0, 160)}`; }
    try {
      const sel = m.readMeshSelective(path, { format: "mdpa", lenient: true, info: true }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      row.readMeshSelective = {
        keys: Object.keys(sel),
        rawBlocks: sel.info?.rawBlocks?.map((b: { header: string }) => b.header),
        skipped: sel.info?.skippedConstructs,
        cells: sel.cells?.map((c: { type: string }) => c.type),
      };
      try {
        m.writeMesh(sel as never, "/w.mdpa", "mdpa");
        const text = m.FS.readFile("/w.mdpa", { encoding: "utf8" }) as string;
        row.writeKeepsConstraints = /Begin Constraints/.test(text);
        m.FS.unlink("/w.mdpa");
      } catch (e) { row.write = `throws: ${String((e as Error).message).slice(0, 160)}`; }
    } catch (e) { row.readMeshSelective = `throws: ${String((e as Error).message).slice(0, 160)}`; }
  } finally {
    try { m.FS.unlink(path); } catch { /* ignore */ }
  }
  return row;
}

async function main(): Promise<void> {
  const out: Record<string, unknown> = { versions: kernelVersions() };
  const ext = process.cwd();
  for (const [name, file, levels] of [["block", "examples/STP/block.stp", [4]], ["bull", "examples/STP/bull.stp", [4, 5, 6]]] as const) {
    const stl = await brepSkinStlBytes(ext, fs.readFileSync(file));
    for (const level of levels) {
      for (const snap of [false, true]) out[`${name}-L${level}-snap${snap ? "On" : "Off"}`] = await octreeCase(name, stl, level, snap);
    }
  }
  out.mdpa = await mdpaCase();
  console.error(JSON.stringify(out, null, 2));
}

main().then(() => process.exit(0), () => process.exit(0));
