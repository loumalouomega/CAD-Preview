/** meshio++ 17.13 probe: `meshCadSurface` (kernel-free conforming surface mesh of a B-rep).
 * Run: npm run probe -- scripts/probe/examples/meshio-meshcad.ts --run   (diagnostics: JSON on stderr)
 * Sources: examples/CadJson/cube.cad.json, block.stp and bull.stp via the full artifact's STEP reader
 * (`readMeshSelective(..., {info: true}).info`). Records closure counts, per-face status, sizes, and the
 * enclosed volume of the resulting triangles (signed divergence sum; a closed outward surface = the B-rep volume).
 */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";

console.log = console.error.bind(console);
const out = (o: unknown): void => { console.error(JSON.stringify(o)); };

function signedVolume(points: ArrayLike<number>, tris: ArrayLike<number | bigint>): number {
  let v = 0;
  for (let i = 0; i + 2 < tris.length; i += 3) {
    const a = Number(tris[i]) * 3, b = Number(tris[i + 1]) * 3, c = Number(tris[i + 2]) * 3;
    v += (points[a] * (points[b + 1] * points[c + 2] - points[b + 2] * points[c + 1])
      - points[a + 1] * (points[b] * points[c + 2] - points[b + 2] * points[c])
      + points[a + 2] * (points[b] * points[c + 1] - points[b + 1] * points[c])) / 6;
  }
  return v;
}

async function main(): Promise<void> {
  const m = await getMeshio();
  const cases: Array<[string, string, string, number | null, number]> = [
    ["cube.cad.json", "examples/CadJson/cube.cad.json", "cad_json", 1000, 2],
    ["block.stp", "examples/STP/block.stp", "step", 60, 0.5],
    ["bull.stp", "examples/STP/bull.stp", "step", null, 5],
  ];
  for (const [name, file, format, known, targetSize] of cases) {
    try {
      const ext = file.endsWith(".json") ? ".cad.json" : ".stp";
      m.FS.writeFile("/mc" + ext, fs.readFileSync(file));
      const sel: any = m.readMeshSelective("/mc" + ext, { format, info: true });
      const info = sel.info;
      const t0 = Date.now();
      const r: any = m.meshCadSurface(info, { targetSize });
      const tris = (r.mesh.cells as any[]).filter((b) => b.type === "triangle");
      const vol = tris.reduce((a, b) => a + signedVolume(r.mesh.points, b.data), 0);
      const { mesh, faces, ...facts } = r;
      out({
        name, ms: Date.now() - t0, targetSize, knownVolume: known, signedVolume: vol,
        blocks: (r.mesh.cells as any[]).map((b) => [b.type, b.data.length]),
        cellData: Object.keys(r.mesh.cell_data ?? {}),
        faceStatus: faces.reduce((acc: Record<string, number>, f: any) => ((acc[f.status] = (acc[f.status] ?? 0) + 1), acc), {}),
        ...facts,
      });
    } catch (e) { out({ name, error: String((e as Error).message).slice(0, 400) }); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
