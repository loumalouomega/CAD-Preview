/** Roadmap "KaHIP partitioning for Kratos MPI export" -- end-to-end probe of `exportMdpaPartitioned`.
 * Run: npm run probe -- scripts/probe/examples/mdpa-partition.ts --run   (diagnostics: JSON on stderr)
 *
 * block.stp and bull.stp are meshed with Gmsh, their domain cells labelled by meshio++ (KaHIP and SFC) for
 * 2/4/8 ranks, and every rank file is checked against the unpartitioned export of the SAME mesh: each element
 * id appears in exactly one file, the id set equals the serial one, the node union is the serial node set,
 * and a node shared by two files carries the same coordinates in both.
 */
import * as fs from "fs";
import { exportMdpa, exportMdpaPartitioned } from "../../../src/gmshService";
import { DEFAULT_MESH_OPTIONS, type MeshOptions } from "../../../src/meshOptions";

console.log = console.error.bind(console);
const out = (o: unknown): void => { console.error(JSON.stringify(o)); };

const blockIds = (text: string, header: string): number[] => {
  const ids: number[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (line.startsWith(`Begin ${header}`)) { inside = true; continue; }
    if (inside && line.startsWith("End ")) { inside = false; continue; }
    if (inside && line.trim()) ids.push(Number(line.trim().split(/\s+/)[0]));
  }
  return ids;
};
const nodeLines = (text: string): Map<number, string> => {
  const m = new Map<number, string>();
  let inside = false;
  for (const line of text.split("\n")) {
    if (line === "Begin Nodes") { inside = true; continue; }
    if (line === "End Nodes") break;
    if (inside) m.set(Number(line.split(" ")[0]), line);
  }
  return m;
};

async function main(): Promise<void> {
  const ext = process.cwd();
  const cases: Array<[string, Uint8Array, number]> = [
    ["block", fs.readFileSync("examples/STP/block.stp"), 1],
    ["bull", fs.readFileSync("examples/STP/bull.stp"), 8],
  ];
  for (const [name, stepBytes, sizeMax] of cases) {
    const input = { kind: "brep" as const, stepBytes };
    const base: MeshOptions = { ...DEFAULT_MESH_OPTIONS, sizeMin: 0, sizeMax };
    const serial = await exportMdpa(ext, input, base, [], "elements");
    const serialElements = blockIds(serial, "Elements").sort((a, b) => a - b);
    const serialNodes = nodeLines(serial);
    out({ case: name, serialElements: serialElements.length, serialNodes: serialNodes.size });
    for (const method of ["kahip", "sfc"] as const) {
      for (const ranks of [2, 4, 8]) {
        const row: Record<string, unknown> = { case: name, method, ranks };
        try {
          const t0 = Date.now();
          const { files, report } = await exportMdpaPartitioned(ext, input, { ...base, mdpaRanks: ranks, mdpaPartitionMethod: method }, [], "elements", name);
          row.ms = Date.now() - t0;
          const all = files.flatMap((f) => blockIds(f.text, "Elements")).sort((a, b) => a - b);
          row.everyCellOnce = all.length === serialElements.length && all.every((id, i) => id === serialElements[i]);
          const union = new Map<number, string>();
          let coordMismatch = 0;
          for (const f of files) for (const [id, line] of nodeLines(f.text)) {
            if (union.has(id) && union.get(id) !== line) coordMismatch++;
            union.set(id, line);
          }
          row.nodeUnionIsSerial = union.size === serialNodes.size && [...union].every(([id, l]) => serialNodes.get(id) === l);
          row.coordMismatch = coordMismatch;
          row.report = { methodUsed: report.methodUsed, balance: report.balanceMaxOverMean, empty: report.emptyRanks, interfaceNodes: report.interfaceNodes, interfaceFraction: report.interfaceFraction, orphans: report.orphanSurfaceCells, perRank: report.perRank.map((p) => [p.volumeCells, p.surfaceCells, p.nodes, p.interfaceNodes]) };
        } catch (e) { row.error = String((e as Error).message).slice(0, 300); }
        out(row);
      }
    }
  }
  // Refusal decided from the options alone (more ranks than cells is unit-tested: a tiny mesh is not reachable here).
  const input = { kind: "brep" as const, stepBytes: fs.readFileSync("examples/STP/block.stp") };
  for (const [label, opts] of [
    ["hanging", { engine: "octree" as const, octreeTransition: "hanging" as const, mdpaRanks: 2 }],
  ] as Array<[string, Partial<MeshOptions>]>) {
    try { await exportMdpaPartitioned(ext, input, { ...DEFAULT_MESH_OPTIONS, sizeMin: 0, ...opts }, [], "elements", "x"); out({ refusal: label, threw: false }); }
    catch (e) { out({ refusal: label, threw: String((e as Error).message).slice(0, 160) }); }
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
