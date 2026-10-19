/** Probe: meshio++'s `nastran_op2` writer/reader (17.4.0 PR #164, extended 17.5.0 PR #165). NOT a product API.
 * Run: npm run probe -- scripts/probe/examples/op2-writer.ts --run   (diagnostics: JSON on stderr)
 *
 * Answers, live against the installed FULL artifact:
 *   1. Writer accepts the two-tets FE-mesh shape (the fixtures' shape class)?
 *   2. Writer accepts this pipeline's real generateMesh()-shaped MSH 4.1
 *      (Mesh.SaveAll vertex/line/triangle/tetra blocks — the bar the 17.3.0
 *      result writers were held to; Gmsh's own tecplot writer failed it)?
 *   3. Reader: does readMesh(.., "nastran_op2") read either back with
 *      cells/points intact — decides whether .op2 gets an import route and
 *      the corpus reload row, or is export-only.
 */
import { getGmsh } from "../../../src/gmshService";
import { getMeshio } from "../../../src/meshioService";
import { kernelVersions } from "../../../src/kernelVersions";

console.log = console.error.bind(console);
const out = (o: unknown): void => { console.error(JSON.stringify(o)); };

const twoTets = {
  points: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]),
  dim: 3,
  cells: [
    { type: "tetra", data: new Int32Array([0, 1, 2, 3]), nodesPerCell: 4 },
    { type: "tetra", data: new Int32Array([1, 2, 3, 4]), nodesPerCell: 4 },
  ],
};

const blocks = (mesh: unknown): unknown =>
  (mesh as { cells: { type: string; data: { length: number } }[] }).cells.map((b) => [b.type, b.data.length]);

async function main(): Promise<void> {
  out({ versions: kernelVersions() });
  const m = await getMeshio();

  // (1) + (3) the two-tets shape, written then read back.
  const twoRow: Record<string, unknown> = {};
  try {
    m.writeMesh("/tt.op2", twoTets, "nastran_op2");
    const bytes = m.FS.readFile("/tt.op2") as Uint8Array;
    twoRow.writeBytes = bytes.length;
    try {
      const back = m.readMesh("/tt.op2", "nastran_op2");
      twoRow.readBack = { points: (back.points as Float64Array).length / 3, cells: blocks(back),
        pointData: Object.keys(back.point_data ?? {}), cellData: Object.keys(back.cell_data ?? {}) };
    } catch (e) { twoRow.readError = String((e as Error).message).slice(0, 300); }
  } catch (e) { twoRow.writeError = String((e as Error).message).slice(0, 300); }
  try { m.FS.unlink("/tt.op2"); } catch { /* already gone */ }
  out({ twoTets: twoRow });

  // (2) the real pipeline shape: a Gmsh-tetrahedralized box, Mesh.SaveAll on.
  const gmsh: any = await getGmsh(process.cwd());
  gmsh.clear();
  gmsh.model.add("box");
  gmsh.model.occ.addBox(0, 0, 0, 1, 1, 1);
  gmsh.model.occ.synchronize();
  gmsh.option.setNumber("Mesh.SaveAll", 1);
  gmsh.option.setNumber("Mesh.MeshSizeMax", 0.5);
  for (const k of ["General.NumThreads", "Mesh.MaxNumThreads1D", "Mesh.MaxNumThreads2D", "Mesh.MaxNumThreads3D"]) gmsh.option.setNumber(k, 1);
  gmsh.model.mesh.generate(3);
  gmsh.option.setNumber("Mesh.MshFileVersion", 4.1);
  gmsh.write("/b.msh");
  const msh = gmsh.FS.readFile("/b.msh") as Uint8Array;
  gmsh.FS.unlink("/b.msh");

  m.FS.writeFile("/b.msh", msh);
  const pipelineMesh = m.readMesh("/b.msh", "gmsh");
  m.FS.unlink("/b.msh");
  out({ pipelineBlocks: blocks(pipelineMesh) });

  const boxRow: Record<string, unknown> = {};
  try {
    m.writeMesh("/b.op2", pipelineMesh, "nastran_op2");
    const bytes = m.FS.readFile("/b.op2") as Uint8Array;
    boxRow.writeBytes = bytes.length;
    try {
      const back = m.readMesh("/b.op2", "nastran_op2");
      boxRow.readBack = { points: (back.points as Float64Array).length / 3, cells: blocks(back),
        pointData: Object.keys(back.point_data ?? {}), cellData: Object.keys(back.cell_data ?? {}) };
    } catch (e) { boxRow.readError = String((e as Error).message).slice(0, 300); }
  } catch (e) { boxRow.writeError = String((e as Error).message).slice(0, 300); }
  try { m.FS.unlink("/b.op2"); } catch { /* already gone */ }
  out({ pipelineBox: boxRow });
}

main().catch((e) => { console.error(e); process.exit(1); });
